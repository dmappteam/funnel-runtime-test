import type { VersionReport } from '@funnel/contracts';
import { useI18n } from '../internal/i18n';
import { TableWrap } from './parts';

/** All variants combined, one row per version. */
export function VersionsTable({ versions, selected }: { versions: VersionReport[]; selected: number | null }) {
  const { t, f } = useI18n();
  return (
    <div className="card dash-card">
      <p className="dash-note">{t.dashVersions.note}</p>
      <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th>{t.dashVersions.version}</th>
              <th>{t.dashVersions.experiment}</th>
              <th>{t.dashVersions.firstSeen}</th>
              <th>{t.dashVersions.lastSeen}</th>
              <th className="num">{t.dashVersions.started}</th>
              <th className="num">{t.dashVersions.resultRate}</th>
              <th className="num">{t.dashVersions.ctr}</th>
              <th className="num">{t.dashVersions.ctaConversion}</th>
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
                <td className="dash-nowrap">{f.dateTime(v.firstSeen)}</td>
                <td className="dash-nowrap">{f.dateTime(v.lastSeen)}</td>
                <td className="num">{f.count(v.kpi.started)}</td>
                <td className="num">{f.percent(v.kpi.resultRate.value)}</td>
                <td className="num">{f.percent(v.kpi.ctr.value)}</td>
                <td className="num">{f.percent(v.kpi.ctaConversion.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
