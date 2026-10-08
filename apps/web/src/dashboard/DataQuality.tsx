import type { AnalyticsResponse, RejectReason } from '@funnel/contracts';
import { formatCount } from './format';
import { TableWrap, Tile } from './parts';

const REASONS: Record<RejectReason, string> = {
  invalid_payload: 'Malformed event',
  unknown_session: 'Unknown session',
  server_only_event: 'Server-only event sent by a client',
  event_not_allowed: 'Not allowed by the pinned version',
  unknown_step: "Step not in the session's variant",
  invalid_properties: 'Invalid properties',
};

const reasonLabel = (reason: string) => (Object.hasOwn(REASONS, reason) ? REASONS[reason as RejectReason] : reason);

/** `totals` ignore the version filter: they cover every version in the current campaign. */
const SCOPE = 'all versions, current campaign';

export function DataQuality({ report }: { report: AnalyticsResponse }) {
  const { totals, filters } = report;
  const ingestion = report.ingestion ?? { rejected: 0, rejectedByReason: {} };
  const reasons = Object.entries(ingestion.rejectedByReason).sort(([, a], [, b]) => b - a);
  return (
    <div className="card dash-card">
      <div className="dash-tiles dash-tiles-4">
        <Tile label="Events" value={formatCount(totals.events)} detail={`unique event ids, ${SCOPE}`} />
        <Tile label="Sessions" value={formatCount(totals.sessions)} detail={SCOPE} />
        <Tile
          label="QA override sessions"
          value={formatCount(totals.overrideSessions)}
          detail={`${SCOPE}, ${filters.includeOverrides ? 'included in' : 'excluded from'} the numbers`}
        />
        <Tile label="Rejected events" value={formatCount(ingestion.rejected)} detail="refused at ingestion" />
      </div>
      {reasons.length === 0 ? (
        <p className="muted">No events were rejected.</p>
      ) : (
        <TableWrap>
          <table className="data">
            <thead>
              <tr>
                <th>Reason</th>
                <th>Code</th>
                <th className="num">Events</th>
              </tr>
            </thead>
            <tbody>
              {reasons.map(([reason, count]) => (
                <tr key={reason}>
                  <td>{reasonLabel(reason)}</td>
                  <td className="mono">{reason}</td>
                  <td className="num">{formatCount(count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}
