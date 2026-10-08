import type { AnswerValue, Condition, LeafCondition } from './schema';

/**
 * Three-valued result: `undefined` means "not known yet" because a referenced answer is still pending
 * (its question is ahead of the user or its own visibility is not resolved).
 */
export type Tri = boolean | undefined;

export type AnswerState =
  | { kind: 'known'; value: AnswerValue }
  /** The question can still be answered on the current path. */
  | { kind: 'pending' }
  /** The question is hidden, skipped or not part of this variant: the answer will not exist. */
  | { kind: 'absent' };

export type AnswerLookup = (name: string) => AnswerState;

export function isLeaf(cond: Condition): cond is LeafCondition {
  return 'answer' in cond;
}

/** Kleene logic: `all` is false if any part is false, `any` is true if any part is true, otherwise unknown wins. */
export function evaluateCondition(cond: Condition, lookup: AnswerLookup): Tri {
  if ('all' in cond) {
    let unknown = false;
    for (const part of cond.all) {
      const r = evaluateCondition(part, lookup);
      if (r === false) return false;
      if (r === undefined) unknown = true;
    }
    return unknown ? undefined : true;
  }
  if ('any' in cond) {
    let unknown = false;
    for (const part of cond.any) {
      const r = evaluateCondition(part, lookup);
      if (r === true) return true;
      if (r === undefined) unknown = true;
    }
    return unknown ? undefined : false;
  }
  if ('not' in cond) {
    const r = evaluateCondition(cond.not, lookup);
    return r === undefined ? undefined : !r;
  }

  const state = lookup(cond.answer);
  if (state.kind === 'pending') return undefined;
  if (state.kind === 'absent' || state.value === null) {
    // Any comparison with a missing answer is false. `exists: false` asks exactly for a missing answer.
    return cond.operator === 'exists' ? cond.value === false : false;
  }
  return applyOperator(cond.operator, state.value, cond.value);
}

function isScalar(v: AnswerValue): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

function asList(expected: unknown): unknown[] {
  return Array.isArray(expected) ? expected : [expected];
}

export function applyOperator(operator: string, actual: AnswerValue, expected: unknown): boolean {
  switch (operator) {
    case 'eq':
      return isScalar(actual) && actual === expected;
    case 'neq':
      return isScalar(actual) && actual !== expected;
    case 'in':
      return isScalar(actual) && Array.isArray(expected) && expected.includes(actual);
    case 'not_in':
      return isScalar(actual) && Array.isArray(expected) && !expected.includes(actual);
    case 'contains':
      // Multi-select answer contains the value (or every value of a list).
      return Array.isArray(actual) && asList(expected).every((e) => actual.includes(e as string));
    case 'not_contains':
      return Array.isArray(actual) && asList(expected).every((e) => !actual.includes(e as string));
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'exists':
      return expected !== false;
    default:
      // Published configs are validated, so this only fires on a config that bypassed validation.
      throw new Error(`Unsupported operator "${operator}"`);
  }
}

export function collectLeaves(cond: Condition, out: LeafCondition[] = []): LeafCondition[] {
  if ('all' in cond) cond.all.forEach((c) => collectLeaves(c, out));
  else if ('any' in cond) cond.any.forEach((c) => collectLeaves(c, out));
  else if ('not' in cond) collectLeaves(cond.not, out);
  else out.push(cond);
  return out;
}

/** Answer names a condition depends on. */
export function collectAnswerRefs(cond: Condition): string[] {
  return [...new Set(collectLeaves(cond).map((leaf) => leaf.answer))];
}
