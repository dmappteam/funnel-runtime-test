import { z } from 'zod';
import type { FunnelConfig, StepType } from '@funnel/engine';
import type { Assignment } from './api';

/** A stored event as the aggregator sees it. Every row is self-contained: group attributes were copied from the session at ingestion. */
export interface AnalyticsEventRow {
  event_id: string;
  session_id: string;
  name: string;
  step_id: string | null;
  funnel_id: string;
  funnel_version: number;
  experiment_id: string;
  variant: string;
  assignment: Assignment;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  client_ts: string | null;
  server_ts: string;
  properties: Record<string, unknown>;
}

/** Campaign filter value that selects sessions without `utm_campaign`. */
export const NO_CAMPAIGN = '(none)';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/** Query string of GET /api/analytics. Empty parameters (`?version=`) mean "not set". */
export const AnalyticsQuerySchema = z.object({
  funnelId: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
  version: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  campaign: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  includeOverrides: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export interface AnalyticsFilters {
  funnelId: string;
  /** Restricts `groups` and `ab`. `versions` always lists every version. */
  version: number | null;
  /** Exact `utm_campaign`, `NO_CAMPAIGN` for sessions without one, `null` for all. */
  campaign: string | null;
  /** Sessions with a forced variant (`?variant=`) are QA traffic and excluded unless this is true. */
  includeOverrides: boolean;
}

export interface Rate {
  numerator: number;
  denominator: number;
  /** `null` when the denominator is 0. */
  value: number | null;
  /** 95% Wilson interval. */
  ciLow: number | null;
  ciHigh: number | null;
}

/** All counts are distinct sessions. */
export interface KpiSet {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  /** reachedResult / started */
  resultRate: Rate;
  /** ctaClicked / reachedResult */
  ctr: Rate;
  /** ctaClicked / started. Primary A/B metric. */
  ctaConversion: Rate;
  /** Sessions with at least one back_clicked / started. */
  backRate: Rate;
}

export interface StepMetrics {
  stepId: string;
  /** 0-based position in the variant's stepSequence. */
  position: number;
  type: StepType;
  /** Has `visibleWhen`: only part of the sessions sees it. */
  conditional: boolean;
  /** Sessions with any event on this step. */
  reached: number;
  /** Sessions that reached any later step. */
  advanced: number;
  /** advanced / reached */
  conversion: number | null;
  /** Sessions whose furthest step is this one and that never saw a result. */
  dropoff: number;
  /** dropoff / reached */
  dropoffRate: number | null;
  /** reached / started */
  reachedFromStart: number | null;
}

/** One version × variant. */
export interface GroupReport {
  version: number;
  experimentId: string;
  variant: string;
  kpi: KpiSet;
  /** In the variant's own step order. */
  steps: StepMetrics[];
  /** Final result per session (latest result_viewed by client time). */
  results: { resultId: string; sessions: number }[];
  /** Every event name seen in the group, so a newly introduced event shows up without code changes. */
  events: { name: string; sessions: number; events: number }[];
}

export interface ProportionTest {
  metric: 'ctaConversion' | 'resultRate' | 'ctr';
  control: Rate;
  treatment: Rate;
  /** treatment − control */
  absDiff: number | null;
  /** 95% CI of the difference. */
  diffCiLow: number | null;
  diffCiHigh: number | null;
  /** absDiff / control */
  relativeLift: number | null;
  /** Two-sided two-proportion z-test. */
  pValue: number | null;
  significant: boolean;
}

export interface AbComparison {
  version: number;
  experimentId: string;
  control: string;
  treatment: string;
  /** ctaConversion */
  primary: ProportionTest;
  /** resultRate and ctr */
  secondary: ProportionTest[];
  /** Sessions per variant for 80% power at α = 0.05 to detect the observed difference (+5 p.p. if none is observed). */
  requiredSessionsPerVariant: number | null;
}

export interface VersionReport {
  version: number;
  experimentId: string;
  variants: string[];
  kpi: KpiSet;
  /** Earliest and latest server time of the version's events. Versions run at different times. */
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface AnalyticsReport {
  generatedAt: string;
  filters: AnalyticsFilters;
  available: {
    versions: number[];
    /** Distinct utm_campaign values, `NO_CAMPAIGN` for sessions without one. */
    campaigns: string[];
  };
  totals: {
    events: number;
    sessions: number;
    /** Sessions with a forced variant in the current campaign filter. */
    overrideSessions: number;
  };
  versions: VersionReport[];
  groups: GroupReport[];
  ab: AbComparison[];
}

/** Input of `aggregate()` in @funnel/analytics. */
export interface AggregateInput {
  /** Events of one funnel. May contain duplicates and arrive in any order. */
  events: AnalyticsEventRow[];
  /** Config of every version present in `events`, keyed by version number. */
  configs: Record<number, FunnelConfig>;
  filters: AnalyticsFilters;
  /** ISO time used for `generatedAt`. */
  now?: string;
}

/** GET /api/analytics. The server adds ingestion stats from the rejected-events log. */
export interface AnalyticsResponse extends AnalyticsReport {
  ingestion: {
    rejected: number;
    rejectedByReason: Record<string, number>;
  };
}
