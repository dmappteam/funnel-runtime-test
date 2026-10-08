import type { AbComparison, ExperimentEta, GroupReport, Rate, SampleRatioCheck } from '@funnel/contracts';
import type { Messages } from '../internal/en';
import type { Format } from '../internal/format';
import { useI18n } from '../internal/i18n';
import { Tile, TableWrap, VariantName, toneClass } from './parts';

/** The config has no free-text hypothesis, so its topic is read from the experiment id, e.g. "question-order-and-result-framing-v3". */
function topicOf(experimentId: string): string {
  return experimentId.replace(/-v\d+$/, '').replaceAll('-', ' ');
}

function RateTile({ label, rate, primary }: { label: string; rate: Rate; primary?: boolean }) {
  const { t, f } = useI18n();
  const detail = rate.value === null ? t.ab.noSessionsYet : t.ab.ci(f.interval(rate.ciLow, rate.ciHigh));
  return <Tile label={label} value={f.percent(rate.value)} detail={detail} primary={primary} />;
}

function KpiCard({ group, role }: { group: GroupReport; role?: string }) {
  const { t, f } = useI18n();
  const { kpi } = group;
  return (
    <div className={`card dash-card ${toneClass(group.variant)}`}>
      <div className="dash-card-head">
        <VariantName variant={group.variant} />
        {role && <span className="badge">{role}</span>}
      </div>
      <div className="dash-tiles">
        <Tile label={t.ab.started} value={f.count(kpi.started)} />
        <Tile label={t.ab.reachedResult} value={f.count(kpi.reachedResult)} />
        <Tile label={t.ab.ctaClicks} value={f.count(kpi.ctaClicked)} />
        <RateTile label={t.ab.metrics.resultRate} rate={kpi.resultRate} />
        <RateTile label={t.ab.metrics.ctr} rate={kpi.ctr} />
        <RateTile label={t.ab.metrics.ctaConversion} rate={kpi.ctaConversion} primary />
      </div>
    </div>
  );
}

interface Verdict {
  badge: string;
  tone: 'success' | 'danger' | 'warning' | 'neutral';
  text: string;
}

function verdict(ab: AbComparison, t: Messages, f: Format): Verdict {
  const { primary, control, treatment, requiredSessionsPerVariant: required, srm } = ab;
  const smaller = Math.min(primary.control.denominator, primary.treatment.denominator);
  // A broken split invalidates the comparison, whatever it shows.
  if (srm.mismatch) return { badge: t.ab.mismatch, tone: 'danger', text: t.ab.mismatchText(f.pValue(srm.pValue)) };
  if (primary.absDiff === null) return { badge: t.ab.noData, tone: 'warning', text: t.ab.noDataText };
  if (primary.significant) {
    const better = primary.absDiff > 0;
    return { badge: t.ab.significant, tone: better ? 'success' : 'danger', text: t.ab.significantText(treatment, better, control) };
  }
  if (required !== null && smaller < required) {
    return { badge: t.ab.notSignificant, tone: 'warning', text: t.ab.smallSampleText(f.count(required), f.count(smaller)) };
  }
  return { badge: t.ab.notSignificant, tone: 'neutral', text: t.ab.noDifferenceText(treatment, control) };
}

/** "A 51.0% · B 49.0%" and what the weights expect. */
function SplitFact({ srm }: { srm: SampleRatioCheck }) {
  const { t, f } = useI18n();
  const total = srm.variants.reduce((sum, v) => sum + v.sessions, 0);
  const observed = srm.variants.map((v) => `${v.variant} ${f.percent(total > 0 ? v.sessions / total : null)}`).join(' · ');
  const expected = srm.variants.map((v) => `${v.variant} ${f.percent(v.expectedShare)}`).join(' · ');
  const check =
    srm.pValue === null ? t.ab.splitUnchecked : srm.mismatch ? t.ab.splitMismatch(f.pValue(srm.pValue)) : t.ab.splitOk(f.pValue(srm.pValue));
  return (
    <div>
      <dt>{t.ab.split}</dt>
      <dd>
        {observed}
        <span className="dash-facts-note">
          {t.ab.splitExpected(expected)}; {check}
        </span>
      </dd>
    </div>
  );
}

function EtaFact({ eta, control, treatment }: { eta: ExperimentEta; control: string; treatment: string }) {
  const { t, f } = useI18n();
  const [value, note] =
    eta.status === 'reached'
      ? [t.ab.etaReached, t.ab.etaReachedNote(control, treatment)]
      : eta.status === 'collecting' && eta.daysLeft !== null && eta.sessionsPerDay !== null
        ? [f.duration(eta.daysLeft), t.ab.etaRate(f.count(Math.round(eta.sessionsPerDay)))]
        : eta.status === 'stopped'
          ? [t.ab.etaStopped, t.ab.etaStoppedNote]
          : ['—', t.ab.etaUnknownNote];
  return (
    <div>
      <dt>{t.ab.eta}</dt>
      <dd>
        {value}
        <span className="dash-facts-note">{note}</span>
      </dd>
    </div>
  );
}

function PrimaryVerdict({ ab }: { ab: AbComparison }) {
  const { t, f } = useI18n();
  const { primary, control, treatment, requiredSessionsPerVariant: required } = ab;
  const v = verdict(ab, t, f);
  const target = primary.absDiff === null || primary.absDiff === 0 ? t.ab.targetFallback : t.ab.targetObserved;
  return (
    <div className="card dash-card dash-verdict">
      <div className="dash-card-head">
        <span className="dash-verdict-title">{t.ab.verdictTitle(treatment, control)}</span>
        <span className={v.tone === 'neutral' ? 'badge' : `badge badge-${v.tone}`}>{v.badge}</span>
      </div>
      <div className="dash-verdict-diff">{f.pp(primary.absDiff)}</div>
      <p className="dash-verdict-text">{v.text}</p>
      <dl className="dash-facts">
        <div>
          <dt>{t.ab.diffCi}</dt>
          <dd>{f.ppRange(primary.diffCiLow, primary.diffCiHigh)}</dd>
        </div>
        <div>
          <dt>{t.ab.relativeLift}</dt>
          <dd>{f.lift(primary.relativeLift)}</dd>
        </div>
        <div>
          <dt>{t.ab.pValue}</dt>
          <dd>{f.pValue(primary.pValue)}</dd>
        </div>
        <div>
          <dt>{t.ab.sampleSize}</dt>
          <dd>
            {required === null ? '—' : t.ab.sampleNeeded(f.count(required))}
            <span className="dash-facts-note">
              {t.ab.sampleNote(target, control, f.count(primary.control.denominator), treatment, f.count(primary.treatment.denominator))}
            </span>
          </dd>
        </div>
        <SplitFact srm={ab.srm} />
        <EtaFact eta={ab.eta} control={control} treatment={treatment} />
      </dl>
    </div>
  );
}

function SecondaryTable({ ab }: { ab: AbComparison }) {
  const { t, f } = useI18n();
  return (
    <div className="card dash-card">
      <div className="dash-card-head">
        <span className="dash-card-title">{t.ab.secondary}</span>
      </div>
      <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th>{t.ab.metric}</th>
              <th className="num">{ab.control}</th>
              <th className="num">{ab.treatment}</th>
              <th className="num">{t.ab.difference}</th>
              <th className="num">{t.ab.ciShort}</th>
              <th className="num">{t.ab.pValue}</th>
              <th>{t.ab.result}</th>
            </tr>
          </thead>
          <tbody>
            {ab.secondary.map((test) => (
              <tr key={test.metric}>
                <td>{t.ab.metrics[test.metric]}</td>
                <td className="num">{f.percent(test.control.value)}</td>
                <td className="num">{f.percent(test.treatment.value)}</td>
                <td className="num">{f.pp(test.absDiff)}</td>
                <td className="num">{f.ppRange(test.diffCiLow, test.diffCiHigh)}</td>
                <td className="num">{f.pValue(test.pValue)}</td>
                <td>
                  <span className={test.significant ? 'badge badge-accent' : 'badge'}>
                    {test.significant ? t.ab.significant : t.ab.notSignificant}
                  </span>
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
  const { t } = useI18n();
  const roles: Record<string, string> = ab ? { [ab.control]: t.ab.control, [ab.treatment]: t.ab.treatment } : {};
  return (
    <>
      {ab ? (
        <p className="dash-lead">
          <strong>{t.ab.hypothesisLabel}</strong> {t.ab.hypothesis(topicOf(ab.experimentId), ab.control, ab.treatment)}.{' '}
          <strong>{t.ab.primaryLabel}</strong> {t.ab.primary}
        </p>
      ) : (
        <p className="dash-lead">{t.ab.onlyVariants(groups.map((g) => t.ab.variantName(g.variant)).join(', '))}</p>
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
