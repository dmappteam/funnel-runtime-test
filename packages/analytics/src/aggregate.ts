import {
  NO_CAMPAIGN,
  type AggregateInput,
  type AnalyticsFilters,
  type AnalyticsReport,
  type GroupReport,
  type VersionReport,
} from '@funnel/contracts';
import type { FunnelConfig } from '@funnel/engine';
import { compareVariants } from './ab';
import { stepMetrics } from './funnel';
import { stepLayout, variantOrder } from './layout';
import { eventStats, kpiSet, resultCounts } from './metrics';
import { compareTimestamps, dedupeEvents, summarizeSessions, type SessionSummary } from './sessions';
import { compare, groupBy } from './util';

function normalizeFilters(filters: AnalyticsFilters): AnalyticsFilters {
  return {
    funnelId: filters.funnelId,
    version: filters.version ?? null,
    // A stored utm_campaign is never empty, so an empty filter value can only mean "all".
    campaign: filters.campaign || null,
    includeOverrides: filters.includeOverrides === true,
  };
}

function matchesCampaign(s: SessionSummary, campaign: string | null): boolean {
  if (campaign === null) return true;
  return campaign === NO_CAMPAIGN ? s.campaign === null : s.campaign === campaign;
}

function campaignsOf(sessions: readonly SessionSummary[]): string[] {
  const named = new Set<string>();
  let none = false;
  for (const s of sessions) {
    if (s.campaign === null) none = true;
    else named.add(s.campaign);
  }
  return [...[...named].sort(compare), ...(none ? [NO_CAMPAIGN] : [])];
}

function configOf(configs: AggregateInput['configs'], version: number): FunnelConfig | undefined {
  return configs[version];
}

/** The config is the source of truth; events carry the same id and cover a missing config. */
function experimentIdOf(config: FunnelConfig | undefined, sessions: readonly SessionSummary[]): string {
  return config?.experiment.id ?? sessions[0]?.experimentId ?? '';
}

function byVersion(sessions: readonly SessionSummary[]): [number, SessionSummary[]][] {
  return [...groupBy(sessions, (s) => s.version)].sort(([a], [b]) => a - b);
}

/** Earliest (`direction` −1) or latest (+1) timestamp. */
function extreme(values: readonly string[], direction: 1 | -1): string | null {
  let out: string | null = null;
  for (const v of values) if (out === null || direction * compareTimestamps(v, out) > 0) out = v;
  return out;
}

function groupReports(sessions: readonly SessionSummary[], configs: AggregateInput['configs']): GroupReport[] {
  return byVersion(sessions).flatMap(([version, list]) => {
    const config = configOf(configs, version);
    const order = variantOrder(config);
    const variants = [...groupBy(list, (s) => s.variant)].sort(([a], [b]) => order(a, b));
    return variants.map(([variant, group]) => ({
      version,
      experimentId: experimentIdOf(config, group),
      variant,
      kpi: kpiSet(group),
      steps: stepMetrics(group, stepLayout(config, variant)),
      results: resultCounts(group),
      events: eventStats(group, config),
    }));
  });
}

function versionReports(sessions: readonly SessionSummary[], configs: AggregateInput['configs']): VersionReport[] {
  return byVersion(sessions).map(([version, list]) => {
    const config = configOf(configs, version);
    return {
      version,
      experimentId: experimentIdOf(config, list),
      variants: [...new Set(list.map((s) => s.variant))].sort(variantOrder(config)),
      kpi: kpiSet(list),
      firstSeen: extreme(list.map((s) => s.firstSeen), -1),
      lastSeen: extreme(list.map((s) => s.lastSeen), 1),
    };
  });
}

/**
 * Pure aggregation of raw stored events into the dashboard report.
 * Events may contain duplicates and arrive in any order; every count is distinct sessions.
 */
export function aggregate(input: AggregateInput): AnalyticsReport {
  const filters = normalizeFilters(input.filters);
  const events = dedupeEvents(input.events).filter((e) => e.funnel_id === filters.funnelId);
  // Campaign and assignment are session attributes like version and variant, so a session is kept or dropped as a whole.
  const sessions = summarizeSessions(events);
  const inCampaign = sessions.filter((s) => matchesCampaign(s, filters.campaign));
  const overrides = inCampaign.filter((s) => s.assignment === 'override');
  const included = filters.includeOverrides ? inCampaign : inCampaign.filter((s) => s.assignment !== 'override');
  const groups = groupReports(
    included.filter((s) => filters.version === null || s.version === filters.version),
    input.configs,
  );

  return {
    generatedAt: input.now ?? new Date().toISOString(),
    filters,
    available: {
      versions: [...new Set(sessions.map((s) => s.version))].sort((a, b) => a - b),
      campaigns: campaignsOf(sessions),
    },
    totals: {
      events: included.reduce((sum, s) => sum + s.events, 0),
      sessions: included.length,
      overrideSessions: overrides.length,
    },
    versions: versionReports(included, input.configs),
    groups,
    ab: compareVariants(groups),
  };
}
