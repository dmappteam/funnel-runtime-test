import type { AbComparison, GroupReport, ProportionTest, Rate } from '@funnel/contracts';
import {
  formatCount,
  formatInterval,
  formatLift,
  formatPercent,
  formatPp,
  formatPpRange,
  formatPValue,
} from './format';
import { TableWrap, Tile, VariantName, toneClass } from './parts';

const METRIC_LABELS: Record<ProportionTest['metric'], string> = {
  ctaConversion: 'CTA conversion',
  resultRate: 'Result rate',
  ctr: 'CTR',
};

/** The config has no free-text hypothesis, so it is read from the experiment id, e.g. "question-order-and-result-framing-v3". */
function hypothesis(experimentId: string, control: string, treatment: string): string {
  const topic = experimentId.replace(/-v\d+$/, '').replaceAll('-', ' ');
  return `changing the ${topic} in ${treatment} raises CTA conversion over ${control}`;
}

function RateTile({ label, rate, primary }: { label: string; rate: Rate; primary?: boolean }) {
  const detail = rate.value === null ? 'no sessions yet' : `95% CI ${formatInterval(rate.ciLow, rate.ciHigh)}`;
  return <Tile label={label} value={formatPercent(rate.value)} detail={detail} primary={primary} />;
}

function KpiCard({ group, role }: { group: GroupReport; role?: string }) {
  const { kpi } = group;
  return (
    <div className={`card dash-card ${toneClass(group.variant)}`}>
      <div className="dash-card-head">
        <VariantName variant={group.variant} />
        {role && <span className="badge">{role}</span>}
      </div>
      <div className="dash-tiles">
        <Tile label="Started" value={formatCount(kpi.started)} />
        <Tile label="Reached result" value={formatCount(kpi.reachedResult)} />
        <Tile label="CTA clicks" value={formatCount(kpi.ctaClicked)} />
        <RateTile label="Result rate" rate={kpi.resultRate} />
        <RateTile label="CTR" rate={kpi.ctr} />
        <RateTile label="CTA conversion" rate={kpi.ctaConversion} primary />
      </div>
    </div>
  );
}

interface Verdict {
  badge: string;
  tone: 'success' | 'danger' | 'warning' | 'neutral';
  text: string;
}

function verdict(ab: AbComparison): Verdict {
  const { primary, control, treatment, requiredSessionsPerVariant: required } = ab;
  const smaller = Math.min(primary.control.denominator, primary.treatment.denominator);
  if (primary.absDiff === null) {
    return { badge: 'No data', tone: 'warning', text: 'One of the variants has no sessions yet, so there is nothing to compare.' };
  }
  if (primary.significant) {
    const better = primary.absDiff > 0;
    return {
      badge: 'Significant',
      tone: better ? 'success' : 'danger',
      text: `${treatment} converts ${better ? 'better' : 'worse'} than ${control}, and the difference is statistically significant (p < 0.05).`,
    };
  }
  if (required !== null && smaller < required) {
    return {
      badge: 'Not significant',
      tone: 'warning',
      text: `The sample is too small to conclude: a difference of this size needs about ${formatCount(required)} sessions per variant, and the smaller variant has ${formatCount(smaller)}.`,
    };
  }
  return {
    badge: 'Not significant',
    tone: 'neutral',
    text: `No significant difference between ${treatment} and ${control} at the current sample size.`,
  };
}

function PrimaryVerdict({ ab }: { ab: AbComparison }) {
  const { primary, control, treatment, requiredSessionsPerVariant: required } = ab;
  const v = verdict(ab);
  const target = primary.absDiff === null || primary.absDiff === 0 ? 'a 5 p.p. difference' : 'the observed difference';
  return (
    <div className="card dash-card dash-verdict">
      <div className="dash-card-head">
        <span className="dash-verdict-title">
          CTA conversion, {treatment} vs {control}
        </span>
        <span className={v.tone === 'neutral' ? 'badge' : `badge badge-${v.tone}`}>{v.badge}</span>
      </div>
      <div className="dash-verdict-diff">{formatPp(primary.absDiff)}</div>
      <p className="dash-verdict-text">{v.text}</p>
      <dl className="dash-facts">
        <div>
          <dt>95% CI of the difference</dt>
          <dd>{formatPpRange(primary.diffCiLow, primary.diffCiHigh)}</dd>
        </div>
        <div>
          <dt>Relative lift</dt>
          <dd>{formatLift(primary.relativeLift)}</dd>
        </div>
        <div>
          <dt>p-value</dt>
          <dd>{formatPValue(primary.pValue)}</dd>
        </div>
        <div>
          <dt>Sample size</dt>
          <dd>
            {required === null ? '—' : `≈${formatCount(required)} sessions per variant needed`}
            <span className="dash-facts-note">
              to detect {target} with 80% power at α = 0.05; {control} has {formatCount(primary.control.denominator)},{' '}
              {treatment} has {formatCount(primary.treatment.denominator)}
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function SecondaryTable({ ab }: { ab: AbComparison }) {
  return (
    <div className="card dash-card">
      <div className="dash-card-head">
        <span className="dash-card-title">Secondary metrics</span>
      </div>
      <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">{ab.control}</th>
              <th className="num">{ab.treatment}</th>
              <th className="num">Difference</th>
              <th className="num">95% CI</th>
              <th className="num">p-value</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {ab.secondary.map((t) => (
              <tr key={t.metric}>
                <td>{METRIC_LABELS[t.metric]}</td>
                <td className="num">{formatPercent(t.control.value)}</td>
                <td className="num">{formatPercent(t.treatment.value)}</td>
                <td className="num">{formatPp(t.absDiff)}</td>
                <td className="num">{formatPpRange(t.diffCiLow, t.diffCiHigh)}</td>
                <td className="num">{formatPValue(t.pValue)}</td>
                <td>
                  <span className={t.significant ? 'badge badge-accent' : 'badge'}>{t.significant ? 'Significant' : 'Not significant'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

/** KPI tiles per variant and the verdict on the primary metric for one version. */
export function AbSection({ groups, ab }: { groups: GroupReport[]; ab: AbComparison | null }) {
  const roles: Record<string, string> = ab ? { [ab.control]: 'control', [ab.treatment]: 'treatment' } : {};
  return (
    <>
      {ab ? (
        <p className="dash-lead">
          <strong>Hypothesis:</strong> {hypothesis(ab.experimentId, ab.control, ab.treatment)}.{' '}
          <strong>Primary metric:</strong> CTA conversion = sessions with a CTA click ÷ started sessions.
        </p>
      ) : (
        <p className="dash-lead">
          Only {groups.map((g) => `variant ${g.variant}`).join(', ')} has sessions with these filters, so there is nothing to compare.
        </p>
      )}
      <div className="dash-grid-2">
        {groups.map((g) => (
          <KpiCard key={g.variant} group={g} role={roles[g.variant]} />
        ))}
      </div>
      {ab && (
        <div className="dash-grid-2">
          <PrimaryVerdict ab={ab} />
          <SecondaryTable ab={ab} />
        </div>
      )}
    </>
  );
}
