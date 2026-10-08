import type { ReleaseEntry } from '@funnel/contracts';
import { useI18n } from '../internal/i18n';

/** Newest first, as returned by the API. */
export function ReleaseLog({ releases }: { releases: ReleaseEntry[] }) {
  const { t, f } = useI18n();
  if (releases.length === 0) return <p className="adm-muted">{t.releaseLog.empty}</p>;
  return (
    <ol className="adm-log">
      {releases.map((release) => (
        <li key={release.id}>
          <span className={`badge ${release.action === 'rollback' ? 'badge-warning' : 'badge-accent'}`}>{t.releaseLog[release.action]}</span>
          <span className="adm-log-change">
            {release.fromVersion === null ? t.releaseLog.none : `v${release.fromVersion}`} → <strong>v{release.version}</strong>
          </span>
          <time className="adm-log-time" dateTime={release.createdAt}>
            {f.dateTime(release.createdAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}
