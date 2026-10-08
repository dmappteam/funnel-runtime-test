import { describe, expect, it } from 'vitest';
import { applyOperator, evaluateCondition } from './conditions';
import { diffConfigs } from './diff';
import {
  computePath,
  getMissingStepIds,
  getNextStepId,
  getPrevStepId,
  getProgress,
  resolveCurrentStepId,
  resolveResult,
} from './path';
import { pickVariant, resolveVariant } from './resolve';
import type { Answers, InputStep } from './schema';
import { loadConfig, readRawConfig } from './testing';
import { validateAnswer } from './validation';
import { validateConfig } from './validateConfig';

const v1 = loadConfig(1);
const v2 = loadConfig(2);
const v3 = loadConfig(3);

describe('validateConfig', () => {
  it.each([1, 2, 3] as const)('accepts the shipped config v%i without errors or warnings', (version) => {
    const result = validateConfig(readRawConfig(version));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  const broken = (mutate: (raw: any) => void) => {
    const raw = structuredClone(readRawConfig(3)) as any;
    mutate(raw);
    return validateConfig(raw);
  };
  const messages = (r: ReturnType<typeof validateConfig>) => r.errors.map((e) => e.message).join('\n');

  it('rejects an unsupported operator', () => {
    const r = broken((c) => (c.steps.office_days.visibleWhen.operator = 'matches'));
    expect(r.ok).toBe(false);
    expect(messages(r)).toContain('Unsupported operator "matches"');
  });

  it('rejects a condition that depends on a question asked later in a variant', () => {
    const r = broken((c) => {
      const seq: string[] = c.experiment.variants.B.stepSequence;
      seq.splice(seq.indexOf('security_constraints'), 1);
      seq.splice(1, 0, 'security_constraints');
    });
    expect(messages(r)).toContain('depends on "priorities", which variant B asks later');
  });

  it('rejects unknown steps, missing core events, bad option values and operator/type mismatches', () => {
    const r = broken((c) => {
      c.experiment.variants.A.stepSequence.splice(1, 0, 'nope');
      c.events.allowed = c.events.allowed.filter((e: any) => e.name !== 'back_clicked');
      c.steps.office_days.visibleWhen.value = ['hybrid', 'moon'];
      c.resultRules[1].when.operator = 'contains';
    });
    const text = messages(r);
    expect(text).toContain('Unknown step "nope"');
    expect(text).toContain('Core event "back_clicked" must be allowed');
    expect(text).toContain('"moon" is not an option of "work_mode"');
    expect(text).toContain('Operator "contains" cannot be used with number answer "meeting_hours"');
  });

  it('rejects overrides that change the step type and a sequence without a final result step', () => {
    const r = broken((c) => {
      c.experiment.variants.B.stepOverrides.intro.type = 'number';
      c.experiment.variants.A.stepSequence.pop();
    });
    expect(messages(r)).toContain('An override cannot change id or type');
    expect(messages(r)).toContain('must end with exactly one result step');
  });

  it('reports structural errors with a path', () => {
    const r = broken((c) => (c.steps.team_size.type = 'slider'));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.path).toBe('steps.team_size.type');
  });

  it('warns when a variant never asks a question that a step depends on', () => {
    const r = broken((c) => {
      const seq: string[] = c.experiment.variants.B.stepSequence;
      seq.splice(seq.indexOf('priorities'), 1);
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.message).join('\n')).toContain('never asks, so it stays hidden');
  });
});

describe('resolveVariant', () => {
  it('applies step order and deep-merges overrides for variant B', () => {
    const b = resolveVariant(v1, 'B');
    expect(b.sequence.slice(0, 3)).toEqual(['intro', 'work_mode', 'timezone_span']);
    expect(b.steps.intro?.content.primaryActionLabel).toBe('Show me');
    expect(b.steps.priorities?.content.title).toBe('What would make the biggest difference right now?');
    const asyncNative = b.results.async_native!;
    expect(asyncNative.title).toBe('Your team is ready to reduce meetings');
    expect(asyncNative.cta.label).toBe('See the 30-day action list');
    expect(asyncNative.summary).toBe(v1.results.async_native!.summary);
  });

  it('keeps variant A untouched and drops steps a variant does not use', () => {
    const a = resolveVariant(v1, 'A');
    expect(a.steps.intro?.content.primaryActionLabel).toBe('Start');
    expect(resolveVariant(v3, 'B').steps.tool_count).toBeUndefined();
  });

  it('throws for an unknown variant', () => {
    expect(() => resolveVariant(v1, 'C')).toThrow(/Variant "C"/);
  });
});

describe('pickVariant', () => {
  it('splits by weight', () => {
    const variants = { A: { weight: 50 }, B: { weight: 50 } };
    expect(pickVariant(variants, 0)).toBe('A');
    expect(pickVariant(variants, 0.4999)).toBe('A');
    expect(pickVariant(variants, 0.5)).toBe('B');
    expect(pickVariant(variants, 0.9999)).toBe('B');
    expect(pickVariant({ A: { weight: 0 }, B: { weight: 100 } }, 0)).toBe('B');
  });
});

describe('conditions', () => {
  const known = (value: Answers[string]) => () => ({ kind: 'known' as const, value });

  it('supports every operator', () => {
    expect(applyOperator('eq', 'remote', 'remote')).toBe(true);
    expect(applyOperator('neq', 'remote', 'office')).toBe(true);
    expect(applyOperator('in', 'hybrid', ['hybrid', 'office'])).toBe(true);
    expect(applyOperator('not_in', 'remote', ['hybrid', 'office'])).toBe(true);
    expect(applyOperator('contains', ['speed', 'compliance'], 'compliance')).toBe(true);
    expect(applyOperator('contains', ['speed'], ['speed', 'focus'])).toBe(false);
    expect(applyOperator('not_contains', ['speed'], 'compliance')).toBe(true);
    expect(applyOperator('gt', 15, 15)).toBe(false);
    expect(applyOperator('gte', 15, 15)).toBe(true);
    expect(applyOperator('lt', 3, 4)).toBe(true);
    expect(applyOperator('lte', 4, 4)).toBe(true);
    expect(applyOperator('contains', 'compliance', 'compliance')).toBe(false);
    expect(() => applyOperator('matches', 'a', 'a')).toThrow(/Unsupported operator/);
  });

  it('uses three-valued logic for pending answers', () => {
    const pending = () => ({ kind: 'pending' as const });
    const absent = () => ({ kind: 'absent' as const });
    const cond = { answer: 'work_mode', operator: 'eq', value: 'remote' };
    expect(evaluateCondition(cond, pending)).toBeUndefined();
    expect(evaluateCondition(cond, absent)).toBe(false);
    expect(evaluateCondition({ any: [cond, { answer: 'x', operator: 'exists' }] }, known('remote'))).toBe(true);
    expect(evaluateCondition({ all: [cond] }, pending)).toBeUndefined();
    expect(evaluateCondition({ not: cond }, known('office'))).toBe(true);
    expect(evaluateCondition({ answer: 'x', operator: 'exists', value: false }, absent)).toBe(true);
  });
});

describe('path, branching and progress', () => {
  it('hides office_days for remote teams and shows it for hybrid ones', () => {
    const a = resolveVariant(v1, 'A');
    const ids = (answers: Answers) => computePath(a, answers).entries.map((e) => e.stepId);
    expect(ids({ work_mode: 'remote' })).not.toContain('office_days');
    expect(ids({ work_mode: 'hybrid' })).toContain('office_days');
  });

  it('keeps a step with unresolved visibility on the path, so the progress total only shrinks', () => {
    const a = resolveVariant(v1, 'A');
    const entry = computePath(a, {}).entries.find((e) => e.stepId === 'office_days');
    expect(entry).toEqual({ stepId: 'office_days', certain: false });
    expect(getProgress(a, {}, 'intro')).toEqual({ index: null, total: 7 });
    expect(getProgress(a, {}, 'team_size')).toEqual({ index: 1, total: 7 });
    expect(getProgress(a, { team_size: 8, work_mode: 'remote' }, 'priorities')).toEqual({ index: 3, total: 6 });
  });

  it('opens the v3 compliance branch only when compliance is selected', () => {
    const a = resolveVariant(v3, 'A');
    const base: Answers = { team_size: 12, work_mode: 'remote' };
    expect(getNextStepId(a, { ...base, priorities: ['speed', 'compliance'] }, 'priorities')).toBe('security_constraints');
    expect(getNextStepId(a, { ...base, priorities: ['speed'] }, 'priorities')).toBe('timezone_span');
    expect(getProgress(a, {}, 'team_size').total).toBe(9);
    expect(getProgress(a, { ...base, priorities: ['speed'] }, 'timezone_span')).toEqual({ index: 4, total: 7 });
  });

  it('goes back to the previous visible step', () => {
    const a = resolveVariant(v3, 'A');
    const answers: Answers = { team_size: 12, work_mode: 'hybrid', priorities: ['focus'] };
    expect(getPrevStepId(a, answers, 'timezone_span')).toBe('priorities');
    expect(getPrevStepId(a, answers, 'intro')).toBeNull();
    expect(getPrevStepId(a, { ...answers, priorities: ['compliance'] }, 'timezone_span')).toBe('security_constraints');
  });

  it('variant B of v3 has no tool_count and still reaches the result', () => {
    const b = resolveVariant(v3, 'B');
    const answers: Answers = {
      work_mode: 'office',
      meeting_hours: 6,
      timezone_span: 'same',
      team_size: 40,
      async_maturity: 'low',
      priorities: ['culture'],
      office_days: 4,
    };
    expect(getNextStepId(b, answers, 'office_days')).toBe('result');
    expect(getMissingStepIds(b, answers)).toEqual([]);
    expect(resolveResult(b, answers).resultId).toBe('office_core');
  });

  it('resumes at a reachable requested step, otherwise at the first unanswered question', () => {
    const a = resolveVariant(v1, 'A');
    expect(resolveCurrentStepId(a, {})).toBe('intro');
    expect(resolveCurrentStepId(a, {}, 'tool_count')).toBe('intro');
    const partial: Answers = { team_size: 5, work_mode: 'remote' };
    expect(resolveCurrentStepId(a, partial, 'work_mode')).toBe('work_mode');
    expect(resolveCurrentStepId(a, partial, 'result')).toBe('priorities');
  });
});

describe('results', () => {
  const complete = (overrides: Answers): Answers => ({
    team_size: 10,
    work_mode: 'remote',
    priorities: ['speed'],
    timezone_span: 'same',
    office_days: 2,
    meeting_hours: 5,
    async_maturity: 'low',
    tool_count: 6,
    ...overrides,
  });

  it('applies rules in order: first match wins, then the default', () => {
    const a1 = resolveVariant(v1, 'A');
    expect(resolveResult(a1, complete({ timezone_span: 'wide' })).resultId).toBe('async_native');
    expect(resolveResult(a1, complete({ work_mode: 'hybrid' })).resultId).toBe('hybrid_structured');
    expect(resolveResult(a1, complete({ work_mode: 'office', async_maturity: 'high' })).resultId).toBe('async_native');
    expect(resolveResult(a1, complete({})).resultId).toBe('balanced');
    const a2 = resolveVariant(v2, 'A');
    expect(resolveResult(a2, complete({ timezone_span: 'global', meeting_hours: 20 })).resultId).toBe('meeting_heavy');
  });

  it('ignores a stale answer of a step that became hidden', () => {
    const a3 = resolveVariant(v3, 'A');
    const stale = complete({ priorities: ['speed'], security_constraints: 'strict' });
    expect(computePath(a3, stale).effective.security_constraints).toBeUndefined();
    expect(resolveResult(a3, stale).resultId).toBe('balanced');
    expect(resolveResult(a3, { ...stale, priorities: ['compliance'] }).resultId).toBe('regulated_scale');
  });

  it('returns the variant B framing of the same result', () => {
    const b1 = resolveVariant(v1, 'B');
    const { resultId, result } = resolveResult(b1, complete({ work_mode: 'hybrid' }));
    expect(resultId).toBe('hybrid_structured');
    expect(result.title).toBe('Your hybrid model needs clearer rules');
    expect(result.recommendations).toHaveLength(3);
  });

  it('lists missing questions before the result can be computed', () => {
    const a1 = resolveVariant(v1, 'A');
    expect(getMissingStepIds(a1, { team_size: 3 })).toEqual([
      'work_mode',
      'priorities',
      'timezone_span',
      'office_days',
      'async_maturity',
      'tool_count',
    ]);
  });
});

describe('validateAnswer', () => {
  const a3 = resolveVariant(v3, 'A');
  const step = (id: string) => a3.steps[id] as InputStep;

  it('validates numbers with config messages', () => {
    expect(validateAnswer(step('team_size'), '12')).toEqual({ ok: true, value: 12 });
    expect(validateAnswer(step('team_size'), '')).toMatchObject({ ok: false, message: 'Enter the team size.' });
    expect(validateAnswer(step('team_size'), 0)).toMatchObject({ ok: false, code: 'min' });
    expect(validateAnswer(step('team_size'), 201)).toMatchObject({ ok: false, message: 'For this demo, enter a value up to 200.' });
    expect(validateAnswer(step('team_size'), '2.5')).toMatchObject({ ok: false, code: 'step', message: 'Enter a whole number.' });
    expect(validateAnswer(step('team_size'), 'abc')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('validates multi-select limits and falls back to minSelections for an empty answer', () => {
    expect(validateAnswer(step('priorities'), [])).toMatchObject({ ok: false, message: 'Choose at least one priority.' });
    expect(validateAnswer(step('priorities'), ['speed', 'focus', 'cost', 'culture'])).toMatchObject({
      ok: false,
      message: 'Choose no more than three priorities.',
    });
    expect(validateAnswer(step('priorities'), ['cost', 'speed', 'cost'])).toEqual({ ok: true, value: ['speed', 'cost'] });
    expect(validateAnswer(step('priorities'), ['speed', 'moon'])).toMatchObject({ ok: false, code: 'invalid_option' });
  });

  it('validates single-select options', () => {
    expect(validateAnswer(step('work_mode'), 'hybrid')).toEqual({ ok: true, value: 'hybrid' });
    expect(validateAnswer(step('work_mode'), undefined)).toMatchObject({ ok: false, message: "Select the team's main work mode." });
    expect(validateAnswer(step('work_mode'), 'moon')).toMatchObject({ ok: false, code: 'invalid_option' });
  });
});

describe('diffConfigs', () => {
  it('describes the second iteration (v2 → v3)', () => {
    const diff = diffConfigs(v2, v3);
    expect(diff.stepsAdded).toEqual(['security_constraints']);
    expect(diff.resultsAdded).toEqual(['regulated_scale']);
    expect(diff.eventsAdded).toEqual(['recommendation_expanded']);
    expect(diff.operatorsAdded).toEqual(['contains']);
    expect(diff.experimentChanged).toBe(true);
    const b = diff.variants.find((v) => v.variant === 'B')!;
    expect(b.stepsRemoved).toEqual(['tool_count']);
    expect(b.stepsAdded).toEqual(['security_constraints']);
  });

  it('describes v1 → v2', () => {
    const diff = diffConfigs(v1, v2);
    expect(diff.stepsAdded).toEqual(['meeting_hours']);
    expect(diff.operatorsAdded).toEqual(['gte']);
    expect(diff.resultsAdded).toEqual(['meeting_heavy']);
  });
});
