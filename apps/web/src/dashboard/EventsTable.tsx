import { Fragment } from 'react';
import type { GroupReport } from '@funnel/contracts';
import { DASH, formatCount } from './format';
import { TableWrap, VariantName } from './parts';

/** Event × variant. Names come from the data, so an event introduced by a new version shows up on its own. */
export function EventsTable({ groups }: { groups: GroupReport[] }) {
  const names = [...new Set(groups.flatMap((g) => g.events.map((e) => e.name)))];
  return (
    <div className="card dash-card">
      <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th rowSpan={2}>Event</th>
              {groups.map((g) => (
                <th key={g.variant} colSpan={2} className="dash-th-group">
                  <VariantName variant={g.variant} />
                </th>
              ))}
            </tr>
            <tr>
              {groups.map((g) => (
                <Fragment key={g.variant}>
                  <th className="num">Sessions</th>
                  <th className="num">Events</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {names.map((name) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                {groups.map((g) => {
                  const stats = g.events.find((e) => e.name === name);
                  return (
                    <Fragment key={g.variant}>
                      <td className="num">{stats ? formatCount(stats.sessions) : DASH}</td>
                      <td className="num">{stats ? formatCount(stats.events) : DASH}</td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
