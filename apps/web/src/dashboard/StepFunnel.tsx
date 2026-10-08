import type { GroupReport, StepMetrics } from '@funnel/contracts';
import { DASH, formatCount, formatPercent } from './format';
import { Bar, TableWrap, VariantName, toneClass } from './parts';

/** The step that loses the most sessions; ties go to the higher drop-off rate. */
function worstStepId(steps: StepMetrics[]): string | null {
  let worst: StepMetrics | null = null;
  for (const s of steps) {
    if (s.type === 'result' || s.dropoff === 0) continue;
    if (!worst || s.dropoff > worst.dropoff || (s.dropoff === worst.dropoff && (s.dropoffRate ?? 0) > (worst.dropoffRate ?? 0))) {
      worst = s;
    }
  }
  return worst?.stepId ?? null;
}

function FunnelCard({ group }: { group: GroupReport }) {
  const worst = worstStepId(group.steps);
  return (
    <div className={`card dash-card ${toneClass(group.variant)}`}>
      <div className="dash-card-head">
        <VariantName variant={group.variant} />
        <span className="muted">{formatCount(group.kpi.started)} started</span>
      </div>
      {group.steps.length === 0 ? (
        <p className="muted">The config of this version is unavailable, so its steps cannot be laid out.</p>
      ) : (
        <TableWrap>
          <table className="data dash-funnel">
            <thead>
              <tr>
                <th>Step</th>
                <th className="num">Reached</th>
                <th>From start</th>
                <th className="num">To next</th>
                <th className="num">Drop-off</th>
              </tr>
            </thead>
            <tbody>
              {group.steps.map((s) => {
                const final = s.type === 'result';
                const isWorst = s.stepId === worst;
                return (
                  <tr key={s.stepId} className={isWorst ? 'dash-worst' : undefined}>
                    <td>
                      <div className="dash-step">
                        <span className="dash-step-pos">{s.position + 1}</span>
                        <span className="mono">{s.stepId}</span>
                      </div>
                      <div className="dash-step-badges">
                        <span className="badge">{s.type}</span>
                        {s.conditional && (
                          <span className="badge badge-warning" title="Shown only to sessions whose answers meet its visibleWhen condition">
                            conditional
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="num">{formatCount(s.reached)}</td>
                    <td>
                      <div className="dash-bar-cell">
                        <Bar
                          value={s.reachedFromStart}
                          title={`${formatCount(s.reached)} of ${formatCount(group.kpi.started)} started sessions`}
                        />
                        <span className="dash-bar-value">{formatPercent(s.reachedFromStart)}</span>
                      </div>
                    </td>
                    <td className="num">{final ? DASH : formatPercent(s.conversion)}</td>
                    <td className="num">
                      {final ? (
                        DASH
                      ) : (
                        <>
                          {formatCount(s.dropoff)} <span className="muted">· {formatPercent(s.dropoffRate)}</span>
                        </>
                      )}
                      {isWorst && <span className="badge badge-danger dash-worst-badge">Biggest drop-off</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

/** One table per variant, side by side, each in the variant's own step order. */
export function StepFunnel({ groups }: { groups: GroupReport[] }) {
  return (
    <>
      <p className="dash-lead">
        <strong>To next</strong> = sessions that got past the step ÷ sessions that reached it, so a conditional step has its own
        denominator. <strong>Drop-off</strong> = sessions whose furthest step it was and that never saw a result.
      </p>
      <div className="dash-grid-2">
        {groups.map((g) => (
          <FunnelCard key={g.variant} group={g} />
        ))}
      </div>
    </>
  );
}
