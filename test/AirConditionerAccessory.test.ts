import {
  Accessory,
  Categories,
  Characteristic,
  Service,
  uuid,
} from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AirConditionerAccessory } from '../src/accessories/AirConditionerAccessory';
import type { DreoPlatform } from '../src/platform';

type DreoCommand = Record<string, unknown>;

const MODES = [
  {subtype: 'Cool', service: Service.HeaterCooler, mode: 'cool'},
  {subtype: 'Dry', service: Service.HumidifierDehumidifier, mode: 'dry'},
  {subtype: 'FanOnly', service: Service.Fanv2, mode: 'fan_only'},
] as const;

const SPEEDS = [
  {subtype: 'FanSpeed1', speed: 1},
  {subtype: 'FanSpeed2', speed: 2},
  {subtype: 'FanSpeed3', speed: 3},
  {subtype: 'AutoFan', speed: 4},
] as const;

function createAccessory(initialState: DreoCommand = {}) {
  const commands: DreoCommand[] = [];
  let websocketListener: ((message: {data: string}) => void) | undefined;
  const hapAccessory = new Accessory('Portable AC', uuid.generate('test-ac')) as PlatformAccessory;
  hapAccessory.category = Categories.AIR_CONDITIONER;
  hapAccessory.context = {};
  hapAccessory.context.device = {
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
  };

  const platform = {
    Service,
    Characteristic,
    log: {
      debug: vi.fn(),
    },
    webHelper: {
      addEventListener: vi.fn((_event: string, listener: (message: {data: string}) => void) => {
        websocketListener = listener;
      }),
      controlOpen: vi.fn(async (_serial: string, command: DreoCommand) => {
        commands.push(command);
        return true;
      }),
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

  return {
    accessory: hapAccessory,
    commands,
    controller,
    emitDreoState: (state: DreoCommand) => websocketListener?.({
      data: JSON.stringify({
        devicesn: 'test-serial',
        method: 'report',
        reported: state,
      }),
    }),
  };
}

async function setCharacteristic(
  accessory: PlatformAccessory,
  serviceType: typeof Service,
  subtype: string,
  characteristicType: typeof Characteristic,
  value: number | boolean,
) {
  const service = accessory.getServiceById(serviceType, subtype);
  expect(service, `missing service subtype ${subtype}`).toBeDefined();
  await service!.getCharacteristic(characteristicType).handleSetRequest(value);
}

describe('AirConditionerAccessory on the Homebridge v2 HAP runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('creates the existing HomeKit service layout with stable subtypes', () => {
    const {accessory} = createAccessory();

    for (const mode of MODES) {
      expect(accessory.getServiceById(mode.service, mode.subtype)).toBeDefined();
    }
    for (const speed of SPEEDS) {
      expect(accessory.getServiceById(Service.Switch, speed.subtype)).toBeDefined();
    }
    expect(accessory.getServiceById(Service.Switch, 'Display')).toBeDefined();
    expect(accessory.getServiceById(Service.Switch, 'SleepMode')).toBeDefined();
    expect(accessory.getServiceById(Service.Switch, 'EcoMode')).toBeDefined();
  });

  it.each(MODES)('activates only $mode mode', async ({subtype, service, mode}) => {
    const {accessory, commands} = createAccessory();

    await setCharacteristic(accessory, service, subtype, Characteristic.Active, 1);

    expect(commands.at(-1)).toEqual({
      power_switch: true,
      hvacmode: mode,
    });
    for (const candidate of MODES) {
      const active = accessory
        .getServiceById(candidate.service, candidate.subtype)!
        .getCharacteristic(Characteristic.Active)
        .value;
      expect(Boolean(active)).toBe(candidate.mode === mode);
    }
  });

  it.each(MODES.flatMap(mode => SPEEDS.map(speed => ({...mode, ...speed}))))(
    'keeps $mode and fan speed $speed mutually consistent',
    async ({subtype, mode, speed}) => {
      const {accessory, commands} = createAccessory({
        power_switch: true,
        hvacmode: mode,
      });

      await setCharacteristic(accessory, Service.Switch, subtype, Characteristic.On, true);

      expect(commands.at(-1)).toEqual({
        power_switch: true,
        speed,
      });
      const activeMode = MODES.filter(candidate => Boolean(
        accessory
          .getServiceById(candidate.service, candidate.subtype)!
          .getCharacteristic(Characteristic.Active)
          .value,
      ));
      expect(activeMode.map(candidate => candidate.mode)).toEqual([mode]);
    },
  );

  it('keeps target temperature, humidity, swing, display, sleep and eco controls wired', async () => {
    const {accessory, commands} = createAccessory();

    await setCharacteristic(
      accessory,
      Service.HeaterCooler,
      'Cool',
      Characteristic.CoolingThresholdTemperature,
      24,
    );
    await setCharacteristic(
      accessory,
      Service.HumidifierDehumidifier,
      'Dry',
      Characteristic.RelativeHumidityDehumidifierThreshold,
      55,
    );
    await setCharacteristic(accessory, Service.Fanv2, 'FanOnly', Characteristic.SwingMode, 1);
    await setCharacteristic(accessory, Service.Switch, 'Display', Characteristic.On, false);
    await setCharacteristic(accessory, Service.Switch, 'SleepMode', Characteristic.On, true);
    await setCharacteristic(accessory, Service.Switch, 'EcoMode', Characteristic.On, true);

    expect(commands).toEqual([
      {power_switch: true, hvacmode: 'cool', temperature: 75},
      {power_switch: true, hvacmode: 'dry', humidity: 55},
      {power_switch: true, hvacmode: 'fan_only', swing_switch: true},
      {led_switch: false},
      {poweron: true, mode: 4},
      {poweron: true, mode: 5},
    ]);
  });

  it('maps numeric Dreo app modes to Sleep and Eco state', () => {
    const {controller, emitDreoState} = createAccessory();

    emitDreoState({poweron: true, mode: 4});
    expect(controller.getStateSnapshot()).toMatchObject({
      on: true,
      hvacMode: 'cool',
      mode: 'sleep',
    });

    emitDreoState({mode: 5});
    expect(controller.getStateSnapshot()).toMatchObject({
      on: true,
      hvacMode: 'cool',
      mode: 'eco',
    });

    emitDreoState({mode: 1});
    expect(controller.getStateSnapshot()).toMatchObject({mode: 'normal'});
  });

  it('keeps Dreo target and measured temperature separate across reports and commands', async () => {
    const {
      accessory,
      controller,
      emitDreoState,
    } = createAccessory({
      templevel: 70,
      temperature: 76,
    });

    expect(controller.getStateSnapshot()).toMatchObject({
      targetTemperature: 21.1,
      currentTemperature: 24.4,
    });
    expect(
      accessory
        .getServiceById(Service.HeaterCooler, 'Cool')!
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .value,
    ).toBe(21);
    expect(
      accessory
        .getServiceById(Service.HeaterCooler, 'Cool')!
        .getCharacteristic(Characteristic.CurrentTemperature)
        .value,
    ).toBeCloseTo(24.4);

    emitDreoState({temperature: 79});
    expect(controller.getStateSnapshot()).toMatchObject({
      targetTemperature: 21.1,
      currentTemperature: 26.1,
    });

    await controller.controlTargetTemperature(20);
    expect(controller.getStateSnapshot()).toMatchObject({
      targetTemperature: 20,
      currentTemperature: 26.1,
    });
  });
});
