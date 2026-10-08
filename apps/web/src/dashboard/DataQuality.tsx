import type { AnalyticsResponse } from '@funnel/contracts';
import { useI18n } from '../internal/i18n';
import { TableWrap, Tile } from './parts';

export function DataQuality({ report }: { report: AnalyticsResponse }) {
  const { t, f } = useI18n();
  const { totals, filters } = report;
  const ingestion = report.ingestion ?? { rejected: 0, rejectedByReason: {} };
  const reasons = Object.entries(ingestion.rejectedByReason).sort(([, a], [, b]) => b - a);
  const reasonLabel = (reason: string) => (Object.hasOwn(t.quality.reasons, reason) ? t.quality.reasons[reason as keyof typeof t.quality.reasons] : reason);
  // `totals` ignore the version filter: they cover every version in the current campaign.
  const scope = t.quality.scope;
  return (
    <div className="card dash-card">
      <div className="dash-tiles dash-tiles-auto">
        <Tile label={t.quality.events} value={f.count(totals.events)} detail={t.quality.eventsDetail(scope)} />
        <Tile label={t.quality.sessions} value={f.count(totals.sessions)} detail={scope} />
        <Tile
          label={t.quality.overrides}
          value={f.count(totals.overrideSessions)}
          detail={t.quality.overridesDetail(scope, filters.includeOverrides)}
        />
        <Tile label={t.quality.previews} value={f.count(totals.previewSessions)} detail={t.quality.previewsDetail} />
        <Tile label={t.quality.rejected} value={f.count(ingestion.rejected)} detail={t.quality.rejectedDetail} />
      </div>
      {reasons.length === 0 ? (
        <p className="muted">{t.quality.noneRejected}</p>
      ) : (
        <TableWrap>
          <table className="data">
            <thead>
              <tr>
                <th>{t.quality.reason}</th>
                <th>{t.quality.code}</th>
                <th className="num">{t.events.events}</th>
              </tr>
            </thead>
            <tbody>
              {reasons.map(([reason, count]) => (
                <tr key={reason}>
                  <td>{reasonLabel(reason)}</td>
                  <td className="mono">{reason}</td>
                  <td className="num">{f.count(count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}
