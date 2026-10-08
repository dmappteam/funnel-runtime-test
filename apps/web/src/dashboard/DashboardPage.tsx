import { useEffect, useState, type ReactNode } from 'react';
import type { AnalyticsResponse } from '@funnel/contracts';
import { HttpError } from '../api/http';
import { AbSection } from './AbSection';
import { dashboardSearch, fetchAnalytics, readQuery, type DashboardQuery } from './api';
import { DataQuality } from './DataQuality';
import { EventsTable } from './EventsTable';
import { Filters } from './Filters';
import { Results } from './Results';
import { StepFunnel } from './StepFunnel';
import { VersionsTable } from './VersionsTable';
import './dashboard.css';

const isUnauthorized = (error: unknown) => error instanceof HttpError && error.status === 401;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The last good report stays on screen while a newer one loads or fails. */
function useAnalytics(query: DashboardQuery, reloads: number) {
  const [report, setReport] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchAnalytics(query, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setReport(next);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [query, reloads]);

  return { report, error, loading };
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="dash-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isUnauthorized(error)) {
    return (
      <div className="card dash-state" role="alert">
        <h2>Sign in required</h2>
        <p className="muted">The dashboard is for the team only. Reload the page and enter the admin credentials.</p>
        <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  return (
    <div className="card dash-state" role="alert">
      <h2>Could not load analytics</h2>
      <p className="muted">{messageOf(error)}</p>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function EmptyState({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <div className="card dash-state">
      <h2>No events yet</h2>
      <p className="muted">
        Run <code>npm run generate</code> to send simulated traffic through the funnel, or open the funnel yourself, then refresh.
      </p>
      <button type="button" className="btn btn-sm" onClick={onRefresh} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}

interface ReportViewProps {
  report: AnalyticsResponse;
  query: DashboardQuery;
  loading: boolean;
  error: unknown;
  onChange: (patch: Partial<DashboardQuery>) => void;
  onRefresh: () => void;
}

function ReportView({ report, query, loading, error, onChange, onRefresh }: ReportViewProps) {
  const { versions: available } = report.available;
  if (available.length === 0) return <EmptyState loading={loading} onRefresh={onRefresh} />;

  const latest = Math.max(...available);
  // The content follows the filters the report was computed with, the controls follow the latest choice.
  const version = report.filters.version ?? latest;
  const groups = report.groups.filter((g) => g.version === version);
  const ab = report.ab.find((a) => a.version === version) ?? null;

  return (
    <>
      <Filters
        query={query}
        report={report}
        version={query.version ?? latest}
        latest={latest}
        loading={loading}
        onChange={onChange}
        onRefresh={onRefresh}
      />
      {error !== null && (
        <p className="dash-banner" role="alert">
          {isUnauthorized(error) ? 'Sign in required: reload the page and enter the admin credentials.' : `Refresh failed: ${messageOf(error)}`}
        </p>
      )}
      <div className={loading ? 'dash-content dash-stale' : 'dash-content'} aria-busy={loading}>
        {groups.length === 0 ? (
          <div className="card dash-state dash-section">
            <h2>No sessions in v{version} match these filters</h2>
            <p className="muted">Try another campaign or include QA overrides.</p>
          </div>
        ) : (
          <>
            <Section id="dash-ab" title={`A/B test · v${version}`}>
              <AbSection groups={groups} ab={ab} />
            </Section>
            <Section id="dash-funnel" title="Step funnel">
              <StepFunnel groups={groups} />
            </Section>
            <Section id="dash-results" title="Results">
              <Results groups={groups} />
            </Section>
            <Section id="dash-events" title="Events">
              <EventsTable groups={groups} />
            </Section>
          </>
        )}
        <Section id="dash-versions" title="Versions">
          <VersionsTable versions={report.versions} selected={version} />
        </Section>
        <Section id="dash-quality" title="Data quality">
          <DataQuality report={report} />
        </Section>
      </div>
    </>
  );
}

/** Internal analytics dashboard. Filters live in the URL, so a view can be shared. */
export function DashboardPage() {
  const [query, setQuery] = useState(() => readQuery(window.location.search));
  const [reloads, setReloads] = useState(0);
  const { report, error, loading } = useAnalytics(query, reloads);
  const refresh = () => setReloads((n) => n + 1);

  const update = (patch: Partial<DashboardQuery>) => {
    const next = { ...query, ...patch };
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${dashboardSearch(next)}`);
    setQuery(next);
  };

  return (
    <main className="internal-shell dash">
      <nav className="internal-nav" aria-label="Internal pages">
        <a href="/admin">Admin</a>
        <a href="/dashboard" aria-current="page">
          Dashboard
        </a>
      </nav>
      <header className="dash-header">
        <h1>Funnel analytics</h1>
        <span className="badge mono">{query.funnelId}</span>
      </header>
      {report ? (
        <ReportView report={report} query={query} loading={loading} error={error} onChange={update} onRefresh={refresh} />
      ) : error !== null ? (
        <ErrorState error={error} onRetry={refresh} />
      ) : (
        <div className="card dash-state" aria-busy="true">
          <p className="muted">Loading analytics…</p>
        </div>
      )}
    </main>
  );
}
