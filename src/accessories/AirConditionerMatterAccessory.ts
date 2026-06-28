import type {
  MatterAccessory,
  MatterAPI,
  MatterClusterHandlers,
  // eslint-disable-next-line indent
} from 'homebridge' with { 'resolution-mode': 'import' };
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DreoPlatform } from '../platform';
import {
  AirConditionerAccessory,
  type AirConditionerStateSnapshot,
} from './AirConditionerAccessory';

export const MATTER_ENDPOINTS = {
  CLIMATE: 'climate',
  DRY: 'dry',
  FAN_ONLY: 'fan-only',
  FAN_SPEED: 'fan-speed',
  AUTO_FAN: 'auto-fan',
  HUMIDITY: 'humidity',
  SWING: 'swing',
  DISPLAY: 'display',
  SLEEP: 'sleep',
  ECO: 'eco',
} as const;

type MatterEndpointId = typeof MATTER_ENDPOINTS[keyof typeof MATTER_ENDPOINTS];

interface MatterStateUpdate {
  uuid: string;
  cluster: string;
  attributes: Record<string, unknown>;
}

interface DreoMatterContext {
  experimental: true;
  endpoint: MatterEndpointId;
}

interface MatterRuntime {
  FanControlServer: typeof import('@matter/main/behaviors/fan-control').FanControlServer;
  ThermostatServer: typeof import('@matter/main/behaviors/thermostat').ThermostatServer;
  FanDevice: typeof import('@matter/main/devices/fan').FanDevice;
  RoomAirConditionerDevice:
    typeof import('@matter/main/devices/room-air-conditioner').RoomAirConditionerDevice;
}

let homebridgeMatterRuntime: Promise<MatterRuntime> | undefined;
const pluginRequire = createRequire(__filename);

/**
 * Load the exact Matter.js module instance owned by Homebridge.
 *
 * Endpoint and behavior classes are identity-sensitive. Loading a second copy
 * from the plugin would produce valid Matter classes that Homebridge still
 * rejects as foreign Behavior.Type objects.
 */
async function loadHomebridgeMatterRuntime(): Promise<MatterRuntime> {
  if (homebridgeMatterRuntime) {
    return homebridgeMatterRuntime;
  }

  const homebridgeRequire = createRequire(pluginRequire.resolve('homebridge'));
  const importFromHomebridge = async (subpath: string): Promise<Record<string, any>> => {
    const cjsPath = homebridgeRequire.resolve(`@matter/main/${subpath}`);
    const cjsMarker = `${sep}dist${sep}cjs${sep}`;
    if (!cjsPath.includes(cjsMarker)) {
      throw new Error(`Unexpected Homebridge Matter.js path: ${cjsPath}`);
    }
    const esmPath = cjsPath.replace(cjsMarker, `${sep}dist${sep}esm${sep}`);
    return import(pathToFileURL(esmPath).href);
  };

  homebridgeMatterRuntime = Promise.all([
    importFromHomebridge('behaviors/fan-control'),
    importFromHomebridge('behaviors/thermostat'),
    importFromHomebridge('devices/fan'),
    importFromHomebridge('devices/room-air-conditioner'),
  ]).then(([fanBehavior, thermostatBehavior, fanDevice, roomAirConditionerDevice]) => ({
    FanControlServer: fanBehavior.FanControlServer,
    ThermostatServer: thermostatBehavior.ThermostatServer,
    FanDevice: fanDevice.FanDevice,
    RoomAirConditionerDevice: roomAirConditionerDevice.RoomAirConditionerDevice,
  } as MatterRuntime));

  return homebridgeMatterRuntime;
}

function loadTestMatterRuntime(): MatterRuntime {
  return {
    FanControlServer: pluginRequire('@matter/main/behaviors/fan-control').FanControlServer,
    ThermostatServer: pluginRequire('@matter/main/behaviors/thermostat').ThermostatServer,
    FanDevice: pluginRequire('@matter/main/devices/fan').FanDevice,
    RoomAirConditionerDevice:
      pluginRequire('@matter/main/devices/room-air-conditioner').RoomAirConditionerDevice,
  };
}

/**
 * Experimental Matter representation for a Dreo portable air conditioner.
 *
 * Every user-facing control is registered as a separately named bridged
 * accessory. Apple Home ignores names on composed child endpoints, so this is
 * the only layout that preserves the control names. HAP remains unchanged.
 */
export class AirConditionerMatterAccessory {
  readonly definition: MatterAccessory<DreoMatterContext>;
  readonly definitions: MatterAccessory<DreoMatterContext>[];

  private readonly matter: MatterAPI;
  private readonly endpointUUIDs = new Map<MatterEndpointId, string>();
  private readonly lastPublished = new Map<string, string>();
  private syncQueue: Promise<void> = Promise.resolve();
  private suppressExternalSync = 0;
  private suppressMatterStateHandlers = 0;
  private unsubscribeState?: () => void;

  static async create(
    platform: DreoPlatform,
    controller: AirConditionerAccessory,
    device: Record<string, any>,
  ): Promise<AirConditionerMatterAccessory> {
    return new AirConditionerMatterAccessory(
      platform,
      controller,
      device,
      await loadHomebridgeMatterRuntime(),
    );
  }

  constructor(
    private readonly platform: DreoPlatform,
    private readonly controller: AirConditionerAccessory,
    device: Record<string, any>,
    private readonly matterRuntime: MatterRuntime = loadTestMatterRuntime(),
  ) {
    const matter = platform.api.matter;
    if (!matter) {
      throw new Error('Matter API is not available on the Dreo bridge');
    }

    this.matter = matter;
    for (const endpoint of Object.values(MATTER_ENDPOINTS)) {
      const seed = endpoint === MATTER_ENDPOINTS.CLIMATE
        // Use a fresh identity when changing the Matter device type so Apple
        // cannot retain the previous generic Thermostat presentation.
        ? `${device.sn}:dreo-matter:room-air-conditioner-separated-v8`
        : `${device.sn}:dreo-matter:${endpoint}`;
      this.endpointUUIDs.set(endpoint, matter.uuid.generate(seed));
    }

    const state = controller.getStateSnapshot();
    const temperatureLimits = controller.getTemperatureLimits();
    const deviceName = String(device.deviceName || 'Dreo');
    const manufacturer = String(device.brand || 'Dreo');
    const model = String(device.model || 'Portable Air Conditioner');

    const define = (
      endpoint: MatterEndpointId,
      displayName: string,
      deviceType: MatterAccessory['deviceType'],
      clusters: NonNullable<MatterAccessory['clusters']>,
      handlers?: MatterAccessory['handlers'],
    ): MatterAccessory<DreoMatterContext> => ({
      UUID: this.uuidFor(endpoint),
      displayName,
      deviceType,
      // Matter limits serial numbers to 32 characters. Dreo serials can be
      // longer, so use the deterministic, privacy-preserving UUID payload.
      serialNumber: this.uuidFor(endpoint).replace(/-/g, ''),
      manufacturer,
      model,
      context: {
        experimental: true,
        endpoint,
      },
      clusters,
      handlers,
    });

    this.definition = define(
      MATTER_ENDPOINTS.CLIMATE,
      `${deviceName} Klimagerät`,
      this.createCoolingRoomAirConditionerDeviceType(),
      {
        thermostat: this.thermostatState(state, temperatureLimits),
        onOff: {onOff: state.on && state.hvacMode === 'cool'},
      },
      {
        onOff: {
          on: async () => this.runMatterStateHandler(
            () => this.controller.controlCooling(true),
            this.currentOnOffState(MATTER_ENDPOINTS.CLIMATE),
          ),
          off: async () => this.runMatterStateHandler(
            () => this.controller.controlPower(false),
            !this.currentOnOffState(MATTER_ENDPOINTS.CLIMATE),
          ),
        } as MatterClusterHandlers,
      },
    );

    const fanSpeed = define(
      MATTER_ENDPOINTS.FAN_SPEED,
      `${deviceName} Lüfterstärke`,
      this.createFanDeviceType(),
      {
        fanControl: this.fanState(state),
      },
    );

    const humidity = define(
      MATTER_ENDPOINTS.HUMIDITY,
      `${deviceName} Luftfeuchtigkeit`,
      matter.deviceTypes.HumiditySensor,
      {
        relativeHumidityMeasurement: this.humidityState(state),
      },
    );

    this.definitions = [
      this.definition,
      this.onOffDefinition(
        define,
        MATTER_ENDPOINTS.DRY,
        `${deviceName} Trocknen`,
        state.on && state.hvacMode === 'dry',
        () => this.controller.controlDry(true),
        () => this.controller.controlDry(false),
      ),
      this.onOffDefinition(
        define,
        MATTER_ENDPOINTS.FAN_ONLY,
        `${deviceName} Ventilator`,
        state.on && state.hvacMode === 'fan_only',
        () => this.controller.controlFanOnly(true),
        () => this.controller.controlFanOnly(false),
      ),
      fanSpeed,
      this.onOffDefinition(
        define,
        MATTER_ENDPOINTS.AUTO_FAN,
        `${deviceName} Lüfter Auto`,
        state.on && state.speed === 4,
        () => this.controller.controlFanSpeed(4),
        async () => {
          const current = this.controller.getStateSnapshot();
          if (current.on && current.speed === 4) {
            await this.controller.controlFanSpeed(1);
          }
        },
      ),
      humidity,
      this.onOffDefinition(
        define,
        MATTER_ENDPOINTS.SWING,
        `${deviceName} Swing`,
        state.swing,
        () => this.controller.controlSwing(true),
        () => this.controller.controlSwing(false),
      ),
      this.onOffDefinition(
        define,
        MATTER_ENDPOINTS.DISPLAY,
        `${deviceName} Display`,
        state.displayOn,
        () => this.controller.controlDisplay(true),
        () => this.controller.controlDisplay(false),
        true,
      ),
      this.onOffDefinition(
        define,
        MATTER_ENDPOINTS.SLEEP,
        `${deviceName} Sleep`,
        state.on && state.hvacMode === 'cool' && state.mode === 'sleep',
        () => this.controller.controlSleep(true),
        () => this.controller.controlSleep(false),
      ),
      this.onOffDefinition(
        define,
        MATTER_ENDPOINTS.ECO,
        `${deviceName} Eco`,
        state.on && state.hvacMode === 'cool' && state.mode === 'eco',
        () => this.controller.controlEco(true),
        () => this.controller.controlEco(false),
      ),
    ];
  }

  activate(): void {
    if (this.unsubscribeState) {
      return;
    }
    this.lastPublished.clear();
    this.unsubscribeState = this.controller.onStateChange(() => this.requestSync());
    this.requestSync();
  }

  async syncState(): Promise<void> {
    const state = this.controller.getStateSnapshot();
    const updates = this.stateUpdates(state);

    for (const update of updates) {
      const key = `${update.uuid}:${update.cluster}`;
      const serialized = JSON.stringify(update.attributes);
      if (this.lastPublished.get(key) === serialized) {
        continue;
      }

      // Publishing a Dreo report can itself trigger Homebridge's Matter change
      // handlers. Suppress that echo or thermostat Off could power down Dry/Fan.
      this.suppressMatterStateHandlers += 1;
      try {
        await this.matter.updateAccessoryState(
          update.uuid,
          update.cluster,
          update.attributes,
        );
      } finally {
        this.suppressMatterStateHandlers -= 1;
      }
      this.lastPublished.set(key, serialized);
    }
  }

  private createCoolingRoomAirConditionerDeviceType(): MatterAccessory['deviceType'] {
    // Homebridge 2.1.0's generic thermostat handler currently loses the
    // Cooling-only feature specialization and reintroduces hidden Heating and
    // Auto attributes. Handle the two writable attributes in a specialized
    // Matter.js behavior so the endpoint remains genuinely Cooling-only.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const owner = this;
    const {ThermostatServer, RoomAirConditionerDevice} = this.matterRuntime;
    const CoolingThermostatServer = ThermostatServer.with('Cooling');

    class DreoCoolingThermostatServer extends CoolingThermostatServer {
      override initialize(): void {
        super.initialize();
        this.reactTo(
          this.events.systemMode$Changing,
          async systemMode => owner.setThermostatSystemMode(systemMode),
          {offline: true},
        );
        this.reactTo(
          this.events.occupiedCoolingSetpoint$Changing,
          async occupiedCoolingSetpoint => owner.setCoolingSetpoint(occupiedCoolingSetpoint),
          {offline: true},
        );
      }
    }

    return RoomAirConditionerDevice.with(
      DreoCoolingThermostatServer,
    ) as unknown as MatterAccessory['deviceType'];
  }

  private createFanDeviceType(): MatterAccessory['deviceType'] {
    // The behavior class is instantiated later by Matter.js.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const owner = this;
    const {FanControlServer, FanDevice} = this.matterRuntime;
    const FanControlWithAuto = FanControlServer.with('Auto');

    class DreoFanControlServer extends FanControlWithAuto {
      override initialize(): void {
        super.initialize();
        this.reactTo(
          this.events.fanMode$Changed,
          async (fanMode, oldFanMode) => {
            const current = owner.fanState(owner.controller.getStateSnapshot()).fanMode;
            if (
              fanMode === oldFanMode
              || fanMode === current
              || owner.suppressMatterStateHandlers > 0
            ) {
              return;
            }
            await owner.runMatterCommand(() => owner.setFanMode(fanMode));
          },
          {offline: true},
        );
        this.reactTo(
          this.events.percentSetting$Changed,
          async (percentSetting, oldPercentSetting) => {
            const current = owner.fanState(
              owner.controller.getStateSnapshot(),
            ).percentSetting;
            if (
              percentSetting === oldPercentSetting
              || percentSetting === null
              || percentSetting === current
              || owner.suppressMatterStateHandlers > 0
            ) {
              return;
            }
            await owner.runMatterCommand(() => owner.setFanPercentage(percentSetting));
          },
          {offline: true},
        );
      }
    }

    return FanDevice.with(DreoFanControlServer) as unknown as MatterAccessory['deviceType'];
  }

  private onOffDefinition(
    define: (
      endpoint: MatterEndpointId,
      displayName: string,
      deviceType: MatterAccessory['deviceType'],
      clusters: NonNullable<MatterAccessory['clusters']>,
      handlers?: MatterAccessory['handlers'],
    ) => MatterAccessory<DreoMatterContext>,
    endpoint: MatterEndpointId,
    displayName: string,
    on: boolean,
    turnOn: () => Promise<void>,
    turnOff: () => Promise<void>,
    light = false,
  ): MatterAccessory<DreoMatterContext> {
    return define(
      endpoint,
      displayName,
      light
        ? this.matter.deviceTypes.OnOffLight
        : this.matter.deviceTypes.OnOffOutlet,
      {
        onOff: {onOff: on},
      },
      {
        onOff: {
          on: async () => this.runMatterStateHandler(
            turnOn,
            this.currentOnOffState(endpoint),
          ),
          off: async () => this.runMatterStateHandler(
            turnOff,
            !this.currentOnOffState(endpoint),
          ),
        } as MatterClusterHandlers,
      },
    );
  }

  private thermostatState(
    state: AirConditionerStateSnapshot,
    limits: {min: number; max: number},
  ): Record<string, unknown> {
    const thermostat = this.matter.types.Thermostat;
    const cooling = state.on && state.hvacMode === 'cool';
    return {
      localTemperature: this.toMatterTemperature(state.currentTemperature),
      occupiedCoolingSetpoint: this.toMatterTemperature(state.targetTemperature),
      absMinCoolSetpointLimit: this.toMatterTemperature(limits.min),
      absMaxCoolSetpointLimit: this.toMatterTemperature(limits.max),
      minCoolSetpointLimit: this.toMatterTemperature(limits.min),
      maxCoolSetpointLimit: this.toMatterTemperature(limits.max),
      controlSequenceOfOperation: thermostat.ControlSequenceOfOperation.CoolingOnly,
      systemMode: cooling ? thermostat.SystemMode.Cool : thermostat.SystemMode.Off,
    };
  }

  private fanState(state: AirConditionerStateSnapshot): Record<string, unknown> {
    const fan = this.matter.types.FanControl;
    const active = state.on;
    const auto = active && state.speed === 4;
    return {
      fanMode: active ? this.speedToFanMode(state.speed) : fan.FanMode.Off,
      fanModeSequence: fan.FanModeSequence.OffLowMedHighAuto,
      percentSetting: auto ? null : active ? this.speedToPercentage(state.speed) : 0,
      // PercentCurrent is mandatory and not nullable. Dreo does not report a
      // variable physical speed in Auto, so 100 represents its active Auto fan.
      percentCurrent: active ? this.speedToPercentage(state.speed) : 0,
    };
  }

  private humidityState(state: AirConditionerStateSnapshot): Record<string, unknown> {
    return {
      measuredValue: state.currentHumidityAvailable
        ? Math.round(state.currentHumidity * 100)
        : null,
      minMeasuredValue: 0,
      maxMeasuredValue: 10000,
    };
  }

  private stateUpdates(state: AirConditionerStateSnapshot): MatterStateUpdate[] {
    return [
      {
        uuid: this.uuidFor(MATTER_ENDPOINTS.CLIMATE),
        cluster: this.matter.clusterNames.Thermostat,
        attributes: this.thermostatState(state, this.controller.getTemperatureLimits()),
      },
      this.onOffUpdate(
        MATTER_ENDPOINTS.CLIMATE,
        state.on && state.hvacMode === 'cool',
      ),
      this.onOffUpdate(MATTER_ENDPOINTS.DRY, state.on && state.hvacMode === 'dry'),
      this.onOffUpdate(
        MATTER_ENDPOINTS.FAN_ONLY,
        state.on && state.hvacMode === 'fan_only',
      ),
      {
        uuid: this.uuidFor(MATTER_ENDPOINTS.FAN_SPEED),
        cluster: this.matter.clusterNames.FanControl,
        attributes: this.fanState(state),
      },
      this.onOffUpdate(MATTER_ENDPOINTS.AUTO_FAN, state.on && state.speed === 4),
      {
        uuid: this.uuidFor(MATTER_ENDPOINTS.HUMIDITY),
        cluster: this.matter.clusterNames.RelativeHumidityMeasurement,
        attributes: this.humidityState(state),
      },
      this.onOffUpdate(MATTER_ENDPOINTS.SWING, state.swing),
      this.onOffUpdate(MATTER_ENDPOINTS.DISPLAY, state.displayOn),
      this.onOffUpdate(
        MATTER_ENDPOINTS.SLEEP,
        state.on && state.hvacMode === 'cool' && state.mode === 'sleep',
      ),
      this.onOffUpdate(
        MATTER_ENDPOINTS.ECO,
        state.on && state.hvacMode === 'cool' && state.mode === 'eco',
      ),
    ];
  }

  private onOffUpdate(endpoint: MatterEndpointId, onOff: boolean): MatterStateUpdate {
    return {
      uuid: this.uuidFor(endpoint),
      cluster: this.matter.clusterNames.OnOff,
      attributes: {onOff},
    };
  }

  private speedToFanMode(speed: number): number {
    const modes = this.matter.types.FanControl.FanMode;
    if (speed === 1) {
      return modes.Low;
    }
    if (speed === 2) {
      return modes.Medium;
    }
    if (speed === 3) {
      return modes.High;
    }
    return modes.Auto;
  }

  private speedToPercentage(speed: number): number {
    if (speed === 1) {
      return 33;
    }
    if (speed === 2) {
      return 66;
    }
    return 100;
  }

  private async setThermostatSystemMode(systemMode: number): Promise<void> {
    const modes = this.matter.types.Thermostat.SystemMode;
    if (systemMode === modes.Off) {
      await this.runMatterStateHandler(
        () => this.controller.controlPower(false),
        this.currentThermostatSystemMode() === systemMode,
      );
    } else if (systemMode === modes.Cool) {
      await this.runMatterStateHandler(
        () => this.controller.controlCooling(true),
        this.currentThermostatSystemMode() === systemMode,
      );
    } else {
      throw new Error('Dreo Matter thermostat supports only Off and Cool');
    }
  }

  private async setCoolingSetpoint(occupiedCoolingSetpoint: number): Promise<void> {
    await this.runMatterStateHandler(
      () => this.controller.controlTargetTemperature(occupiedCoolingSetpoint / 100),
      this.toMatterTemperature(
        this.controller.getStateSnapshot().targetTemperature,
      ) === occupiedCoolingSetpoint,
    );
  }

  private async setFanMode(fanMode: number): Promise<void> {
    const modes = this.matter.types.FanControl.FanMode;
    if (fanMode === modes.Off) {
      await this.controller.controlPower(false);
      return;
    }
    const speed = new Map<number, number>([
      [modes.Low, 1],
      [modes.Medium, 2],
      [modes.High, 3],
      [modes.Auto, 4],
    ]).get(fanMode);
    if (!speed) {
      throw new Error('Unsupported Matter fan mode');
    }
    await this.controller.controlFanSpeed(speed);
  }

  private async setFanPercentage(percentSetting: number): Promise<void> {
    if (percentSetting <= 0) {
      await this.controller.controlPower(false);
    } else if (percentSetting <= 33) {
      await this.controller.controlFanSpeed(1);
    } else if (percentSetting <= 66) {
      await this.controller.controlFanSpeed(2);
    } else {
      await this.controller.controlFanSpeed(3);
    }
  }

  private async runMatterCommand(command: () => Promise<void>): Promise<void> {
    this.suppressExternalSync += 1;
    try {
      await command();
    } finally {
      this.suppressExternalSync -= 1;
      if (this.suppressExternalSync === 0) {
        const timer = setTimeout(() => this.requestSync(), 0);
        timer.unref();
      }
    }
  }

  private async runMatterStateHandler(
    command: () => Promise<void>,
    alreadyApplied = false,
  ): Promise<void> {
    if (alreadyApplied || this.suppressMatterStateHandlers > 0) {
      return;
    }
    await this.runMatterCommand(command);
  }

  private currentThermostatSystemMode(): number {
    return Number(
      this.thermostatState(
        this.controller.getStateSnapshot(),
        this.controller.getTemperatureLimits(),
      ).systemMode,
    );
  }

  private currentOnOffState(endpoint: MatterEndpointId): boolean {
    const state = this.controller.getStateSnapshot();
    switch (endpoint) {
      case MATTER_ENDPOINTS.CLIMATE:
        return state.on && state.hvacMode === 'cool';
      case MATTER_ENDPOINTS.DRY:
        return state.on && state.hvacMode === 'dry';
      case MATTER_ENDPOINTS.FAN_ONLY:
        return state.on && state.hvacMode === 'fan_only';
      case MATTER_ENDPOINTS.AUTO_FAN:
        return state.on && state.speed === 4;
      case MATTER_ENDPOINTS.SWING:
        return state.swing;
      case MATTER_ENDPOINTS.DISPLAY:
        return state.displayOn;
      case MATTER_ENDPOINTS.SLEEP:
        return state.on && state.hvacMode === 'cool' && state.mode === 'sleep';
      case MATTER_ENDPOINTS.ECO:
        return state.on && state.hvacMode === 'cool' && state.mode === 'eco';
      default:
        return false;
    }
  }

  private requestSync(): void {
    if (this.suppressExternalSync > 0) {
      return;
    }
    this.syncQueue = this.syncQueue
      .then(() => this.syncState())
      .catch(error => {
        this.platform.log.error('Failed to synchronize Dreo Matter state:', error);
      });
  }

  private uuidFor(endpoint: MatterEndpointId): string {
    const uuid = this.endpointUUIDs.get(endpoint);
    if (!uuid) {
      throw new Error(`Missing Matter UUID for ${endpoint}`);
    }
    return uuid;
  }

  private toMatterTemperature(celsius: number): number {
    return Math.round(celsius * 100);
  }
}
