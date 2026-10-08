import { collectAnswerRefs, collectLeaves } from './conditions';
import { deepMerge } from './resolve';
import {
  CORE_EVENTS,
  FunnelConfigSchema,
  OPERATORS,
  ResultSchema,
  StepSchema,
  hasInput,
  type Condition,
  type FunnelConfig,
  type InputStep,
  type LeafCondition,
} from './schema';

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigValidation {
  ok: boolean;
  config: FunnelConfig | null;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

const OPERATORS_BY_TYPE: Record<InputStep['type'], readonly string[]> = {
  'single-select': ['eq', 'neq', 'in', 'not_in', 'exists'],
  'multi-select': ['contains', 'not_contains', 'exists'],
  number: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists'],
};

type Report = (path: string, message: string) => void;

/**
 * Structural (zod) and semantic checks run before a version can be stored.
 * A config that passes here cannot break the runtime: every referenced step, answer, option,
 * result and operator exists, and every condition only depends on questions asked earlier.
 */
export function validateConfig(raw: unknown): ConfigValidation {
  const parsed = FunnelConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      config: null,
      warnings: [],
      errors: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    };
  }

  const config = parsed.data;
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const error: Report = (path, message) => errors.push({ path, message });
  const warn: Report = (path, message) => warnings.push({ path, message });

  if (!/^1(\.\d+)*$/.test(config.schemaVersion)) {
    error('schemaVersion', `Unsupported schemaVersion "${config.schemaVersion}", expected 1.x`);
  }

  // Steps and answer names
  const owners = new Map<string, InputStep>();
  for (const [key, step] of Object.entries(config.steps)) {
    const at = `steps.${key}`;
    if (step.id !== key) error(`${at}.id`, `Step id "${step.id}" must match its key "${key}"`);
    if (step.type === 'result' && step.resultSource !== 'resultRules') {
      error(`${at}.resultSource`, `Unsupported resultSource "${step.resultSource}"`);
    }
    if (!hasInput(step)) continue;
    const other = owners.get(step.input.name);
    if (other) error(`${at}.input.name`, `Answer name "${step.input.name}" is already used by step "${other.id}"`);
    else owners.set(step.input.name, step);
    checkInput(step, at, error);
  }

  const checkCondition = (cond: Condition, at: string) => {
    for (const leaf of collectLeaves(cond)) {
      if (!(OPERATORS as readonly string[]).includes(leaf.operator)) {
        error(at, `Unsupported operator "${leaf.operator}"`);
        continue;
      }
      const owner = owners.get(leaf.answer);
      if (!owner) {
        error(at, `Unknown answer "${leaf.answer}"`);
        continue;
      }
      if (!OPERATORS_BY_TYPE[owner.type].includes(leaf.operator)) {
        error(at, `Operator "${leaf.operator}" cannot be used with ${owner.type} answer "${leaf.answer}"`);
        continue;
      }
      checkConditionValue(leaf, owner, at, error);
    }
  };

  for (const [key, step] of Object.entries(config.steps)) {
    if (step.visibleWhen) checkCondition(step.visibleWhen, `steps.${key}.visibleWhen`);
  }

  // Results
  for (const [key, result] of Object.entries(config.results)) {
    if (result.id !== key) error(`results.${key}.id`, `Result id "${result.id}" must match its key "${key}"`);
  }
  if (!config.results[config.defaultResultId]) {
    error('defaultResultId', `Unknown result "${config.defaultResultId}"`);
  }
  config.resultRules.forEach((rule, i) => {
    if (!config.results[rule.resultId]) error(`resultRules.${i}.resultId`, `Unknown result "${rule.resultId}"`);
    checkCondition(rule.when, `resultRules.${i}.when`);
  });

  // Experiment
  const variants = Object.entries(config.experiment.variants);
  if (variants.length === 0) error('experiment.variants', 'Define at least one variant');
  if (variants.reduce((sum, [, v]) => sum + v.weight, 0) <= 0) {
    error('experiment.variants', 'Variant weights must add up to more than 0');
  }
  if (config.experiment.assignment !== 'server') {
    error('experiment.assignment', `Unsupported assignment "${config.experiment.assignment}"`);
  }

  for (const [name, variant] of variants) {
    const at = `experiment.variants.${name}`;
    const sequence = variant.stepSequence;
    const seen = new Set<string>();
    sequence.forEach((id, i) => {
      if (!config.steps[id]) error(`${at}.stepSequence.${i}`, `Unknown step "${id}"`);
      if (seen.has(id)) error(`${at}.stepSequence.${i}`, `Step "${id}" appears twice`);
      seen.add(id);
    });
    const resultPositions = sequence.flatMap((id, i) => (config.steps[id]?.type === 'result' ? [i] : []));
    if (resultPositions.length !== 1 || resultPositions[0] !== sequence.length - 1) {
      error(`${at}.stepSequence`, 'The sequence must end with exactly one result step');
    }

    sequence.forEach((id, i) => {
      const cond = config.steps[id]?.visibleWhen;
      if (!cond) return;
      for (const ref of collectAnswerRefs(cond)) {
        const owner = owners.get(ref);
        if (!owner) continue;
        const j = sequence.indexOf(owner.id);
        if (j === -1) {
          warn(`${at}.stepSequence`, `Step "${id}" depends on "${ref}", which variant ${name} never asks, so it stays hidden`);
        } else if (j >= i) {
          error(`${at}.stepSequence`, `Step "${id}" depends on "${ref}", which variant ${name} asks later`);
        }
      }
    });

    config.resultRules.forEach((rule, i) => {
      for (const ref of collectAnswerRefs(rule.when)) {
        const owner = owners.get(ref);
        if (owner && !sequence.includes(owner.id)) {
          warn(`resultRules.${i}.when`, `Rule "${rule.resultId}" uses "${ref}", which variant ${name} never asks`);
        }
      }
    });

    for (const [stepId, override] of Object.entries(variant.stepOverrides)) {
      const oat = `${at}.stepOverrides.${stepId}`;
      const base = config.steps[stepId];
      if (!base) {
        error(oat, `Unknown step "${stepId}"`);
        continue;
      }
      if ('id' in override || 'type' in override) error(oat, 'An override cannot change id or type');
      if (!sequence.includes(stepId)) warn(oat, `Step "${stepId}" is not in variant ${name}, the override has no effect`);
      const merged = StepSchema.safeParse(deepMerge(base, override));
      if (!merged.success) error(oat, `The override makes the step invalid: ${merged.error.issues[0]?.message ?? 'unknown error'}`);
    }

    for (const [resultId, override] of Object.entries(variant.resultOverrides)) {
      const oat = `${at}.resultOverrides.${resultId}`;
      const base = config.results[resultId];
      if (!base) {
        error(oat, `Unknown result "${resultId}"`);
        continue;
      }
      if ('id' in override) error(oat, 'An override cannot change id');
      const merged = ResultSchema.safeParse(deepMerge(base, override));
      if (!merged.success) error(oat, `The override makes the result invalid: ${merged.error.issues[0]?.message ?? 'unknown error'}`);
    }
  }

  // Events
  const eventNames = new Set<string>();
  config.events.allowed.forEach((event, i) => {
    if (eventNames.has(event.name)) error(`events.allowed.${i}.name`, `Duplicate event "${event.name}"`);
    eventNames.add(event.name);
  });
  for (const core of CORE_EVENTS) {
    if (!eventNames.has(core)) error('events.allowed', `Core event "${core}" must be allowed`);
  }
  if (config.events.privacy.storeRawAnswers) {
    warn('events.privacy.storeRawAnswers', 'Raw answers are never sent to analytics, the flag is ignored');
  }

  // Session
  if (!config.session.pinVersion) warn('session.pinVersion', 'Sessions are always pinned to the version they started on');
  if (!config.session.pinExperimentVariant) {
    warn('session.pinExperimentVariant', 'Variants are always sticky within a session');
  }

  return { ok: errors.length === 0, config, errors, warnings };
}

function checkInput(step: InputStep, at: string, error: Report) {
  if (step.type === 'number') {
    const { min, max } = step.input;
    if (min !== undefined && max !== undefined && min > max) error(`${at}.input`, 'min must not exceed max');
    return;
  }
  const values = step.input.options.map((o) => o.value);
  if (new Set(values).size !== values.length) error(`${at}.input.options`, 'Option values must be unique');
  if (step.type === 'multi-select') {
    const { minSelections, maxSelections } = step.validation;
    if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
      error(`${at}.validation`, 'minSelections must not exceed maxSelections');
    }
    if (minSelections !== undefined && minSelections > values.length) {
      error(`${at}.validation`, 'minSelections exceeds the number of options');
    }
  }
}

function checkConditionValue(leaf: LeafCondition, owner: InputStep, at: string, error: Report) {
  const { operator, value } = leaf;
  const label = `"${leaf.answer} ${operator}"`;
  if (operator === 'exists') {
    if (value !== undefined && typeof value !== 'boolean') error(at, `${label} expects true, false or no value`);
    return;
  }

  const options = owner.type === 'number' ? null : new Set(owner.input.options.map((o) => o.value));
  const checkScalar = (v: unknown) => {
    if (owner.type === 'number') {
      if (typeof v !== 'number') error(at, `${label} expects a number, got ${JSON.stringify(v)}`);
    } else if (typeof v !== 'string' || !options?.has(v)) {
      error(at, `${label}: ${JSON.stringify(v)} is not an option of "${leaf.answer}"`);
    }
  };

  if (operator === 'in' || operator === 'not_in') {
    if (!Array.isArray(value) || value.length === 0) error(at, `${label} expects a non-empty list`);
    else value.forEach(checkScalar);
  } else if (operator === 'contains' || operator === 'not_contains') {
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) error(at, `${label} expects a value`);
    list.forEach(checkScalar);
  } else {
    checkScalar(value);
  }
}
