import { describe, expect, it } from 'vitest';
import { chiSquarePValue, normalCdf, rate, requiredSampleSize, twoProportionTest, wilsonInterval } from './stats';

describe('chiSquarePValue', () => {
  it('matches the critical values of the chi-square table', () => {
    expect(chiSquarePValue(3.841459, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquarePValue(6.634897, 1)).toBeCloseTo(0.01, 6);
    expect(chiSquarePValue(5.991465, 2)).toBeCloseTo(0.05, 6);
    expect(chiSquarePValue(11.344867, 3)).toBeCloseTo(0.01, 6);
    expect(chiSquarePValue(0.4549364, 1)).toBeCloseTo(0.5, 6);
  });

  it('agrees with the normal tail for one degree of freedom and is 1 at zero', () => {
    expect(chiSquarePValue(2.5 ** 2, 1)).toBeCloseTo(2 * normalCdf(-2.5), 7);
    expect(chiSquarePValue(0, 1)).toBe(1);
    expect(chiSquarePValue(400, 1)).toBeLessThan(1e-80);
  });
});

describe('wilsonInterval', () => {
  it('matches the textbook 95% interval for 30 / 100', () => {
    // center = (0.3 + 1.96²/200) / (1 + 1.96²/100) = 0.30740, half-width = 0.08845
    const ci = wilsonInterval(30, 100)!;
    expect(ci.low).toBeCloseTo(0.21895, 4);
    expect(ci.high).toBeCloseTo(0.39585, 4);
  });

  it('stays inside [0, 1] at the edges and is undefined without trials', () => {
    // 0 / 10: the upper bound is 2 · (1.96²/20) / (1 + 1.96²/10) = 0.27754
    expect(wilsonInterval(0, 10)).toEqual({ low: 0, high: expect.closeTo(0.27754, 4) });
    expect(wilsonInterval(10, 10)).toEqual({ low: expect.closeTo(0.72246, 4), high: 1 });
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe('rate', () => {
  it('carries value and interval, both null when the denominator is 0', () => {
    expect(rate(1, 4)).toMatchObject({ numerator: 1, denominator: 4, value: 0.25 });
    expect(rate(1, 4).ciLow).toBeGreaterThan(0);
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null, ciLow: null, ciHigh: null });
  });
});

describe('normalCdf', () => {
  it('matches standard normal table values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.0249979, 6);
    expect(normalCdf(3)).toBeCloseTo(0.9986501, 6);
  });

  it('keeps relative precision far in the tail', () => {
    // Φ(−6) = 9.865876e-10
    expect(normalCdf(-6) / 9.865876e-10).toBeCloseTo(1, 5);
  });
});

describe('twoProportionTest', () => {
  it('reproduces the reference example 30/100 vs 45/100', () => {
    // pooled p = 75/200 = 0.375, SE = √(0.375 · 0.625 · (1/100 + 1/100)) = 0.068465, z = 0.15 / 0.068465 = 2.1909
    // unpooled SE = √(0.21/100 + 0.2475/100) = 0.067639, CI = 0.15 ± 1.96 · 0.067639
    const t = twoProportionTest(30, 100, 45, 100)!;
    expect(t.absDiff).toBeCloseTo(0.15, 10);
    expect(t.z).toBeCloseTo(2.1909, 4);
    expect(t.pValue).toBeCloseTo(0.02846, 4);
    expect(t.diffCiLow).toBeCloseTo(0.017427, 5);
    expect(t.diffCiHigh).toBeCloseTo(0.282573, 5);
    expect(t.relativeLift).toBeCloseTo(0.5, 10);
  });

  it('is symmetric in direction and handles degenerate samples', () => {
    const reverse = twoProportionTest(45, 100, 30, 100)!;
    expect(reverse.absDiff).toBeCloseTo(-0.15, 10);
    expect(reverse.pValue).toBeCloseTo(0.02846, 4);

    const none = twoProportionTest(0, 50, 0, 50)!;
    expect(none).toMatchObject({ absDiff: 0, z: 0, pValue: 1, diffCiLow: 0, diffCiHigh: 0, relativeLift: null });
    expect(twoProportionTest(1, 0, 1, 10)).toBeNull();
  });
});

describe('requiredSampleSize', () => {
  it('matches the reference example and needs a non-zero effect', () => {
    // (1.96 + 0.8416)² · (0.3 · 0.7 + 0.45 · 0.55) / 0.15² = 7.8490 · 0.4575 / 0.0225 = 159.6 → 160
    expect(requiredSampleSize(0.3, 0.45)).toBe(160);
    // (1.96 + 0.8416)² · (0.2 · 0.8 + 0.25 · 0.75) / 0.05² = 7.8490 · 0.3475 / 0.0025 = 1091.0 → 1092
    expect(requiredSampleSize(0.2, 0.25)).toBe(1092);
    expect(requiredSampleSize(0.3, 0.3)).toBeNull();
  });
});
