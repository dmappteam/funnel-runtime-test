import type { AbComparison, ExperimentEta, GroupReport, ProportionTest, Rate, SampleRatioCheck } from '@funnel/contracts';
import { chiSquarePValue, requiredSampleSize, twoProportionTest } from './stats';
import { groupBy } from './util';

const ALPHA = 0.05;
/** Effect the sample-size estimate targets when no difference can be observed. */
const FALLBACK_EFFECT = 0.05;
/** Stricter than the A/B α: a false alarm would discard a healthy experiment. */
const SRM_ALPHA = 0.01;
/** The chi-square approximation needs at least this many expected sessions per variant. */
const SRM_MIN_EXPECTED = 5;
const DAY_MS = 86_400_000;
/** Rates are averaged over at least a day: traffic within a day is uneven, and minutes of data would extrapolate wildly. */
const MIN_RATE_WINDOW_DAYS = 1;

/** Randomly assigned sessions of one variant and its configured weight. */
export interface SplitCount {
  variant: string;
  weight: number;
  sessions: number;
}

/** When the version's sessions started arriving, and whether new ones still do. */
export interface Timeline {
  since: string | null;
  now: string;
  live: boolean;
}

export interface ExperimentFacts {
  /** Every variant of the config, in config order. */
  split: SplitCount[];
  timeline: Timeline;
}

function proportionTest(metric: ProportionTest['metric'], control: Rate, treatment: Rate): ProportionTest {
  const t = twoProportionTest(control.numerator, control.denominator, treatment.numerator, treatment.denominator);
  return {
    metric,
    control,
    treatment,
    absDiff: t?.absDiff ?? null,
    diffCiLow: t?.diffCiLow ?? null,
    diffCiHigh: t?.diffCiHigh ?? null,
    relativeLift: t?.relativeLift ?? null,
    pValue: t?.pValue ?? null,
    significant: t !== null && t.pValue < ALPHA,
  };
}

function requiredSessions(control: Rate, treatment: Rate): number | null {
  const p1 = control.value;
  if (p1 === null) return null;
  let p2 = treatment.value;
  if (p2 === null || p2 === p1) {
    // Near 100% the +5 p.p. target would leave [0, 1], so it points down instead.
    p2 = p1 + FALLBACK_EFFECT <= 1 ? p1 + FALLBACK_EFFECT : p1 - FALLBACK_EFFECT;
  }
  return requiredSampleSize(p1, p2);
}

/** Chi-square goodness of fit of the randomly assigned sessions against the configured weights. */
export function sampleRatioCheck(split: readonly SplitCount[]): SampleRatioCheck {
  const weighted = split.filter((v) => v.weight > 0);
  const totalWeight = weighted.reduce((sum, v) => sum + v.weight, 0);
  const total = weighted.reduce((sum, v) => sum + v.sessions, 0);
  const variants = weighted.map((v) => ({ variant: v.variant, sessions: v.sessions, expectedShare: v.weight / totalWeight }));
  const expected = variants.map((v) => v.expectedShare * total);
  if (variants.length < 2 || expected.some((e) => e < SRM_MIN_EXPECTED)) return { variants, pValue: null, mismatch: false };
  const statistic = variants.reduce((sum, v, i) => sum + (v.sessions - expected[i]!) ** 2 / expected[i]!, 0);
  const pValue = chiSquarePValue(statistic, variants.length - 1);
  return { variants, pValue, mismatch: pValue < SRM_ALPHA };
}

/** Days until every compared variant has `required` sessions, at its own average rate since the version's first session. */
export function experimentEta(required: number | null, counts: readonly number[], timeline: Timeline): ExperimentEta {
  const elapsed = timeline.since === null ? Number.NaN : (Date.parse(timeline.now) - Date.parse(timeline.since)) / DAY_MS;
  const elapsedDays = elapsed >= 0 ? Math.max(MIN_RATE_WINDOW_DAYS, elapsed) : Number.NaN;
  const sessionsPerDay = elapsedDays > 0 ? counts.reduce((sum, n) => sum + n, 0) / elapsedDays : null;
  if (required === null) return { status: 'unknown', sessionsPerDay, daysLeft: null };
  if (counts.every((n) => n >= required)) return { status: 'reached', sessionsPerDay, daysLeft: 0 };
  if (!timeline.live) return { status: 'stopped', sessionsPerDay, daysLeft: null };
  if (sessionsPerDay === null || counts.some((n) => n === 0)) return { status: 'unknown', sessionsPerDay, daysLeft: null };
  // Each variant keeps its share of the traffic, so the slowest one to reach the target decides.
  const daysLeft = Math.max(...counts.map((n) => ((required - n) / n) * elapsedDays));
  return { status: 'collecting', sessionsPerDay, daysLeft };
}

/** Control is the first variant in config order, treatment the second. Expects `groups` sorted by version and variant order. */
export function compareVariants(groups: readonly GroupReport[], factsOf: (version: number) => ExperimentFacts): AbComparison[] {
  const out: AbComparison[] = [];
  for (const [version, list] of groupBy(groups, (g) => g.version)) {
    const [control, treatment] = list;
    if (!control || !treatment) continue;
    const primary = proportionTest('ctaConversion', control.kpi.ctaConversion, treatment.kpi.ctaConversion);
    const required = requiredSessions(control.kpi.ctaConversion, treatment.kpi.ctaConversion);
    const facts = factsOf(version);
    out.push({
      version,
      experimentId: control.experimentId,
      control: control.variant,
      treatment: treatment.variant,
      primary,
      secondary: [
        proportionTest('resultRate', control.kpi.resultRate, treatment.kpi.resultRate),
        proportionTest('ctr', control.kpi.ctr, treatment.kpi.ctr),
      ],
      requiredSessionsPerVariant: required,
      srm: sampleRatioCheck(facts.split),
      eta: experimentEta(required, [primary.control.denominator, primary.treatment.denominator], facts.timeline),
    });
  }
  return out;
}
