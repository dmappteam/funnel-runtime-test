import type { Rate } from '@funnel/contracts';

/** Two-sided critical value for 95% confidence (α = 0.05). */
export const Z_95 = 1.96;
/** Critical value for 80% power. */
export const Z_POWER_80 = 0.8416;

export interface Interval {
  low: number;
  high: number;
}

/** 95% Wilson score interval of `successes` out of `trials`. `null` when there are no trials. */
export function wilsonInterval(successes: number, trials: number, z = Z_95): Interval | null {
  if (trials <= 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  // Clamping removes rounding noise at p = 0 and p = 1, where the bound is exactly 0 or 1.
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function rate(numerator: number, denominator: number): Rate {
  const ci = wilsonInterval(numerator, denominator);
  return {
    numerator,
    denominator,
    value: denominator > 0 ? numerator / denominator : null,
    ciLow: ci?.low ?? null,
    ciHigh: ci?.high ?? null,
  };
}

const ERFC_COEFFS = [
  -1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807, -1.13520398, 1.48851587, -0.82215223,
  0.17087277,
];

/**
 * Complementary error function (Numerical Recipes `erfcc`, Chebyshev fit).
 * The fractional error is below 1.2e-7 everywhere, so tiny p-values keep their precision.
 */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly = ERFC_COEFFS.reduceRight((acc, c) => c + t * acc, 0);
  const r = t * Math.exp(-z * z + poly);
  return x >= 0 ? r : 2 - r;
}

/** Standard normal cumulative distribution function. */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

export interface TwoProportionResult {
  /** p2 − p1 */
  absDiff: number;
  /** 95% CI of the difference (unpooled standard error). */
  diffCiLow: number;
  diffCiHigh: number;
  /** absDiff / p1, `null` when p1 is 0. */
  relativeLift: number | null;
  /** Test statistic with the pooled standard error. */
  z: number;
  /** Two-sided. */
  pValue: number;
}

/** Two-sided two-proportion z-test of treatment `x2 / n2` against control `x1 / n1`. `null` when a sample is empty. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): TwoProportionResult | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const diff = p2 - p1;
  const pooled = (x1 + x2) / (n1 + n2);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  // The pooled SE is 0 only when both samples are all successes or all failures: no difference, p = 1.
  const z = sePooled > 0 ? diff / sePooled : 0;
  const seDiff = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return {
    absDiff: diff,
    diffCiLow: diff - Z_95 * seDiff,
    diffCiHigh: diff + Z_95 * seDiff,
    relativeLift: p1 > 0 ? diff / p1 : null,
    z,
    // The approximation gives Φ(0) = 0.5 + 1.5e-8, so z = 0 would yield p slightly above 1.
    pValue: Math.min(1, 2 * normalCdf(-Math.abs(z))),
  };
}

/** Sessions per variant to detect a change from `p1` to `p2` (two-sided α = 0.05, 80% power). `null` when p1 = p2. */
export function requiredSampleSize(p1: number, p2: number): number | null {
  if (p1 === p2) return null;
  const variance = p1 * (1 - p1) + p2 * (1 - p2);
  return Math.ceil(((Z_95 + Z_POWER_80) ** 2 * variance) / (p2 - p1) ** 2);
}
