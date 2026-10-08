import { resolveVariant, type FunnelConfig, type StepType } from '@funnel/engine';
import { listOrder } from './util';

export interface StepInfo {
  id: string;
  type: StepType;
  conditional: boolean;
}

/** A variant's steps in its own order. */
export interface StepLayout {
  steps: StepInfo[];
  positions: Map<string, number>;
  /** result_viewed and cta_clicked reach this step regardless of their step_id. */
  resultPosition: number | null;
}

/** `null` when the version's config or the variant is unknown: the group then gets KPIs but no step funnel. */
export function stepLayout(config: FunnelConfig | undefined, variant: string): StepLayout | null {
  if (!config || !Object.hasOwn(config.experiment.variants, variant)) return null;
  const funnel = resolveVariant(config, variant);
  const steps = funnel.sequence.map((id): StepInfo => {
    const step = funnel.steps[id]!;
    return { id, type: step.type, conditional: step.visibleWhen !== undefined };
  });
  const resultIndex = steps.findIndex((s) => s.type === 'result');
  return {
    steps,
    positions: new Map(steps.map((s, i) => [s.id, i])),
    resultPosition: resultIndex === -1 ? null : resultIndex,
  };
}

/** Config order of the experiment's variants (A before B); unknown variants follow alphabetically. */
export function variantOrder(config: FunnelConfig | undefined): (a: string, b: string) => number {
  return listOrder(config ? Object.keys(config.experiment.variants) : []);
}
