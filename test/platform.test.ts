import { describe, expect, it } from 'vitest';

import { exposesAirConditionerThroughHap } from '../src/platform';

describe('Dreo platform exposure selection', () => {
  it('publishes the HAP air-conditioner variant by default', () => {
    expect(exposesAirConditionerThroughHap(false)).toBe(true);
  });

  it('suppresses the HAP air-conditioner variant when Matter is selected', () => {
    expect(exposesAirConditionerThroughHap(true)).toBe(false);
  });
});
