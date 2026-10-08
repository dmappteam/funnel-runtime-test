import { useEffect, useState, type ReactNode } from 'react';
import type { AnalyticsResponse } from '@funnel/contracts';
import { addDemoData, removeDemoData } from '../api/admin';
import { HttpError } from '../api/http';
import { useConfirm } from '../admin/ConfirmDialog';
import { InternalNav, LangProvider, useI18n } from '../internal/i18n';
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
  const { t } = useI18n();
  if (isUnauthorized(error)) {
    return (
      <div className="card dash-state" role="alert">
        <h2>{t.dash.signInTitle}</h2>
        <p className="muted">{t.dash.signInBody}</p>
        <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
          {t.dash.reload}
        </button>
      </div>
    );
  }
  return (
    <div className="card dash-state" role="alert">
      <h2>{t.dash.loadFailed}</h2>
      <p className="muted">{messageOf(error)}</p>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        {t.common.tryAgain}
      </button>
    </div>
  );
}

function EmptyState({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  const { t } = useI18n();
  return (
    <div className="card dash-state">
      <h2>{t.dash.emptyTitle}</h2>
      <p className="muted">{t.dash.emptyBody}</p>
      <button type="button" className="btn btn-sm" onClick={onRefresh} disabled={loading}>
        {loading ? t.common.refreshing : t.common.refresh}
      </button>
    </div>
  );
}

type DemoBusy = 'add' | 'remove' | null;

/** Generator traffic on the active version, and its removal. Both need the admin credentials. */
function DemoControls({ funnelId, onChanged }: { funnelId: string; onChanged: () => void }) {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<DemoBusy>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const run = async (kind: Exclude<DemoBusy, null>, action: () => Promise<string>) => {
    setBusy(kind);
    setMessage(null);
    try {
      setMessage({ tone: 'success', text: await action() });
    } catch (err) {
      setMessage({ tone: 'danger', text: t.demo.failed(messageOf(err)) });
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const add = () =>
    run('add', async () => {
      const res = await addDemoData(funnelId);
      return t.demo.added(res.sessions, res.version, res.completed);
    });

  const remove = async () => {
    const confirmed = await confirm({
      title: t.demo.confirmTitle,
      body: <p>{t.demo.confirmBody}</p>,
      confirmLabel: t.demo.confirmLabel,
      tone: 'danger',
    });
    if (!confirmed) return;
    await run('remove', async () => {
      const res = await removeDemoData(funnelId);
      return t.demo.removed(res.sessions, res.events);
    });
  };

  return (
    <div className="dash-demo">
      <div className="dash-demo-actions">
        <button type="button" className="btn btn-secondary btn-sm" title={t.demo.addHint} disabled={busy !== null} onClick={() => void add()}>
          {busy === 'add' ? t.demo.adding : t.demo.add}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void remove()}>
          {busy === 'remove' ? t.demo.removing : t.demo.remove}
        </button>
      </div>
      {message && (
        <p className={message.tone === 'danger' ? 'dash-demo-message dash-demo-error' : 'dash-demo-message'} role="status">
          {message.text}
        </p>
      )}
      {dialog}
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
  const { t } = useI18n();
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
          {isUnauthorized(error) ? t.dash.signInBanner : t.dash.refreshFailed(messageOf(error))}
        </p>
      )}
      <div className={loading ? 'dash-content dash-stale' : 'dash-content'} aria-busy={loading}>
        {groups.length === 0 ? (
          <div className="card dash-state dash-section">
            <h2>{t.dash.noSessions(version)}</h2>
            <p className="muted">{t.dash.noSessionsHint}</p>
          </div>
        ) : (
          <>
            <Section id="dash-ab" title={t.dash.abTitle(version)}>
              <AbSection groups={groups} ab={ab} />
            </Section>
            <Section id="dash-funnel" title={t.dash.funnelTitle}>
              <StepFunnel groups={groups} />
            </Section>
            <Section id="dash-results" title={t.dash.resultsTitle}>
              <Results groups={groups} />
            </Section>
            <Section id="dash-events" title={t.dash.eventsTitle}>
              <EventsTable groups={groups} />
            </Section>
          </>
        )}
        <Section id="dash-versions" title={t.dash.versionsTitle}>
          <VersionsTable versions={report.versions} selected={version} />
        </Section>
        <Section id="dash-quality" title={t.dash.qualityTitle}>
          <DataQuality report={report} />
        </Section>
      </div>
    </>
  );
}

/** Internal analytics dashboard. Filters live in the URL, so a view can be shared. */
export function DashboardPage() {
  return (
    <LangProvider>
      <Dashboard />
    </LangProvider>
  );
}

function Dashboard() {
  const { t } = useI18n();
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
      <InternalNav current="dashboard" />
      <header className="dash-header">
        <h1>{t.dash.title}</h1>
        <span className="badge mono">{query.funnelId}</span>
        <DemoControls funnelId={query.funnelId} onChanged={refresh} />
      </header>
      {report ? (
        <ReportView report={report} query={query} loading={loading} error={error} onChange={update} onRefresh={refresh} />
      ) : error !== null ? (
        <ErrorState error={error} onRetry={refresh} />
      ) : (
        <div className="card dash-state" aria-busy="true">
          <p className="muted">{t.dash.loading}</p>
        </div>
      )}
    </main>
  );
}
