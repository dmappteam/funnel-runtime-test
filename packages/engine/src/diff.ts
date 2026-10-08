import { collectLeaves } from './conditions';
import type { FunnelConfig } from './schema';

export interface VariantDiff {
  variant: string;
  stepsAdded: string[];
  stepsRemoved: string[];
  orderChanged: boolean;
}

/** What changes for users when `next` replaces `prev`. Shown in the admin before publishing. */
export interface ConfigDiff {
  fromVersion: number;
  toVersion: number;
  experimentChanged: boolean;
  stepsAdded: string[];
  stepsRemoved: string[];
  resultsAdded: string[];
  resultsRemoved: string[];
  eventsAdded: string[];
  eventsRemoved: string[];
  operatorsAdded: string[];
  variants: VariantDiff[];
}

export function operatorsUsed(config: FunnelConfig): string[] {
  const conditions = [
    ...Object.values(config.steps).flatMap((s) => (s.visibleWhen ? [s.visibleWhen] : [])),
    ...config.resultRules.map((r) => r.when),
  ];
  return [...new Set(conditions.flatMap((c) => collectLeaves(c).map((leaf) => leaf.operator)))].sort();
}

const added = (from: string[], to: string[]) => to.filter((x) => !from.includes(x));

export function diffConfigs(prev: FunnelConfig, next: FunnelConfig): ConfigDiff {
  const prevSteps = Object.keys(prev.steps);
  const nextSteps = Object.keys(next.steps);
  const prevResults = Object.keys(prev.results);
  const nextResults = Object.keys(next.results);
  const prevEvents = prev.events.allowed.map((e) => e.name);
  const nextEvents = next.events.allowed.map((e) => e.name);
  const variantNames = [...new Set([...Object.keys(prev.experiment.variants), ...Object.keys(next.experiment.variants)])];

  return {
    fromVersion: prev.version,
    toVersion: next.version,
    experimentChanged: prev.experiment.id !== next.experiment.id,
    stepsAdded: added(prevSteps, nextSteps),
    stepsRemoved: added(nextSteps, prevSteps),
    resultsAdded: added(prevResults, nextResults),
    resultsRemoved: added(nextResults, prevResults),
    eventsAdded: added(prevEvents, nextEvents),
    eventsRemoved: added(nextEvents, prevEvents),
    operatorsAdded: added(operatorsUsed(prev), operatorsUsed(next)),
    variants: variantNames.map((variant) => {
      const from = prev.experiment.variants[variant]?.stepSequence ?? [];
      const to = next.experiment.variants[variant]?.stepSequence ?? [];
      const common = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
      return {
        variant,
        stepsAdded: added(from, to),
        stepsRemoved: added(to, from),
        orderChanged: common(from, to).join() !== common(to, from).join(),
      };
    }),
  };
}
