import type { SessionResponse } from '@funnel/contracts';
import { isStepReachable, resolveCurrentStepId } from '@funnel/engine';

/**
 * Step shown when a session is opened. `?step=` may take a resumed session back to a reachable step, never forward:
 * a new session always starts at the first step, and a stale bookmark cannot skip the step the session stopped at.
 */
export function initialStepId(
  { created, funnel, state }: Pick<SessionResponse, 'created' | 'funnel' | 'state'>,
  requestedStep: string | null,
): string {
  const resumeAt = resolveCurrentStepId(funnel, state.answers, state.currentStepId);
  if (created || !requestedStep || !isStepReachable(funnel, state.answers, requestedStep)) return resumeAt;
  return funnel.sequence.indexOf(requestedStep) <= funnel.sequence.indexOf(resumeAt) ? requestedStep : resumeAt;
}
