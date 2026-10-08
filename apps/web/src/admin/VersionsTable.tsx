import { Fragment, useState } from 'react';
import type { VersionSummary } from '@funnel/contracts';
import { formatDateTime } from './format';
import type { ConfigEntry } from './useAdminData';

interface VersionsTableProps {
  versions: VersionSummary[];
  configs: Record<number, ConfigEntry>;
  onLoadConfig: (version: number) => void;
  onPublish: (version: number) => void;
  busy: boolean;
}

const COLUMNS = 7;

export function VersionsTable({ versions, configs, onLoadConfig, onPublish, busy }: VersionsTableProps) {
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

  if (versions.length === 0) return <p className="adm-muted">No versions stored yet. Upload a config below.</p>;

  return (
    <div className="adm-table-wrap">
      <table className="data adm-versions">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Experiment</th>
            <th scope="col">Release note</th>
            <th scope="col">Created</th>
            <th scope="col" className="num">
              Sessions
            </th>
            <th scope="col">Status</th>
            <th scope="col" className="adm-actions-col">
              <span className="adm-visually-hidden">Actions</span>
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
                    <time dateTime={v.createdAt}>{formatDateTime(v.createdAt)}</time>
                  </td>
                  <td className="num">{v.sessions}</td>
                  <td>{v.isActive ? <span className="badge badge-success">Active</span> : <span className="adm-muted">Stored</span>}</td>
                  <td>
                    <div className="adm-row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-expanded={expanded}
                        aria-controls={`adm-json-${v.version}`}
                        onClick={() => toggle(v.version)}
                      >
                        {expanded ? 'Hide JSON' : 'View JSON'}
                      </button>
                      {v.isActive ? null : (
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onPublish(v.version)}>
                          Publish
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
  );
}

function ConfigJson({ entry, version }: { entry: ConfigEntry | undefined; version: number }) {
  const [copied, setCopied] = useState(false);
  if (!entry || entry.status === 'loading') return <p className="adm-muted">Loading v{version}…</p>;
  if (entry.status === 'error') return <p className="adm-error-text">{entry.problem.title}</p>;

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
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre tabIndex={0} aria-label={`Config of version ${version}`}>
        {entry.text}
      </pre>
    </div>
  );
}
