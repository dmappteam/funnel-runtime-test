import type { VersionReport } from '@funnel/contracts';
import { formatCount, formatDateTime, formatPercent } from './format';
import { TableWrap } from './parts';

/** All variants combined, one row per version. */
export function VersionsTable({ versions, selected }: { versions: VersionReport[]; selected: number | null }) {
  return (
    <div className="card dash-card">
      <p className="dash-note">
        Versions ran at different times on different traffic, so this table is context, not a controlled comparison. Use the A/B
        test within a version to judge a change.
      </p>
      <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th>Version</th>
              <th>Experiment</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th className="num">Started</th>
              <th className="num">Result rate</th>
              <th className="num">CTR</th>
              <th className="num">CTA conversion</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version} className={v.version === selected ? 'dash-selected' : undefined}>
                <td>
                  <strong>v{v.version}</strong>
                </td>
                <td>
                  <span className="mono">{v.experimentId}</span>{' '}
                  <span className="muted">({v.variants.join(', ')})</span>
                </td>
                <td className="dash-nowrap">{formatDateTime(v.firstSeen)}</td>
                <td className="dash-nowrap">{formatDateTime(v.lastSeen)}</td>
                <td className="num">{formatCount(v.kpi.started)}</td>
                <td className="num">{formatPercent(v.kpi.resultRate.value)}</td>
                <td className="num">{formatPercent(v.kpi.ctr.value)}</td>
                <td className="num">{formatPercent(v.kpi.ctaConversion.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
