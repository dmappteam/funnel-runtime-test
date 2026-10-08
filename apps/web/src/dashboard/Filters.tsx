import { NO_CAMPAIGN, type AnalyticsResponse } from '@funnel/contracts';
import type { DashboardQuery } from './api';
import { useI18n } from '../internal/i18n';

interface FiltersProps {
  query: DashboardQuery;
  report: AnalyticsResponse;
  version: number | null;
  latest: number | null;
  loading: boolean;
  onChange: (patch: Partial<DashboardQuery>) => void;
  onRefresh: () => void;
}

/** One row above everything it scopes. A shared link may name a version or campaign without data: it stays selectable. */
export function Filters({ query, report, version, latest, loading, onChange, onRefresh }: FiltersProps) {
  const { t, f } = useI18n();
  const versions = [...new Set([...report.available.versions, ...(version === null ? [] : [version])])].sort((a, b) => b - a);
  const campaigns = report.available.campaigns.filter((c) => c !== NO_CAMPAIGN);
  if (query.campaign !== null && query.campaign !== NO_CAMPAIGN && !campaigns.includes(query.campaign)) {
    campaigns.push(query.campaign);
  }

  return (
    <div className="card dash-filters" role="group" aria-label={t.filters.label}>
      <label className="dash-field">
        <span>{t.filters.version}</span>
        <select value={version ?? ''} onChange={(e) => onChange({ version: Number(e.target.value) })}>
          {versions.map((v) => (
            <option key={v} value={v}>
              v{v}
              {v === latest ? t.filters.latest : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="dash-field">
        <span>{t.filters.campaign}</span>
        <select value={query.campaign ?? ''} onChange={(e) => onChange({ campaign: e.target.value || null })}>
          <option value="">{t.filters.allCampaigns}</option>
          {campaigns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value={NO_CAMPAIGN}>{t.filters.noCampaign}</option>
        </select>
      </label>
      <label className="dash-check">
        <input
          type="checkbox"
          checked={query.includeOverrides}
          onChange={(e) => onChange({ includeOverrides: e.target.checked })}
        />
        {t.filters.includeOverrides}
      </label>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={loading}>
        {loading ? t.common.refreshing : t.common.refresh}
      </button>
      <span className="dash-generated muted">{t.filters.updated(f.time(report.generatedAt))}</span>
    </div>
  );
}
