import { useState } from 'react';
import type { GroupReport, StepMetrics } from '@funnel/contracts';
import { DASH } from '../internal/format';
import { useI18n } from '../internal/i18n';
import { Bar, TableWrap, VariantName, toneClass } from './parts';

/** The step that loses the most sessions; ties go to the higher drop-off rate. */
function worstStepId(steps: StepMetrics[]): string | null {
  let worst: StepMetrics | null = null;
  for (const s of steps) {
    if (s.dropoff === 0) continue;
    if (!worst || s.dropoff > worst.dropoff || (s.dropoff === worst.dropoff && (s.dropoffRate ?? 0) > (worst.dropoffRate ?? 0))) {
      worst = s;
    }
  }
  return worst?.stepId ?? null;
}

export type StepOrder = 'steps' | 'dropoff' | 'reached';

const ORDERS: readonly StepOrder[] = ['steps', 'dropoff', 'reached'];

/** Path order as configured, or the steps losing / reaching the most sessions first. Ties keep the path order. */
export function sortSteps(steps: readonly StepMetrics[], order: StepOrder): StepMetrics[] {
  const byPath = (a: StepMetrics, b: StepMetrics) => a.position - b.position;
  if (order === 'dropoff') {
    return steps.toSorted((a, b) => b.dropoff - a.dropoff || (b.dropoffRate ?? 0) - (a.dropoffRate ?? 0) || byPath(a, b));
  }
  if (order === 'reached') return steps.toSorted((a, b) => b.reached - a.reached || byPath(a, b));
  return steps.toSorted(byPath);
}

function FunnelCard({ group, order }: { group: GroupReport; order: StepOrder }) {
  const { t, f } = useI18n();
  const worst = worstStepId(group.steps);
  return (
    <div className={`card dash-card ${toneClass(group.variant)}`}>
      <div className="dash-card-head">
        <VariantName variant={group.variant} />
        <span className="muted">{t.funnel.started(f.count(group.kpi.started))}</span>
      </div>
      {group.steps.length === 0 ? (
        <p className="muted">{t.funnel.noConfig}</p>
      ) : (
        <TableWrap>
          <table className="data dash-funnel">
            <thead>
              <tr>
                <th>{t.funnel.step}</th>
                <th className="num">{t.funnel.reached}</th>
                <th>{t.funnel.fromStart}</th>
                <th className="num">{t.funnel.toNext}</th>
                <th className="num">{t.funnel.dropoff}</th>
              </tr>
            </thead>
            <tbody>
              {sortSteps(group.steps, order).map((s) => {
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
                          <span className="badge badge-warning" title={t.funnel.conditionalHint}>
                            {t.funnel.conditional}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="num">{f.count(s.reached)}</td>
                    <td>
                      <div className="dash-bar-cell">
                        <Bar
                          value={s.reachedFromStart}
                          title={t.funnel.reachedOf(f.count(s.reached), f.count(group.kpi.started))}
                        />
                        <span className="dash-bar-value">{f.percent(s.reachedFromStart)}</span>
                      </div>
                    </td>
                    <td className="num">{final ? DASH : f.percent(s.conversion)}</td>
                    <td className="num">
                      {f.count(s.dropoff)} <span className="muted">· {f.percent(s.dropoffRate)}</span>
                      {isWorst && <span className="badge badge-danger dash-worst-badge">{t.funnel.worst}</span>}
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

/** One table per variant, side by side. By default each follows the variant's own step order; the number keeps a step's place in it. */
export function StepFunnel({ groups }: { groups: GroupReport[] }) {
  const { t } = useI18n();
  const { lead } = t.funnel;
  const [order, setOrder] = useState<StepOrder>('steps');
  return (
    <>
      <p className="dash-lead">
        <strong>{lead.toNext}</strong>
        {lead.toNextText}
        <strong>{lead.dropoff}</strong>
        {lead.dropoffText}
      </p>
      <div className="dash-order">
        <span className="muted">{t.funnel.order}</span>
        <div className="segmented" role="group" aria-label={t.funnel.order}>
          {ORDERS.map((option) => (
            <button key={option} type="button" aria-pressed={order === option} onClick={() => setOrder(option)}>
              {t.funnel.orders[option]}
            </button>
          ))}
        </div>
      </div>
      <div className="dash-grid-2">
        {groups.map((g) => (
          <FunnelCard key={g.variant} group={g} order={order} />
        ))}
      </div>
    </>
  );
}
