import type { ConfigIssue } from '@funnel/engine';
import { useI18n } from '../internal/i18n';
import type { Problem } from './format';

export type Notice =
  | ({ tone: 'success' | 'info'; link?: { href: string; label: string } } & Pick<Problem, 'title' | 'detail'>)
  | ({ tone: 'danger' } & Problem);

export function IssueList({ issues, tone }: { issues: ConfigIssue[]; tone: 'error' | 'warning' }) {
  return (
    <ul className={`adm-issues adm-issues--${tone}`}>
      {issues.map((issue, i) => (
        <li key={`${issue.path}:${i}`}>
          <code>{issue.path || '(root)'}</code>
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function Callout({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  const { t } = useI18n();
  const problem = notice.tone === 'danger' ? notice : null;
  const link = notice.tone === 'danger' ? undefined : notice.link;
  return (
    <div className={`adm-callout adm-callout--${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'}>
      <div className="adm-callout-body">
        <strong>{notice.title}</strong>
        {notice.detail ? <p>{notice.detail}</p> : null}
        {link ? (
          <p>
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label} ↗
            </a>
          </p>
        ) : null}
        {problem?.errors?.length ? <IssueList issues={problem.errors} tone="error" /> : null}
        {problem?.warnings?.length ? <IssueList issues={problem.warnings} tone="warning" /> : null}
      </div>
      {onDismiss ? (
        <button type="button" className="adm-callout-close" onClick={onDismiss} aria-label={t.common.dismiss}>
          ×
        </button>
      ) : null}
    </div>
  );
}
