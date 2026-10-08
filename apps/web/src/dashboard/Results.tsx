import type { GroupReport } from '@funnel/contracts';
import { useI18n } from '../internal/i18n';
import { Bar, VariantName, toneClass } from './parts';

function ResultsCard({ group }: { group: GroupReport }) {
  const { t, f } = useI18n();
  const total = group.results.reduce((sum, r) => sum + r.sessions, 0);
  return (
    <div className={`card dash-card ${toneClass(group.variant)}`}>
      <div className="dash-card-head">
        <VariantName variant={group.variant} />
        <span className="muted">{t.results.withResult(f.count(total))}</span>
      </div>
      {total === 0 ? (
        <p className="muted">{t.results.none}</p>
      ) : (
        <ul className="dash-results">
          {group.results.map((r) => (
            <li key={r.resultId}>
              <span className="mono dash-result-id">{r.resultId}</span>
              <Bar value={r.sessions / total} title={t.results.share(f.count(r.sessions), f.count(total))} />
              <span className="dash-result-value">
                {f.count(r.sessions)} <span className="muted">· {f.percent(r.sessions / total)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Final result per session: the latest result it saw. */
export function Results({ groups }: { groups: GroupReport[] }) {
  return (
    <div className="dash-grid-2">
      {groups.map((g) => (
        <ResultsCard key={g.variant} group={g} />
      ))}
    </div>
  );
}
