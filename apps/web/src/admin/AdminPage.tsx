import { useEffect, useState } from 'react';
import { funnelIdFromUrl, publishVersion, rollbackVersion } from '../api/admin';
import { Callout, type Notice } from './Callout';
import { useConfirm } from './ConfirmDialog';
import { describeError } from './format';
import { PublishPanel } from './PublishPanel';
import { ReleaseLog } from './ReleaseLog';
import { useFunnelOverview, useVersionConfigs, type ConfigEntry } from './useAdminData';
import { VersionsTable } from './VersionsTable';
import './admin.css';

const FALLBACK_VARIANTS = ['A', 'B'];

function variantsOf(entry: ConfigEntry | undefined): string[] {
  if (entry?.status !== 'ready') return FALLBACK_VARIANTS;
  const variants = (entry.config as { experiment?: { variants?: Record<string, unknown> } }).experiment?.variants;
  return variants ? Object.keys(variants) : FALLBACK_VARIANTS;
}

/** Versions, publication and rollback of one funnel. */
export function AdminPage() {
  const [funnelId] = useState(() => funnelIdFromUrl());
  const { state, reload } = useFunnelOverview(funnelId);
  const { configs, load: loadConfig } = useVersionConfigs(funnelId);
  const { confirm, dialog } = useConfirm();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const overview = state.status === 'ready' ? state.data : null;
  const activeVersion = overview?.activeVersion ?? null;
  const activeSummary = overview?.versions.find((v) => v.version === activeVersion);

  useEffect(() => {
    document.title = `Admin · ${funnelId}`;
  }, [funnelId]);

  // The active config gives the variant names for the preview links and the starting point for a new version.
  useEffect(() => {
    if (activeVersion !== null) loadConfig(activeVersion);
  }, [activeVersion, loadConfig]);

  const run = async (action: () => Promise<Notice>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (err) {
      setNotice({ tone: 'danger', ...describeError(err) });
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const publish = async (version: number) => {
    const confirmed = await confirm({
      title: `Publish v${version}?`,
      body: <p>New sessions will start on v{version}. Sessions already in progress stay on the version they started with.</p>,
      confirmLabel: `Publish v${version}`,
    });
    if (!confirmed) return;
    await run(async () => {
      const res = await publishVersion(funnelId, version);
      return {
        tone: 'success',
        title: `v${res.activeVersion} is now active.`,
        detail: res.previousVersion !== null && res.previousVersion !== res.activeVersion ? `Previously active: v${res.previousVersion}.` : undefined,
      };
    });
  };

  const rollback = async (target: number) => {
    const confirmed = await confirm({
      title: `Roll back to v${target}?`,
      body: (
        <p>
          New sessions will start on v{target} again. Sessions already started on v{activeVersion} keep running on v
          {activeVersion}.
        </p>
      ),
      confirmLabel: `Roll back to v${target}`,
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(async () => {
      const res = await rollbackVersion(funnelId);
      return { tone: 'success', title: `Rolled back from v${res.rolledBackFrom} to v${res.activeVersion}.` };
    });
  };

  return (
    <div className="internal-shell adm">
      <nav className="internal-nav" aria-label="Internal pages">
        <span className="adm-brand">Funnel Runtime</span>
        <a href="/admin" aria-current="page">
          Admin
        </a>
        <a href="/dashboard">Dashboard</a>
      </nav>

      {state.status === 'loading' ? (
        <p className="adm-muted" role="status">
          Loading {funnelId}…
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div className="card adm-card adm-load-error">
          <Callout notice={{ tone: 'danger', ...state.problem }} />
          <button type="button" className="btn btn-sm" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      ) : null}

      {overview ? (
        <>
          <header className="card adm-header">
            <div>
              <p className="adm-eyebrow">Funnel</p>
              <h1 className="adm-title">{overview.funnelId}</h1>
              <div className="adm-active">
                {activeVersion !== null ? (
                  <span className="badge badge-success">Active v{activeVersion}</span>
                ) : (
                  <span className="badge badge-warning">No active version</span>
                )}
                <span className={activeSummary?.releaseNote ? 'adm-note' : 'adm-note adm-muted'}>
                  {activeSummary?.releaseNote ?? 'No release note'}
                </span>
              </div>
            </div>
            <div className="adm-preview">
              <p className="adm-eyebrow">Preview as a new session</p>
              <div className="adm-toolbar">
                {variantsOf(activeVersion === null ? undefined : configs[activeVersion]).map((variant) => (
                  <a
                    key={variant}
                    className="btn btn-secondary btn-sm"
                    href={`/?variant=${encodeURIComponent(variant)}&reset=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Variant {variant} ↗
                  </a>
                ))}
              </div>
              <p className="adm-hint">Forced-variant sessions are QA traffic and are left out of the A/B comparison.</p>
            </div>
          </header>

          {notice ? <Callout notice={notice} onDismiss={() => setNotice(null)} /> : null}

          <div className="adm-grid">
            <div className="adm-main">
              <section className="card adm-card" aria-labelledby="adm-versions-title">
                <div className="adm-card-head">
                  <h2 id="adm-versions-title">Versions</h2>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={overview.rollbackTarget === null || busy}
                    onClick={() => overview.rollbackTarget !== null && void rollback(overview.rollbackTarget)}
                  >
                    {overview.rollbackTarget === null ? 'Roll back' : `Roll back to v${overview.rollbackTarget}`}
                  </button>
                </div>
                <p className="adm-hint">
                  {overview.rollbackTarget === null
                    ? 'Nothing to roll back to: only one version has been published.'
                    : `Rollback makes v${overview.rollbackTarget} active for new sessions. Sessions already started stay on their version.`}
                </p>
                <VersionsTable
                  versions={overview.versions}
                  configs={configs}
                  onLoadConfig={loadConfig}
                  onPublish={(version) => void publish(version)}
                  busy={busy}
                />
              </section>

              <PublishPanel funnelId={funnelId} activeVersion={activeVersion} configs={configs} confirm={confirm} onChanged={reload} />
            </div>

            <aside className="card adm-card adm-aside" aria-labelledby="adm-log-title">
              <h2 id="adm-log-title">Release log</h2>
              <ReleaseLog releases={overview.releases} />
            </aside>
          </div>
        </>
      ) : null}

      {dialog}
    </div>
  );
}
