import { evaluateCondition, type AnswerLookup } from './conditions';
import { hasInput, type Answers, type ResolvedFunnel, type ResultDef } from './schema';
import { validateAnswer } from './validation';

export interface PathEntry {
  stepId: string;
  /**
   * `false` when visibility depends on an answer the user has not given yet.
   * Such steps stay on the path, so the progress total can only shrink as answers come in.
   */
  certain: boolean;
}

export interface FunnelPath {
  entries: PathEntry[];
  /** Valid answers of questions that are certainly on the path. Only these feed conditions and results. */
  effective: Answers;
  /** Answer names that can still be given on this path. */
  pending: Set<string>;
}

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export function makeLookup(effective: Answers, pending: ReadonlySet<string>): AnswerLookup {
  return (name) => {
    if (has(effective, name)) return { kind: 'known', value: effective[name] ?? null };
    if (pending.has(name)) return { kind: 'pending' };
    return { kind: 'absent' };
  };
}

/**
 * Walks the variant's sequence and keeps the steps whose `visibleWhen` is true or not decidable yet.
 * Answers of hidden steps are kept in the session but ignored here, so a changed branch never
 * feeds stale answers into later conditions or result rules.
 */
export function computePath(funnel: ResolvedFunnel, answers: Answers): FunnelPath {
  const effective: Answers = {};
  const pending = new Set<string>();
  const lookup = makeLookup(effective, pending);
  const entries: PathEntry[] = [];

  for (const stepId of funnel.sequence) {
    const step = funnel.steps[stepId];
    if (!step) continue;
    const visible = step.visibleWhen ? evaluateCondition(step.visibleWhen, lookup) : true;
    if (visible === false) continue;
    entries.push({ stepId, certain: visible === true });
    if (!hasInput(step)) continue;

    const name = step.input.name;
    const check = visible === true && has(answers, name) ? validateAnswer(step, answers[name]) : null;
    if (check?.ok) effective[name] = check.value;
    else pending.add(name);
  }
  return { entries, effective, pending };
}

function isAnswered(funnel: ResolvedFunnel, path: FunnelPath, stepId: string): boolean {
  const step = funnel.steps[stepId];
  return !step || !hasInput(step) || has(path.effective, step.input.name);
}

export function getNextStepId(funnel: ResolvedFunnel, answers: Answers, currentStepId: string): string | null {
  const path = computePath(funnel, answers);
  const i = path.entries.findIndex((e) => e.stepId === currentStepId);
  if (i === -1) return null;
  return path.entries[i + 1]?.stepId ?? null;
}

/** Previous visible step. Works even if the current step itself is no longer on the path. */
export function getPrevStepId(funnel: ResolvedFunnel, answers: Answers, currentStepId: string): string | null {
  const path = computePath(funnel, answers);
  const position = funnel.sequence.indexOf(currentStepId);
  const before = path.entries.filter((e) => funnel.sequence.indexOf(e.stepId) < position);
  return before[before.length - 1]?.stepId ?? null;
}

/** A step is reachable when it is certainly on the path and every question before it is answered. */
export function isStepReachable(funnel: ResolvedFunnel, answers: Answers, stepId: string): boolean {
  const path = computePath(funnel, answers);
  for (const entry of path.entries) {
    if (entry.stepId === stepId) return entry.certain;
    if (!isAnswered(funnel, path, entry.stepId)) return false;
  }
  return false;
}

/**
 * Step to show after a reload or a URL change: the requested one if reachable,
 * otherwise the first unanswered question (or the first step for a fresh session).
 */
export function resolveCurrentStepId(funnel: ResolvedFunnel, answers: Answers, requested?: string | null): string {
  if (requested && isStepReachable(funnel, answers, requested)) return requested;
  const path = computePath(funnel, answers);
  const first = path.entries[0]?.stepId;
  if (!first) throw new Error(`Funnel ${funnel.funnelId} v${funnel.version} has no visible steps`);
  if (Object.keys(path.effective).length === 0) return first;
  for (const entry of path.entries) if (!isAnswered(funnel, path, entry.stepId)) return entry.stepId;
  return path.entries[path.entries.length - 1]!.stepId;
}

/** Questions on the current path that still need an answer. Empty means the result can be computed. */
export function getMissingStepIds(funnel: ResolvedFunnel, answers: Answers): string[] {
  const path = computePath(funnel, answers);
  return path.entries
    .filter((e) => !e.certain || !isAnswered(funnel, path, e.stepId))
    .filter((e) => {
      const step = funnel.steps[e.stepId];
      return step !== undefined && hasInput(step);
    })
    .map((e) => e.stepId);
}

export interface Progress {
  /** 1-based position among counted steps, `null` on steps excluded from progress (info, result). */
  index: number | null;
  total: number;
}

export function getProgress(funnel: ResolvedFunnel, answers: Answers, currentStepId: string): Progress {
  const excluded = new Set<string>(funnel.progress.excludeTypes);
  const ids = funnel.progress.countVisibleOnly
    ? computePath(funnel, answers).entries.map((e) => e.stepId)
    : funnel.sequence;
  const counted = ids.filter((id) => {
    const step = funnel.steps[id];
    return step !== undefined && !excluded.has(step.type);
  });
  const i = counted.indexOf(currentStepId);
  return { index: i === -1 ? null : i + 1, total: counted.length };
}

/** First matching rule wins, then `defaultResultId`. Uses only answers of steps on the current path. */
export function resolveResult(funnel: ResolvedFunnel, answers: Answers): { resultId: string; result: ResultDef } {
  const path = computePath(funnel, answers);
  const lookup = makeLookup(path.effective, path.pending);
  const rule = funnel.resultRules.find((r) => evaluateCondition(r.when, lookup) === true);
  const resultId = rule?.resultId ?? funnel.defaultResultId;
  const result = has(funnel.results, resultId) ? funnel.results[resultId] : undefined;
  if (!result) throw new Error(`Result "${resultId}" is not defined in ${funnel.funnelId} v${funnel.version}`);
  return { resultId, result };
}
