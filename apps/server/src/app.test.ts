import type { ApiError, ResultResponse, SaveStateResponse } from '@funnel/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FUNNEL_ID,
  answersFor,
  createTestApp,
  getSession,
  openSession,
  release,
  rollback,
  type TestContext,
} from './test/helpers';

vi.mock('@funnel/analytics', () => ({
  aggregate: () => {
    throw new Error('aggregate exploded at /secret/path.ts:42');
  },
}));

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe('Mandatory #8: second iteration (v2 → v3 → rollback)', () => {
  it('lets a v2 session finish on v2 while new sessions run v3, without a schema change', async () => {
    ctx = await createTestApp({ random: () => 0.75 });
    const { app, db } = ctx;
    const schema = () => ({
      migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      tables: db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all(),
    });
    await release(app, 1);
    await release(app, 2);
    const before = schema();

    // A v2/B user stops at tool_count, the step v3 removes from variant B.
    const old = await openSession(app);
    expect(old.data.session).toMatchObject({ funnelVersion: 2, variant: 'B' });
    const answered = answersFor(old.data.funnel, { meeting_hours: 20 });
    delete answered.tool_count;
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${old.sessionId}/state`,
      payload: { answers: answered, currentStepId: 'tool_count', rev: 0 },
    });
    expect(saved.json<SaveStateResponse>().state.rev).toBe(1);

    await release(app, 3);

    const resumed = await getSession(app, old.sessionId);
    expect(resumed.data.session.funnelVersion).toBe(2);
    expect(resumed.data.funnel.sequence).toContain('tool_count');
    expect(resumed.data.state).toEqual({ answers: answered, currentStepId: 'tool_count', rev: 1 });
    const finished = await app.inject({
      method: 'POST',
      url: `/api/sessions/${old.sessionId}/result`,
      payload: { answers: { ...answered, tool_count: 6 } },
    });
    expect(finished.statusCode).toBe(200);
    const result = finished.json<ResultResponse>();
    expect(result.resultId).toBe('meeting_heavy');
    expect(result.result.title).toBe('Meetings are consuming your operating capacity');
    expect(result.result.cta.label).toBe('Reveal the first three changes'); // v2 wording, v3 says "Open the implementation details"

    const fresh = await openSession(app);
    expect(fresh.data.session).toMatchObject({ funnelVersion: 3, variant: 'B' });
    expect(fresh.data.funnel.sequence).not.toContain('tool_count');
    const noToolCount = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${fresh.sessionId}/state`,
      payload: { answers: { tool_count: 6 }, currentStepId: 'work_mode', rev: 0 },
    });
    expect(noToolCount.statusCode).toBe(422);
    const freshResult = await app.inject({
      method: 'POST',
      url: `/api/sessions/${fresh.sessionId}/result`,
      payload: { answers: answersFor(fresh.data.funnel, { priorities: ['compliance'], security_constraints: 'regulated' }) },
    });
    expect(freshResult.json<ResultResponse>().resultId).toBe('regulated_scale');

    expect((await rollback(app)).json()).toEqual({ activeVersion: 2, rolledBackFrom: 3 });
    expect((await openSession(app)).data.session.funnelVersion).toBe(2);
    expect((await getSession(app, fresh.sessionId)).data.session.funnelVersion).toBe(3);

    expect(schema()).toEqual(before);
  });
});

describe('HTTP basics', () => {
  it('reports health', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('answers malformed JSON and unsupported media types with an ApiError', async () => {
    ctx = await createTestApp();
    const malformed = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/funnels/${FUNNEL_ID}/publish`,
      headers: { 'content-type': 'application/json' },
      payload: '{"version":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ApiError>().error).toBe('bad_request');

    const form = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/funnels/${FUNNEL_ID}/publish`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'version=1',
    });
    expect(form.statusCode).toBe(415);
    expect(form.json<ApiError>().error).toBe('bad_request');

    // text/plain is parsed as JSON only by the events endpoint (sendBeacon).
    const plain = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/funnels/${FUNNEL_ID}/publish`,
      headers: { 'content-type': 'text/plain' },
      payload: '{"version":1}',
    });
    expect(plain.statusCode).toBe(400);
  });

  it('rejects a prototype-poisoning payload', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/sessions/0b7f6c1e-8a4d-4c52-9a8e-3f1d2c4b5a69',
      headers: { 'content-type': 'application/json' },
      payload: '{"utm":{},"__proto__":{"polluted":true}}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('hides internal errors behind a generic 500', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/analytics' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'Internal server error' });
    expect(res.body).not.toContain('secret');
  });
});
