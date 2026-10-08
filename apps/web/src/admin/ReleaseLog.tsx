import type { ReleaseEntry } from '@funnel/contracts';
import { formatDateTime } from './format';

/** Newest first, as returned by the API. */
export function ReleaseLog({ releases }: { releases: ReleaseEntry[] }) {
  if (releases.length === 0) return <p className="adm-muted">No releases yet.</p>;
  return (
    <ol className="adm-log">
      {releases.map((release) => (
        <li key={release.id}>
          <span className={`badge ${release.action === 'rollback' ? 'badge-warning' : 'badge-accent'}`}>{release.action}</span>
          <span className="adm-log-change">
            {release.fromVersion === null ? 'none' : `v${release.fromVersion}`} → <strong>v{release.version}</strong>
          </span>
          <time className="adm-log-time" dateTime={release.createdAt}>
            {formatDateTime(release.createdAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}
