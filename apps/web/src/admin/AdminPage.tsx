import { useEffect, useState } from 'react';
import { createPreview, funnelIdFromUrl, publishVersion, rollbackVersion } from '../api/admin';
import { InternalNav, LangProvider, useI18n } from '../internal/i18n';
import { Callout, type Notice } from './Callout';
import { useConfirm } from './ConfirmDialog';
import { describeError } from './format';
import { PublishPanel } from './PublishPanel';
import { ReleaseLog } from './ReleaseLog';
import { useFunnelOverview, useVersionConfigs } from './useAdminData';
import { VersionsTable } from './VersionsTable';
import './admin.css';

const FALLBACK_VARIANTS = ['A', 'B'];

/** Versions, publication and rollback of one funnel. */
export function AdminPage() {
  return (
    <LangProvider>
      <Admin />
    </LangProvider>
  );
}

function Admin() {
  const { t } = useI18n();
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
    document.title = t.admin.documentTitle(funnelId);
  }, [funnelId, t]);

  // The active config is the starting point for a new version.
  useEffect(() => {
    if (activeVersion !== null) loadConfig(activeVersion);
  }, [activeVersion, loadConfig]);

  const run = async (action: () => Promise<Notice>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (err) {
      setNotice({ tone: 'danger', ...describeError(err, t) });
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const publish = async (version: number) => {
    const confirmed = await confirm({
      title: t.admin.publishTitle(version),
      body: <p>{t.admin.publishBody(version)}</p>,
      confirmLabel: t.admin.publishLabel(version),
    });
    if (!confirmed) return;
    await run(async () => {
      const res = await publishVersion(funnelId, version);
      return {
        tone: 'success',
        title: t.admin.nowActive(res.activeVersion),
        detail:
          res.previousVersion !== null && res.previousVersion !== res.activeVersion ? t.admin.previouslyActive(res.previousVersion) : undefined,
      };
    });
  };

  const rollback = async (target: number) => {
    const confirmed = await confirm({
      title: t.admin.rollbackTitle(target),
      body: <p>{t.admin.rollbackBody(target, activeVersion)}</p>,
      confirmLabel: t.admin.rollbackTo(target),
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(async () => {
      const res = await rollbackVersion(funnelId);
      return { tone: 'success', title: t.admin.rolledBack(res.rolledBackFrom, res.activeVersion) };
    });
  };

  // The tab is opened within the click, so popup blockers allow it; the address follows once the session exists.
  const preview = async (version: number, variant: string) => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const { session } = await createPreview(funnelId, version, variant);
      const url = new URL(`/?session=${encodeURIComponent(session.sessionId)}`, window.location.origin).href;
      if (tab) tab.location.href = url;
      const title = tab ? t.admin.previewOpened(version, variant) : t.admin.previewReady(version, variant);
      setNotice({ tone: 'success', title, link: { href: url, label: t.admin.previewLink } });
    } catch (err) {
      tab?.close();
      setNotice({ tone: 'danger', ...describeError(err, t) });
    } finally {
      await reload();
    }
  };

  return (
    <div className="internal-shell adm">
      <InternalNav current="admin" />

      {state.status === 'loading' ? (
        <p className="adm-muted" role="status">
          {t.admin.loading(funnelId)}
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div className="card adm-card adm-load-error">
          <Callout notice={{ tone: 'danger', ...describeError(state.error, t) }} />
          <button type="button" className="btn btn-sm" onClick={() => void reload()}>
            {t.common.tryAgain}
          </button>
        </div>
      ) : null}

      {overview ? (
        <>
          <header className="card adm-header">
            <div>
              <p className="adm-eyebrow">{t.admin.funnel}</p>
              <h1 className="adm-title">{overview.funnelId}</h1>
              <div className="adm-active">
                {activeVersion !== null ? (
                  <span className="badge badge-success">{t.admin.active(activeVersion)}</span>
                ) : (
                  <span className="badge badge-warning">{t.admin.noActiveVersion}</span>
                )}
                <span className={activeSummary?.releaseNote ? 'adm-note' : 'adm-note adm-muted'}>
                  {activeSummary?.releaseNote ?? t.admin.noReleaseNote}
                </span>
              </div>
            </div>
            <div className="adm-preview">
              <p className="adm-eyebrow">{t.admin.previewTitle}</p>
              <div className="adm-toolbar">
                {(activeSummary?.variants ?? FALLBACK_VARIANTS).map((variant) => (
                  <a
                    key={variant}
                    className="btn btn-secondary btn-sm"
                    href={`/?variant=${encodeURIComponent(variant)}&reset=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t.common.variant(variant)} ↗
                  </a>
                ))}
              </div>
              <p className="adm-hint">{t.admin.previewHint}</p>
            </div>
          </header>

          {notice ? <Callout notice={notice} onDismiss={() => setNotice(null)} /> : null}

          <div className="adm-grid">
            <div className="adm-main">
              <section className="card adm-card" aria-labelledby="adm-versions-title">
                <div className="adm-card-head">
                  <h2 id="adm-versions-title">{t.admin.versions}</h2>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={overview.rollbackTarget === null || busy}
                    title={overview.rollbackTarget === null ? t.admin.rollbackUnavailable : undefined}
                    onClick={() => overview.rollbackTarget !== null && void rollback(overview.rollbackTarget)}
                  >
                    {overview.rollbackTarget === null ? t.admin.rollback : t.admin.rollbackTo(overview.rollbackTarget)}
                  </button>
                </div>
                <p className="adm-hint">{t.admin.rollbackHint}</p>
                <VersionsTable
                  versions={overview.versions}
                  configs={configs}
                  onLoadConfig={loadConfig}
                  onPublish={(version) => void publish(version)}
                  onPreview={(version, variant) => void preview(version, variant)}
                  busy={busy}
                />
              </section>

              <PublishPanel funnelId={funnelId} activeVersion={activeVersion} configs={configs} confirm={confirm} onChanged={reload} />
            </div>

            <aside className="card adm-card adm-aside" aria-labelledby="adm-log-title">
              <h2 id="adm-log-title">{t.admin.releaseLog}</h2>
              <ReleaseLog releases={overview.releases} />
            </aside>
          </div>
        </>
      ) : null}

      {dialog}
    </div>
  );
}
