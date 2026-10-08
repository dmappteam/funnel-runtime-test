import type { FunnelConfig, ResolvedFunnel, ResultDef, Step } from './schema';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge recursively, arrays and scalars from `override` replace the base value. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override === undefined ? base : override) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

export function variantNames(config: FunnelConfig): string[] {
  return Object.keys(config.experiment.variants);
}

/** Applies a variant's step order and overrides. The result is what a session pinned to this version and variant runs. */
export function resolveVariant(config: FunnelConfig, variant: string): ResolvedFunnel {
  // Own keys only, so ids like "constructor" never resolve to Object.prototype members.
  const def = Object.hasOwn(config.experiment.variants, variant) ? config.experiment.variants[variant] : undefined;
  if (!def) throw new Error(`Variant "${variant}" is not defined in ${config.funnelId} v${config.version}`);

  const steps: Record<string, Step> = {};
  for (const id of def.stepSequence) {
    const base = Object.hasOwn(config.steps, id) ? config.steps[id] : undefined;
    if (!base) throw new Error(`Step "${id}" is not defined in ${config.funnelId} v${config.version}`);
    const override = Object.hasOwn(def.stepOverrides, id) ? def.stepOverrides[id] : undefined;
    steps[id] = override ? deepMerge(base, override) : base;
  }

  const results: Record<string, ResultDef> = {};
  for (const [id, base] of Object.entries(config.results)) {
    const override = Object.hasOwn(def.resultOverrides, id) ? def.resultOverrides[id] : undefined;
    results[id] = override ? deepMerge(base, override) : base;
  }

  return {
    funnelId: config.funnelId,
    version: config.version,
    experimentId: config.experiment.id,
    variant,
    locale: config.locale,
    title: config.title,
    sequence: [...def.stepSequence],
    steps,
    progress: config.progress,
    resultRules: config.resultRules,
    defaultResultId: config.defaultResultId,
    results,
    events: config.events,
    session: config.session,
  };
}

/** Weighted pick. `random` is a number in [0, 1); the server passes a crypto-random value, tests pass fixed ones. */
export function pickVariant(variants: Record<string, { weight: number }>, random: number): string {
  const entries = Object.entries(variants).filter(([, v]) => v.weight > 0);
  if (entries.length === 0) throw new Error('No variant has a positive weight');
  const total = entries.reduce((sum, [, v]) => sum + v.weight, 0);
  let x = Math.min(Math.max(random, 0), 0.999999999) * total;
  for (const [name, v] of entries) {
    if (x < v.weight) return name;
    x -= v.weight;
  }
  return entries[entries.length - 1]![0];
}
