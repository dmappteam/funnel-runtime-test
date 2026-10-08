import { HttpError, type ApiClient } from './api';
import type { GroundTruth, GroupTruth } from './groundTruth';

/** The numbers the verification reads from one analytics group. */
export interface GroupCounts {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  /** In the order the report lists the steps. */
  reached: Record<string, number>;
}

export interface AnalyticsCounts {
  /** Keyed by `${version}:${variant}`, A/B traffic only (`includeOverrides=false`). */
  groups: Map<string, GroupCounts>;
  /** Rejected-events log of the server. */
  rejected: number | null;
}

export interface MetricCheck {
  version: number;
  variant: string;
  metric: string;
  expected: number;
  actual: number;
  ok: boolean;
}

const KPIS = ['started', 'reachedResult', 'ctaClicked'] as const;

/** GET /api/analytics?includeOverrides=false&version=<v> for each version. A version the server does not know yet counts as empty. */
export async function fetchCounts(api: ApiClient, funnelId: string, versions: readonly number[]): Promise<AnalyticsCounts> {
  const groups = new Map<string, GroupCounts>();
  let rejected: number | null = null;
  for (const version of versions) {
    let report;
    try {
      report = await api.analytics(funnelId, version);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) continue;
      throw err;
    }
    rejected = report.ingestion?.rejected ?? rejected;
    for (const group of report.groups ?? []) {
      if (group.version !== version) continue;
      groups.set(`${group.version}:${group.variant}`, {
        started: group.kpi.started,
        reachedResult: group.kpi.reachedResult,
        ctaClicked: group.kpi.ctaClicked,
        reached: Object.fromEntries((group.steps ?? []).map((s) => [s.stepId, s.reached])),
      });
    }
  }
  return { groups, rejected };
}

/** Compares the analytics delta (after − before) with the ground truth, per group: KPIs, then reached per step. */
export function compareCounts(
  truth: GroundTruth,
  before: AnalyticsCounts,
  after: AnalyticsCounts,
  versions: readonly number[],
): MetricCheck[] {
  const expectedByKey = new Map(truth.groups.map((g) => [`${g.version}:${g.variant}`, g]));
  const keys = new Set([...expectedByKey.keys(), ...after.groups.keys()]);
  const checks: MetricCheck[] = [];

  for (const key of [...keys].sort()) {
    const [versionText, variant = ''] = key.split(':');
    const version = Number(versionText);
    if (!versions.includes(version)) continue;
    const expected = expectedByKey.get(key);
    const actual = delta(after.groups.get(key), before.groups.get(key));
    const groupChecks: MetricCheck[] = [];
    const add = (metric: string, e: number, a: number) =>
      groupChecks.push({ version, variant, metric, expected: e, actual: a, ok: e === a });

    for (const kpi of KPIS) add(kpi, expected?.[kpi] ?? 0, actual[kpi]);
    for (const stepId of stepOrder(expected, actual)) {
      add(`reached ${stepId}`, expected?.reached[stepId] ?? 0, actual.reached[stepId] ?? 0);
    }
    // A group that neither the run nor the delta touched is noise, not a check.
    if (groupChecks.some((c) => c.expected !== 0 || c.actual !== 0)) checks.push(...groupChecks);
  }
  return checks;
}

function delta(after: GroupCounts | undefined, before: GroupCounts | undefined): GroupCounts {
  const reached: Record<string, number> = {};
  for (const [stepId, n] of Object.entries(after?.reached ?? {})) reached[stepId] = n - (before?.reached[stepId] ?? 0);
  return {
    started: (after?.started ?? 0) - (before?.started ?? 0),
    reachedResult: (after?.reachedResult ?? 0) - (before?.reachedResult ?? 0),
    ctaClicked: (after?.ctaClicked ?? 0) - (before?.ctaClicked ?? 0),
    reached,
  };
}

/** The report's step order, then any step only the ground truth knows. */
function stepOrder(expected: GroupTruth | undefined, actual: GroupCounts): string[] {
  const ids = Object.keys(actual.reached);
  for (const id of Object.keys(expected?.reached ?? {})) if (!ids.includes(id)) ids.push(id);
  return ids;
}
