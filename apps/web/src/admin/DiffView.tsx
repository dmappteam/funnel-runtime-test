import { Fragment } from 'react';
import type { ConfigDiff } from '@funnel/engine';

function Changes({ added, removed, extra }: { added: string[]; removed: string[]; extra?: string | null }) {
  if (added.length === 0 && removed.length === 0 && !extra) return <span className="adm-muted">No change</span>;
  return (
    <>
      {added.map((id) => (
        <span key={`+${id}`} className="adm-chip adm-chip--add">
          + {id}
        </span>
      ))}
      {removed.map((id) => (
        <span key={`-${id}`} className="adm-chip adm-chip--remove">
          − {id}
        </span>
      ))}
      {extra ? <span className="adm-chip">{extra}</span> : null}
    </>
  );
}

interface DiffViewProps {
  diff: ConfigDiff;
  /** Not part of the server diff: computed in the browser from both configs. */
  operatorsRemoved: string[];
}

/** What changes for users if this config replaces the active version. */
export function DiffView({ diff, operatorsRemoved }: DiffViewProps) {
  const rows: Array<[string, string[], string[]]> = [
    ['Steps', diff.stepsAdded, diff.stepsRemoved],
    ['Results', diff.resultsAdded, diff.resultsRemoved],
    ['Events', diff.eventsAdded, diff.eventsRemoved],
    ['Operators', diff.operatorsAdded, operatorsRemoved],
  ];
  return (
    <section className="adm-diff-block" aria-labelledby="adm-diff-title">
      <h3 id="adm-diff-title">
        Changes against active v{diff.fromVersion} → v{diff.toVersion}
      </h3>
      <dl className="adm-diff">
        <dt>Experiment</dt>
        <dd>
          {diff.experimentChanged ? (
            <span className="adm-chip adm-chip--warn">new experiment id: results are compared separately</span>
          ) : (
            <span className="adm-muted">Same experiment id</span>
          )}
        </dd>
        {rows.map(([label, added, removed]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>
              <Changes added={added} removed={removed} />
            </dd>
          </Fragment>
        ))}
        {diff.variants.map((variant) => (
          <Fragment key={variant.variant}>
            <dt>Variant {variant.variant}</dt>
            <dd>
              <Changes
                added={variant.stepsAdded}
                removed={variant.stepsRemoved}
                extra={variant.orderChanged ? 'order changed' : null}
              />
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}
