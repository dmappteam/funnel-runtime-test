import type { GroupReport } from '@funnel/contracts';
import { formatCount, formatPercent } from './format';
import { Bar, VariantName, toneClass } from './parts';

function ResultsCard({ group }: { group: GroupReport }) {
  const total = group.results.reduce((sum, r) => sum + r.sessions, 0);
  return (
    <div className={`card dash-card ${toneClass(group.variant)}`}>
      <div className="dash-card-head">
        <VariantName variant={group.variant} />
        <span className="muted">{formatCount(total)} sessions with a result</span>
      </div>
      {total === 0 ? (
        <p className="muted">No result viewed yet.</p>
      ) : (
        <ul className="dash-results">
          {group.results.map((r) => (
            <li key={r.resultId}>
              <span className="mono dash-result-id">{r.resultId}</span>
              <Bar value={r.sessions / total} title={`${formatCount(r.sessions)} of ${formatCount(total)} sessions`} />
              <span className="dash-result-value">
                {formatCount(r.sessions)} <span className="muted">· {formatPercent(r.sessions / total)}</span>
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
