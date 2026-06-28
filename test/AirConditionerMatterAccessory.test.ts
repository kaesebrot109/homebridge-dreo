import {
  Accessory,
  Categories,
  Characteristic,
  Service,
  uuid,
} from '@homebridge/hap-nodejs';
import type { MatterAPI, PlatformAccessory } from 'homebridge';
import { HumiditySensorDevice } from '@matter/main/devices/humidity-sensor';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { OnOffPlugInUnitDevice } from '@matter/main/devices/on-off-plug-in-unit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AirConditionerAccessory } from '../src/accessories/AirConditionerAccessory';
import {
  AirConditionerMatterAccessory,
  MATTER_ENDPOINTS,
} from '../src/accessories/AirConditionerMatterAccessory';
import type { DreoPlatform } from '../src/platform';

type DreoCommand = Record<string, unknown>;

const FAN_MODE = {
  Off: 0,
  Low: 1,
  Medium: 2,
  High: 3,
  Auto: 5,
};

const MATTER_MODES = [
  {modeName: 'Cooling', hvacMode: 'cool'},
  {modeName: 'Dry', hvacMode: 'dry'},
  {modeName: 'Fan Only', hvacMode: 'fan_only'},
] as const;

const MATTER_SPEEDS = [
  {speedName: 'Low', fanMode: FAN_MODE.Low, speed: 1},
  {speedName: 'Medium', fanMode: FAN_MODE.Medium, speed: 2},
  {speedName: 'High', fanMode: FAN_MODE.High, speed: 3},
  {speedName: 'Auto', fanMode: undefined, speed: 4},
] as const;

function createMatterHarness(initialState: DreoCommand = {}) {
  const commands: DreoCommand[] = [];
  let websocketListener: ((message: {data: string}) => void) | undefined;
  const updateAccessoryState = vi.fn(async () => undefined);
  const controlOpen = vi.fn(async (_serial: string, command: DreoCommand) => {
    commands.push(command);
    return true;
  });
  const hapAccessory = new Accessory('Portable AC', uuid.generate('matter-test-ac')) as PlatformAccessory;
  hapAccessory.category = Categories.AIR_CONDITIONER;
  hapAccessory.context = {
    device: {
      brand: 'Dreo',
      deviceName: 'Portable AC',
      model: 'DR-HAC006S',
      sn: 'test-serial',
      config: {
        fan_entity_config: {
          temperature_range: [61, 86],
          temperature_unit: 'fahrenheit',
          humidity_range: [40, 70],
        },
        toggle_entity_config: {
          display: {
            field: 'led_switch',
            labelName: 'Display',
          },
        },
      },
    },
  };

  const matter = {
    uuid,
    deviceTypes: {
      Thermostat: {name: 'Thermostat', code: 0x0301},
      Fan: {name: 'Fan', code: 0x002b},
      HumiditySensor: HumiditySensorDevice,
      OnOffOutlet: OnOffPlugInUnitDevice,
      OnOffLight: OnOffLightDevice,
    },
    clusterNames: {
      Thermostat: 'thermostat',
      FanControl: 'fanControl',
      RelativeHumidityMeasurement: 'relativeHumidityMeasurement',
      OnOff: 'onOff',
    },
    types: {
      FanControl: {
        FanMode: FAN_MODE,
        FanModeSequence: {
          OffLowMedHigh: 0,
          OffLowMedHighAuto: 2,
        },
      },
      Thermostat: {
        SystemMode: {
          Off: 0,
          Cool: 3,
        },
        ThermostatRunningMode: {
          Off: 0,
          Cool: 3,
        },
        ControlSequenceOfOperation: {
          CoolingOnly: 0,
        },
        SetpointRaiseLowerMode: {
          Heat: 0,
          Cool: 1,
          Both: 2,
        },
        PresetScenario: {
          Occupied: 1,
        },
      },
    },
    updateAccessoryState,
  } as unknown as MatterAPI;

  const platform = {
    Service,
    Characteristic,
    api: {
      matter,
      isMatterEnabled: () => true,
    },
    log: {
      debug: vi.fn(),
      error: vi.fn(),
    },
    webHelper: {
      addEventListener: vi.fn((_event: string, listener: (message: {data: string}) => void) => {
        websocketListener = listener;
      }),
      controlOpen,
      control: vi.fn((_serial: string, command: DreoCommand) => {
        commands.push(command);
      }),
      getOpenState: vi.fn(async () => undefined),
      getState: vi.fn(async () => undefined),
    },
  } as unknown as DreoPlatform;

  const controller = new AirConditionerAccessory(platform, hapAccessory, {
    power_switch: false,
    hvacmode: 'cool',
    mode: 'normal',
    speed: 1,
    swing_switch: false,
    temperature: 72,
    humidity: 50,
    led_switch: true,
    ...initialState,
  });
  const matterAccessory = new AirConditionerMatterAccessory(
    platform,
    controller,
    hapAccessory.context.device,
  );

  return {
    commands,
    controlOpen,
    controller,
    definition: matterAccessory.definition as any,
    definitions: matterAccessory.definitions as any[],
    matterAccessory,
    updateAccessoryState,
    emitDreoState: (state: DreoCommand) => websocketListener?.({
      data: JSON.stringify({
        devicesn: 'test-serial',
        method: 'report',
        reported: state,
      }),
    }),
  };
}

function endpoint(definitions: any[], id: string): any {
  const result = definitions.find(candidate => candidate.context.endpoint === id);
  expect(result, `missing Matter endpoint ${id}`).toBeDefined();
  return result;
}

describe('experimental Dreo Matter accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses separately named Apple-supported Matter accessories', () => {
    const {definition, definitions} = createMatterHarness();

    expect(definition.deviceType.name).toBe('RoomAirConditioner');
    expect(definition.clusters.onOff).toEqual({onOff: false});
    expect(endpoint(definitions, MATTER_ENDPOINTS.DRY).deviceType.name).toBe('OnOffPlugInUnit');
    expect(endpoint(definitions, MATTER_ENDPOINTS.FAN_ONLY).deviceType.name).toBe('OnOffPlugInUnit');
    expect(endpoint(definitions, MATTER_ENDPOINTS.FAN_SPEED).deviceType.name).toBe('Fan');
    expect(endpoint(definitions, MATTER_ENDPOINTS.HUMIDITY).deviceType.name).toBe('HumiditySensor');
    expect(definitions.map(candidate => candidate.displayName)).toEqual([
      'Portable AC Klimagerät',
      'Portable AC Trocknen',
      'Portable AC Ventilator',
      'Portable AC Lüfterstärke',
      'Portable AC Lüfter Auto',
      'Portable AC Luftfeuchtigkeit',
      'Portable AC Swing',
      'Portable AC Display',
      'Portable AC Sleep',
      'Portable AC Eco',
    ]);
    expect(definitions).toHaveLength(10);
    expect(definitions.every(candidate => candidate.parts === undefined)).toBe(true);
    expect(definition.serialNumber).toHaveLength(32);
    expect(definition.serialNumber).not.toContain('test-serial');
    expect(endpoint(definitions, MATTER_ENDPOINTS.FAN_SPEED).clusters.fanControl).toMatchObject({
      fanMode: FAN_MODE.Off,
      fanModeSequence: 2,
    });
    expect(endpoint(definitions, MATTER_ENDPOINTS.DRY).clusters.onOff).toEqual({onOff: false});
    expect(endpoint(definitions, MATTER_ENDPOINTS.FAN_ONLY).clusters.onOff).toEqual({onOff: false});
    expect(endpoint(definitions, MATTER_ENDPOINTS.AUTO_FAN).clusters.onOff).toEqual({onOff: false});
    expect(JSON.stringify(definitions)).not.toContain('targetHumidity');
    expect(JSON.stringify(definitions)).not.toContain('"systemMode":8');
  });

  it.each([
    [FAN_MODE.Low, 1],
    [FAN_MODE.Medium, 2],
    [FAN_MODE.High, 3],
  ])('maps Matter fan mode %s to Dreo speed %s', async (fanMode, speed) => {
    const {commands, matterAccessory} = createMatterHarness();

    await (matterAccessory as any).setFanMode(fanMode);

    expect(commands.at(-1)).toEqual({
      power_switch: true,
      hvacmode: 'cool',
      speed,
    });
  });

  it('maps native Matter FanControl Auto to Dreo speed 4', async () => {
    const {commands, matterAccessory} = createMatterHarness();

    await (matterAccessory as any).setFanMode(FAN_MODE.Auto);

    expect(commands.at(-1)).toEqual({
      power_switch: true,
      hvacmode: 'cool',
      speed: 4,
    });
  });

  it.each([
    [33, 1],
    [66, 2],
    [100, 3],
  ])('maps Matter fan percentage %s to Dreo speed %s', async (percentage, speed) => {
    const {commands, matterAccessory} = createMatterHarness();

    await (matterAccessory as any).setFanPercentage(percentage);

    expect(commands.at(-1)).toEqual({
      power_switch: true,
      hvacmode: 'cool',
      speed,
    });
  });

  it('uses a separate Auto switch and returns to Low when disabled', async () => {
    const {commands, controller, definitions} = createMatterHarness();
    const auto = endpoint(definitions, MATTER_ENDPOINTS.AUTO_FAN);

    await auto.handlers.onOff.on();
    expect(controller.getStateSnapshot()).toMatchObject({on: true, speed: 4});

    await auto.handlers.onOff.off();
    expect(controller.getStateSnapshot()).toMatchObject({on: true, speed: 1});
    expect(commands).toEqual([
      {power_switch: true, hvacmode: 'cool', speed: 4},
      {power_switch: true, speed: 1},
    ]);
  });

  it.each(MATTER_MODES.flatMap(mode => MATTER_SPEEDS.map(speed => ({...mode, ...speed}))))(
    'keeps $speedName speed in $modeName mode',
    async ({hvacMode, fanMode, speed}) => {
      const {commands, controller, definitions, matterAccessory} = createMatterHarness();

      if (hvacMode === 'cool') {
        await (matterAccessory as any).setThermostatSystemMode(3);
      } else if (hvacMode === 'dry') {
        await endpoint(definitions, MATTER_ENDPOINTS.DRY).handlers.onOff.on();
      } else {
        await endpoint(definitions, MATTER_ENDPOINTS.FAN_ONLY).handlers.onOff.on();
      }
      commands.length = 0;

      await (matterAccessory as any).setFanMode(fanMode ?? FAN_MODE.Auto);

      expect(commands).toEqual([{power_switch: true, speed}]);
      expect(controller.getStateSnapshot()).toMatchObject({on: true, hvacMode, speed});
    },
  );

  it('keeps Cooling, Dry and Fan Only mutually exclusive across Matter handlers', async () => {
    const {controller, definitions, matterAccessory} = createMatterHarness();

    await (matterAccessory as any).setThermostatSystemMode(3);
    expect(controller.getStateSnapshot()).toMatchObject({on: true, hvacMode: 'cool'});

    await endpoint(definitions, MATTER_ENDPOINTS.DRY).handlers.onOff.on();
    expect(controller.getStateSnapshot()).toMatchObject({on: true, hvacMode: 'dry'});

    await endpoint(definitions, MATTER_ENDPOINTS.FAN_ONLY).handlers.onOff.on();
    expect(controller.getStateSnapshot()).toMatchObject({on: true, hvacMode: 'fan_only'});

    await endpoint(definitions, MATTER_ENDPOINTS.FAN_ONLY).handlers.onOff.off();
    expect(controller.getStateSnapshot()).toMatchObject({on: false});
  });

  it('synchronizes Dreo websocket updates to all dependent Matter endpoints', async () => {
    const {
      emitDreoState,
      matterAccessory,
      updateAccessoryState,
    } = createMatterHarness();
    matterAccessory.activate();
    await matterAccessory.syncState();
    updateAccessoryState.mockClear();

    emitDreoState({
      power_switch: true,
      hvacmode: 'dry',
      speed: 2,
      current_temperature: 77,
      current_humidity: 61,
      swing_switch: true,
    });
    await matterAccessory.syncState();

    expect(updateAccessoryState).toHaveBeenCalledWith(
      expect.any(String),
      'thermostat',
      expect.objectContaining({systemMode: 0, localTemperature: 2500}),
    );
    expect(updateAccessoryState).toHaveBeenCalledWith(
      expect.any(String),
      'onOff',
      {onOff: true},
    );
    expect(updateAccessoryState).toHaveBeenCalledWith(
      expect.any(String),
      'fanControl',
      expect.objectContaining({fanMode: FAN_MODE.Medium}),
    );
    expect(updateAccessoryState).toHaveBeenCalledWith(
      expect.any(String),
      'relativeHumidityMeasurement',
      {measuredValue: 6100, minMeasuredValue: 0, maxMeasuredValue: 10000},
    );
  });

  it('does not echo published Matter state back to the physical device', async () => {
    const {
      commands,
      controller,
      definitions,
      matterAccessory,
      updateAccessoryState,
    } = createMatterHarness({
      power_switch: true,
      hvacmode: 'dry',
    });

    updateAccessoryState.mockImplementation(async (accessoryUUID, cluster, attributes) => {
      const definition = definitions.find(candidate => candidate.UUID === accessoryUUID);
      if (cluster === 'thermostat') {
        await (matterAccessory as any).setThermostatSystemMode(attributes.systemMode);
      } else if (cluster === 'onOff') {
        await definition?.handlers?.onOff?.[attributes.onOff ? 'on' : 'off']?.();
      }
    });

    await matterAccessory.syncState();

    expect(commands).toEqual([]);
    expect(controller.getStateSnapshot()).toMatchObject({
      on: true,
      hvacMode: 'dry',
    });
  });

  it('ignores delayed Matter echoes that already match controller state', async () => {
    const {
      commands,
      controller,
      definitions,
      matterAccessory,
    } = createMatterHarness({
      power_switch: true,
      hvacmode: 'dry',
    });

    await (matterAccessory as any).setThermostatSystemMode(0);
    await endpoint(definitions, MATTER_ENDPOINTS.DRY).handlers.onOff.on();
    await endpoint(definitions, MATTER_ENDPOINTS.FAN_ONLY).handlers.onOff.off();

    expect(commands).toEqual([]);
    expect(controller.getStateSnapshot()).toMatchObject({
      on: true,
      hvacMode: 'dry',
    });
  });

  it('restores a complete Matter state from the Dreo startup snapshot', () => {
    const {definition, definitions} = createMatterHarness({
      power_switch: true,
      hvacmode: 'fan_only',
      speed: 4,
      current_temperature: 75,
      current_humidity: 58,
      swing_switch: true,
      led_switch: false,
    });

    expect(definition.clusters.thermostat).toMatchObject({
      systemMode: 0,
      localTemperature: 2390,
    });
    expect(endpoint(definitions, MATTER_ENDPOINTS.FAN_ONLY).clusters.onOff.onOff).toBe(true);
    expect(endpoint(definitions, MATTER_ENDPOINTS.DRY).clusters.onOff.onOff).toBe(false);
    expect(endpoint(definitions, MATTER_ENDPOINTS.FAN_SPEED).clusters.fanControl).toMatchObject({
      fanMode: FAN_MODE.Auto,
      fanModeSequence: 2,
      percentSetting: null,
    });
    expect(endpoint(definitions, MATTER_ENDPOINTS.AUTO_FAN).clusters.onOff.onOff).toBe(true);
    expect(endpoint(definitions, MATTER_ENDPOINTS.HUMIDITY)
      .clusters.relativeHumidityMeasurement.measuredValue).toBe(5800);
    expect(endpoint(definitions, MATTER_ENDPOINTS.SWING).clusters.onOff.onOff).toBe(true);
    expect(endpoint(definitions, MATTER_ENDPOINTS.DISPLAY).clusters.onOff.onOff).toBe(false);
  });

  it('routes Swing, Display, Sleep and Eco through the shared controller', async () => {
    const {commands, definitions} = createMatterHarness();

    await endpoint(definitions, MATTER_ENDPOINTS.SWING).handlers.onOff.on();
    await endpoint(definitions, MATTER_ENDPOINTS.DISPLAY).handlers.onOff.off();
    await endpoint(definitions, MATTER_ENDPOINTS.SLEEP).handlers.onOff.on();
    await endpoint(definitions, MATTER_ENDPOINTS.ECO).handlers.onOff.on();

    expect(commands).toEqual([
      {power_switch: true, hvacmode: 'cool', swing_switch: true},
      {led_switch: false},
      {poweron: true, mode: 4},
      {poweron: true, mode: 5},
    ]);
  });

  it('serializes overlapping HAP and Matter mode commands', async () => {
    const {commands, controlOpen, controller, definitions} = createMatterHarness();
    let releaseFirst: ((accepted: boolean) => void) | undefined;
    controlOpen.mockImplementationOnce(async (_serial: string, command: DreoCommand) => {
      commands.push(command);
      return new Promise<boolean>(resolve => {
        releaseFirst = resolve;
      });
    });

    const hapCommand = controller.controlCooling(true);
    const matterCommand = endpoint(definitions, MATTER_ENDPOINTS.DRY).handlers.onOff.on();
    await Promise.resolve();
    await Promise.resolve();

    expect(commands).toEqual([{power_switch: true, hvacmode: 'cool'}]);
    releaseFirst?.(true);
    await hapCommand;
    await matterCommand;

    expect(commands).toEqual([
      {power_switch: true, hvacmode: 'cool'},
      {power_switch: true, hvacmode: 'dry'},
    ]);
    expect(controller.getStateSnapshot()).toMatchObject({on: true, hvacMode: 'dry'});
  });
});
