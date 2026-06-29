import type { API, MatterAccessory, PlatformConfig } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import { DreoPlatform } from '../src/platform';

interface HarnessOptions {
  enableMatter?: boolean;
  isMatterEnabled?: boolean;
  omitMatterCapability?: boolean;
  cachedMatterAccessories?: MatterAccessory[];
}

function createHarness(options: HarnessOptions = {}) {
  const unregisterPlatformAccessories = vi.fn(async () => undefined);
  const warn = vi.fn();
  const error = vi.fn();
  const api = {
    matter: {
      unregisterPlatformAccessories,
    },
    ...(options.omitMatterCapability
      ? {}
      : {isMatterEnabled: () => options.isMatterEnabled === true}),
  } as unknown as API;
  const platform = Object.assign(Object.create(DreoPlatform.prototype), {
    api,
    config: {
      enableMatter: options.enableMatter === true,
    } as PlatformConfig,
    log: {
      warn,
      error,
      info: vi.fn(),
    },
    accessories: [],
    matterAccessories: [...(options.cachedMatterAccessories || [])],
  }) as DreoPlatform;

  return {
    error,
    platform,
    unregisterPlatformAccessories,
    warn,
  };
}

function usesMatter(platform: DreoPlatform, requested: boolean): boolean {
  return (platform as unknown as {
    isMatterAvailable(value: boolean): boolean;
  }).isMatterAvailable(requested);
}

describe('Dreo platform air-conditioner exposure selection', () => {
  it('publishes the HAP variant by default', () => {
    const {platform} = createHarness();

    expect(usesMatter(platform, false)).toBe(false);
  });

  it('publishes the Matter variant when it is requested and available', () => {
    const {platform} = createHarness({enableMatter: true, isMatterEnabled: true});

    expect(usesMatter(platform, true)).toBe(true);
  });

  it('falls back to HAP when the Homebridge API has no Matter capability', async () => {
    const {platform, warn} = createHarness({
      enableMatter: true,
      omitMatterCapability: true,
    });

    await platform.discoverDevices();

    expect(usesMatter(platform, true)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Falling back'));
  });

  it('falls back to HAP when Matter is disabled on the bridge', async () => {
    const {platform, warn} = createHarness({
      enableMatter: true,
      isMatterEnabled: false,
    });

    await platform.discoverDevices();

    expect(usesMatter(platform, true)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Falling back'));
  });

  it('unregisters cached Matter accessories when switching back to HAP', async () => {
    const cachedMatterAccessory = {
      UUID: 'cached-matter-accessory',
      displayName: 'Dreo AC',
    } as MatterAccessory;
    const {
      platform,
      unregisterPlatformAccessories,
    } = createHarness({cachedMatterAccessories: [cachedMatterAccessory]});

    await platform.discoverDevices();

    expect(unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-dreo',
      'DreoPlatform',
      [cachedMatterAccessory],
    );
    expect(platform.matterAccessories).toEqual([]);
  });
});
