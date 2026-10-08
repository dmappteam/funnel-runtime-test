import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, openSession, release, type TestContext } from '../test/helpers';
import { purgeExpiredState } from './sessions';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe('purgeExpiredState', () => {
  it('empties the answers of sessions expired for more than 24 hours and keeps the rest', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const save = (sessionId: string) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/state`,
        payload: { answers: { work_mode: 'remote' }, currentStepId: 'team_size', rev: 0 },
      });

    const old = await openSession(ctx.app);
    await save(old.sessionId);
    ctx.clock.advanceHours(24);
    const recent = await openSession(ctx.app);
    await save(recent.sessionId);
    ctx.clock.advanceHours(73);
    const live = await openSession(ctx.app);
    await save(live.sessionId);

    // TTL is 72 h: old expired 25 h ago, recent 1 h ago, live is active.
    expect(purgeExpiredState(ctx.db, ctx.clock.now())).toBe(1);
    expect(purgeExpiredState(ctx.db, ctx.clock.now())).toBe(0);
    const state = (sessionId: string) =>
      JSON.parse(ctx.db.prepare('SELECT state_json FROM sessions WHERE session_id = ?').pluck().get(sessionId) as string);
    expect(state(old.sessionId)).toEqual({ answers: {}, currentStepId: 'team_size' });
    expect(state(recent.sessionId).answers).toEqual({ work_mode: 'remote' });
    expect(state(live.sessionId).answers).toEqual({ work_mode: 'remote' });
  });
});
