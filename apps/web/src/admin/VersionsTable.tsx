import { Fragment, useState } from 'react';
import type { VersionSummary } from '@funnel/contracts';
import { useI18n } from '../internal/i18n';
import { describeError } from './format';
import type { ConfigEntry } from './useAdminData';

interface VersionsTableProps {
  versions: VersionSummary[];
  configs: Record<number, ConfigEntry>;
  onLoadConfig: (version: number) => void;
  onPublish: (version: number) => void;
  /** Opens a stored, not active version as a preview session. */
  onPreview: (version: number, variant: string) => void;
  busy: boolean;
}

const COLUMNS = 7;

export function VersionsTable({ versions, configs, onLoadConfig, onPublish, onPreview, busy }: VersionsTableProps) {
  const { t, f } = useI18n();
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  const toggle = (version: number) => {
    const next = new Set(open);
    if (next.has(version)) next.delete(version);
    else {
      next.add(version);
      onLoadConfig(version);
    }
    setOpen(next);
  };

  if (versions.length === 0) return <p className="adm-muted">{t.versions.empty}</p>;

  return (
    <>
      <div className="adm-table-wrap">
        <table className="data adm-versions">
          <thead>
            <tr>
              <th scope="col">{t.versions.version}</th>
              <th scope="col">{t.versions.experiment}</th>
              <th scope="col">{t.versions.releaseNote}</th>
              <th scope="col">{t.versions.created}</th>
              <th scope="col" className="num">
                {t.versions.sessions}
              </th>
              <th scope="col">{t.versions.status}</th>
              <th scope="col" className="adm-actions-col">
                <span className="adm-visually-hidden">{t.versions.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              const expanded = open.has(v.version);
              const entry = configs[v.version];
              return (
                <Fragment key={v.version}>
                  <tr data-active={v.isActive || undefined}>
                    <th scope="row" className="adm-version">
                      v{v.version}
                    </th>
                    <td>
                      <span className="mono adm-ellipsis" title={v.experimentId}>
                        {v.experimentId}
                      </span>
                    </td>
                    <td className="adm-note-cell">{v.releaseNote ?? <span className="adm-muted">—</span>}</td>
                    <td className="adm-nowrap">
                      <time dateTime={v.createdAt}>{f.dateTime(v.createdAt)}</time>
                    </td>
                    <td className="num">{v.sessions}</td>
                    <td>
                      {v.isActive ? <span className="badge badge-success">{t.versions.active}</span> : <span className="adm-muted">{t.versions.stored}</span>}
                    </td>
                    <td>
                      <div className="adm-row-actions">
                        {v.isActive
                          ? null
                          : v.variants.map((variant) => (
                              <button key={variant} type="button" className="btn btn-ghost btn-sm" onClick={() => onPreview(v.version, variant)}>
                                {t.versions.preview(variant)} ↗
                              </button>
                            ))}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-expanded={expanded}
                          aria-controls={`adm-json-${v.version}`}
                          onClick={() => toggle(v.version)}
                        >
                          {expanded ? t.versions.hideJson : t.versions.viewJson}
                        </button>
                        {v.isActive ? null : (
                          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onPublish(v.version)}>
                            {t.versions.publish}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="adm-json-row" id={`adm-json-${v.version}`}>
                      <td colSpan={COLUMNS}>
                        <ConfigJson entry={entry} version={v.version} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {versions.some((v) => !v.isActive) ? <p className="adm-hint">{t.versions.previewHint}</p> : null}
    </>
  );
}

function ConfigJson({ entry, version }: { entry: ConfigEntry | undefined; version: number }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  if (!entry || entry.status === 'loading') return <p className="adm-muted">{t.versions.loadingConfig(version)}</p>;
  if (entry.status === 'error') return <p className="adm-error-text">{describeError(entry.error, t).title}</p>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="adm-json">
      <button type="button" className="btn btn-ghost btn-sm adm-copy" onClick={copy}>
        {copied ? t.versions.copied : t.versions.copy}
      </button>
      <pre tabIndex={0} aria-label={t.versions.configOf(version)}>
        {entry.text}
      </pre>
    </div>
  );
}
