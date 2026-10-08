import { stepHref } from './url';

/**
 * State of the history entries the funnel writes. `depth` counts the entries pushed on the way forward,
 * so the in-app Back button knows whether the previous entry is a funnel step it can return to.
 */
export interface StepHistoryState {
  step: string;
  depth: number;
}

export function readHistoryDepth(state: unknown): number {
  const depth = (state as Partial<StepHistoryState> | null)?.depth;
  return typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

export function pushStep(stepId: string, depth: number): void {
  const state: StepHistoryState = { step: stepId, depth };
  window.history.pushState(state, '', stepHref(stepId));
}

export function replaceStep(stepId: string, depth: number): void {
  const state: StepHistoryState = { step: stepId, depth };
  window.history.replaceState(state, '', stepHref(stepId));
}
