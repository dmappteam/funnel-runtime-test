import { Fragment } from 'react';
import type { ConfigDiff } from '@funnel/engine';
import { useI18n } from '../internal/i18n';

function Changes({ added, removed, extra }: { added: string[]; removed: string[]; extra?: string | null }) {
  const { t } = useI18n();
  if (added.length === 0 && removed.length === 0 && !extra) return <span className="adm-muted">{t.diff.noChange}</span>;
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
  const { t } = useI18n();
  const rows: Array<[string, string[], string[]]> = [
    [t.diff.steps, diff.stepsAdded, diff.stepsRemoved],
    [t.diff.results, diff.resultsAdded, diff.resultsRemoved],
    [t.diff.events, diff.eventsAdded, diff.eventsRemoved],
    [t.diff.operators, diff.operatorsAdded, operatorsRemoved],
  ];
  return (
    <section className="adm-diff-block" aria-labelledby="adm-diff-title">
      <h3 id="adm-diff-title">{t.diff.title(diff.fromVersion, diff.toVersion)}</h3>
      <dl className="adm-diff">
        <dt>{t.diff.experiment}</dt>
        <dd>
          {diff.experimentChanged ? (
            <span className="adm-chip adm-chip--warn">{t.diff.newExperiment}</span>
          ) : (
            <span className="adm-muted">{t.diff.sameExperiment}</span>
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
            <dt>{t.common.variant(variant.variant)}</dt>
            <dd>
              <Changes
                added={variant.stepsAdded}
                removed={variant.stepsRemoved}
                extra={variant.orderChanged ? t.diff.orderChanged : null}
              />
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}
