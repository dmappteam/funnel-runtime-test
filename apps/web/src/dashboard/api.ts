import type { AnalyticsResponse } from '@funnel/contracts';
import { http } from '../api/http';

export const DEFAULT_FUNNEL_ID = 'workstyle-planner';

/** Dashboard filters. They live in the page URL, so a view can be shared. */
export interface DashboardQuery {
  funnelId: string;
  /** `null`: the latest version with data. */
  version: number | null;
  /** Exact campaign, `NO_CAMPAIGN`, or `null` for all. */
  campaign: string | null;
  includeOverrides: boolean;
}

export function readQuery(search: string): DashboardQuery {
  const params = new URLSearchParams(search);
  const version = Number(params.get('version'));
  return {
    funnelId: params.get('funnelId') || DEFAULT_FUNNEL_ID,
    version: Number.isInteger(version) && version > 0 ? version : null,
    campaign: params.get('campaign') || null,
    includeOverrides: params.get('includeOverrides') === 'true',
  };
}

/** Unset filters are left out: the API rejects an empty `version=`. */
function toParams(query: DashboardQuery, withFunnel: boolean): URLSearchParams {
  const params = new URLSearchParams();
  if (withFunnel) params.set('funnelId', query.funnelId);
  if (query.version !== null) params.set('version', String(query.version));
  if (query.campaign !== null) params.set('campaign', query.campaign);
  if (query.includeOverrides) params.set('includeOverrides', 'true');
  return params;
}

/** Search part of the page URL; the default funnel is implied. */
export function dashboardSearch(query: DashboardQuery): string {
  const search = toParams(query, query.funnelId !== DEFAULT_FUNNEL_ID).toString();
  return search ? `?${search}` : '';
}

export function analyticsUrl(query: DashboardQuery): string {
  return `/api/analytics?${toParams(query, true).toString()}`;
}

export function fetchAnalytics(query: DashboardQuery, signal?: AbortSignal): Promise<AnalyticsResponse> {
  return http<AnalyticsResponse>('GET', analyticsUrl(query), undefined, { signal });
}
