import { describe, expect, it } from 'vitest';
import { FunnelConfigSchema, resolveVariant } from '@funnel/engine';
import type { SessionState } from '@funnel/contracts';
import v3 from '../../../../configs/funnel-v3.json';
import { initialStepId } from './initialStep';

// Variant B: intro, work_mode, meeting_hours, timezone_span, team_size, async_maturity, priorities, ...
const funnel = resolveVariant(FunnelConfigSchema.parse(v3), 'B');
const fresh: SessionState = { answers: {}, currentStepId: 'intro', rev: 0 };
const resumed: SessionState = { answers: { work_mode: 'office', meeting_hours: 3 }, currentStepId: 'timezone_span', rev: 2 };
// Answered up to team_size, then went back to meeting_hours.
const wentBack: SessionState = {
  answers: { work_mode: 'office', meeting_hours: 3, timezone_span: 'same', team_size: 8 },
  currentStepId: 'meeting_hours',
  rev: 5,
};

describe('initial step', () => {
  it.each([
    ['a new session ignores a reachable step', fresh, true, 'work_mode', 'intro'],
    ['a session without answers cannot skip the intro', fresh, false, 'work_mode', 'intro'],
    ['a resumed session goes back to an answered step', resumed, false, 'work_mode', 'work_mode'],
    ['a resumed session opens the step it stopped at', resumed, false, 'timezone_span', 'timezone_span'],
    ['a stale bookmark cannot move past the stored step', wentBack, false, 'async_maturity', 'meeting_hours'],
    ['an unreachable step resumes at the stored step', resumed, false, 'priorities', 'timezone_span'],
    ['no step resumes at the stored step', resumed, false, null, 'timezone_span'],
    ['an unreachable stored step resumes at the first unanswered question', { ...resumed, currentStepId: 'priorities' }, false, null, 'timezone_span'],
  ])('%s', (_case, state, created, requested, expected) => {
    expect(initialStepId({ created, funnel, state }, requested)).toBe(expected);
  });
});
