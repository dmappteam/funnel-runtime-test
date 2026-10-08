import { aggregate } from '@funnel/analytics';
import type { AnalyticsEventRow, AnalyticsFilters, AnalyticsResponse, Assignment } from '@funnel/contracts';
import type { FunnelConfig } from '@funnel/engine';
import type { Db } from '../db';
import type { VersionService } from './versions';

interface EventRow extends Omit<AnalyticsEventRow, 'properties' | 'assignment'> {
  assignment: string;
  properties_json: string;
}

/** Feeds the stored events of one funnel to `aggregate()` and adds ingestion stats from the dead-letter table. */
export function buildAnalytics(db: Db, versions: VersionService, filters: AnalyticsFilters, now: Date): AnalyticsResponse {
  const rows = db
    .prepare<[string], EventRow>(
      `SELECT event_id, session_id, name, step_id, funnel_id, funnel_version, experiment_id, variant, assignment,
              utm_source, utm_medium, utm_campaign, client_ts, server_ts, properties_json
       FROM events WHERE funnel_id = ?`,
    )
    .all(filters.funnelId);

  const events: AnalyticsEventRow[] = rows.map(({ properties_json, assignment, ...row }) => ({
    ...row,
    assignment: assignment as Assignment,
    properties: JSON.parse(properties_json) as Record<string, unknown>,
  }));

  const configs: Record<number, FunnelConfig> = {};
  for (const version of new Set(events.map((e) => e.funnel_version))) {
    const config = versions.getConfig(filters.funnelId, version);
    if (config) configs[version] = config;
  }

  const report = aggregate({
    events,
    configs,
    filters,
    activeVersion: versions.getActiveVersion(filters.funnelId),
    now: now.toISOString(),
  });

  // rejected_events has no funnel column (an unknown session has no funnel), so these stats cover all funnels.
  const rejectedRows = db
    .prepare<[], { reason: string; count: number }>('SELECT reason, COUNT(*) AS count FROM rejected_events GROUP BY reason')
    .all();
  const rejectedByReason = Object.fromEntries(rejectedRows.map((r) => [r.reason, r.count]));
  const rejected = rejectedRows.reduce((sum, r) => sum + r.count, 0);

  return { ...report, ingestion: { rejected, rejectedByReason } };
}
