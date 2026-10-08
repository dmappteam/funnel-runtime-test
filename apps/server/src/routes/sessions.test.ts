import { randomUUID } from 'node:crypto';
import type { ApiError, ResultResponse, SaveStateResponse, SessionResponse } from '@funnel/contracts';
import { resolveVariant } from '@funnel/engine';
import { loadConfig } from '@funnel/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answersFor,
  count,
  createTestApp,
  getSession,
  openSession,
  release,
  rollback,
  type TestContext,
} from '../test/helpers';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe('Mandatory #1: version pinning', () => {
  it('keeps every session on the version it started on through publish and rollback', async () => {
    ctx = await createTestApp();
    const { app } = ctx;
    await release(app, 1);
    const s1 = await openSession(app);
    expect(s1.status).toBe(201);
    expect(s1.data.session.funnelVersion).toBe(1);

    await release(app, 2);
    const s1Again = await getSession(app, s1.sessionId);
    expect(s1Again.data.session.funnelVersion).toBe(1);
    expect(s1Again.data.funnel).toEqual(resolveVariant(loadConfig(1), s1.data.session.variant));
    expect(s1Again.data.funnel.sequence).not.toContain('meeting_hours');
    const s2 = await openSession(app);
    expect(s2.data.session.funnelVersion).toBe(2);
    expect(s2.data.funnel.sequence).toContain('meeting_hours');

    await release(app, 3);
    const s3 = await openSession(app);
    expect(s3.data.session.funnelVersion).toBe(3);

    expect((await rollback(app)).json()).toEqual({ activeVersion: 2, rolledBackFrom: 3 });
    const s4 = await openSession(app);
    expect(s4.data.session.funnelVersion).toBe(2);
    const s3Again = await getSession(app, s3.sessionId);
    expect(s3Again.data.session.funnelVersion).toBe(3);
    expect(s3Again.data.funnel).toEqual(resolveVariant(loadConfig(3), s3.data.session.variant));
    expect(s3Again.data.funnel.sequence).toContain('security_constraints');
    expect((await getSession(app, s1.sessionId)).data.session.funnelVersion).toBe(1);
  });
});

describe('Mandatory #2: A/B stability', () => {
  it('keeps the variant across GETs and ignores a variant sent for an existing session', async () => {
    ctx = await createTestApp({ random: () => 0.75 });
    await release(ctx.app, 1);
    const s = await openSession(ctx.app);
    expect(s.data.session).toMatchObject({ variant: 'B', assignment: 'random' });
    for (let i = 0; i < 3; i++) {
      expect((await getSession(ctx.app, s.sessionId)).data.session.variant).toBe('B');
    }

    const again = await openSession(ctx.app, { variant: 'A' }, s.sessionId);
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    expect(again.data.session).toMatchObject({ variant: 'B', assignment: 'random' });
  });

  it('applies a known variant override on creation and ignores an unknown one', async () => {
    ctx = await createTestApp({ random: () => 0.25 });
    await release(ctx.app, 1);
    const forced = await openSession(ctx.app, { variant: 'B' });
    expect(forced.data.session).toMatchObject({ variant: 'B', assignment: 'override' });
    expect(forced.data.funnel.steps.intro?.content.primaryActionLabel).toBe('Show me');

    const unknown = await openSession(ctx.app, { variant: 'C' });
    expect(unknown.status).toBe(201);
    expect(unknown.data.session).toMatchObject({ variant: 'A', assignment: 'random' });
  });

  it('splits 2,000 random sessions 45–55% between A and B', async () => {
    ctx = await createTestApp({ random: Math.random });
    await release(ctx.app, 1);
    let a = 0;
    for (let i = 0; i < 2000; i++) {
      if ((await openSession(ctx.app)).data.session.variant === 'A') a += 1;
    }
    expect(a / 2000).toBeGreaterThanOrEqual(0.45);
    expect(a / 2000).toBeLessThanOrEqual(0.55);
  });
});

describe('Mandatory #7: state and result', () => {
  const saveState = (sessionId: string, body: object) =>
    ctx.app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/state`, payload: body });
  const submitResult = (sessionId: string, body: object) =>
    ctx.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/result`, payload: body });

  async function startOnV1B() {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    return openSession(ctx.app, { variant: 'B' });
  }

  it('saves state with a rev and answers a stale rev with 409 and the server state', async () => {
    const { sessionId, data } = await startOnV1B();
    expect(data.state).toEqual({ answers: {}, currentStepId: 'intro', rev: 0 });

    const first = await saveState(sessionId, { answers: { work_mode: 'remote' }, currentStepId: 'timezone_span', rev: 0 });
    expect(first.statusCode).toBe(200);
    expect(first.json<SaveStateResponse>().state).toEqual({ answers: { work_mode: 'remote' }, currentStepId: 'timezone_span', rev: 1 });

    const stale = await saveState(sessionId, { answers: { work_mode: 'office' }, currentStepId: 'timezone_span', rev: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ApiError>()).toMatchObject({
      error: 'rev_conflict',
      details: { state: { answers: { work_mode: 'remote' }, currentStepId: 'timezone_span', rev: 1 } },
    });
    expect((await getSession(ctx.app, sessionId)).data.state.rev).toBe(1);
  });

  it('normalizes answers on save', async () => {
    const { sessionId } = await startOnV1B();
    const res = await saveState(sessionId, { answers: { team_size: '12', priorities: ['speed', 'focus'] }, currentStepId: 'team_size', rev: 0 });
    expect(res.json<SaveStateResponse>().state.answers).toEqual({ team_size: 12, priorities: ['speed', 'focus'] });
  });

  it('rejects invalid answers with 422, unknown questions and steps with 4xx', async () => {
    const { sessionId } = await startOnV1B();
    const invalid = await saveState(sessionId, { answers: { team_size: 0, work_mode: 'moon' }, currentStepId: 'team_size', rev: 0 });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<ApiError>()).toMatchObject({
      error: 'invalid_answers',
      details: [
        { stepId: 'team_size', answer: 'team_size', code: 'min', message: 'The team must have at least one person.' },
        { stepId: 'work_mode', answer: 'work_mode', code: 'invalid_option' },
      ],
    });

    // meeting_hours only exists from v2 on.
    const unknown = await saveState(sessionId, { answers: { meeting_hours: 3 }, currentStepId: 'work_mode', rev: 0 });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<ApiError>().details).toEqual([
      { stepId: null, answer: 'meeting_hours', code: 'unknown_answer', message: '"meeting_hours" is not a question of this funnel' },
    ]);

    const badStep = await saveState(sessionId, { answers: {}, currentStepId: 'meeting_hours', rev: 0 });
    expect(badStep.statusCode).toBe(400);
    expect(badStep.json<ApiError>().error).toBe('bad_request');

    const malformed = await saveState(sessionId, { answers: {}, rev: -1 });
    expect(malformed.statusCode).toBe(400);
    expect((await getSession(ctx.app, sessionId)).data.state.rev).toBe(0);
  });

  it('answers an incomplete result request with 409 and the missing steps', async () => {
    const { sessionId } = await startOnV1B();
    const res = await submitResult(sessionId, { answers: { work_mode: 'remote', timezone_span: 'same' } });
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiError>()).toMatchObject({
      error: 'incomplete',
      details: { missingStepIds: ['team_size', 'async_maturity', 'priorities', 'tool_count'] },
    });
  });

  it('computes the result with the variant B title, stores it and stays idempotent', async () => {
    const { sessionId, data } = await startOnV1B();
    const answers = answersFor(data.funnel, { work_mode: 'hybrid' });
    const first = await submitResult(sessionId, { answers });
    expect(first.statusCode).toBe(200);
    const body = first.json<ResultResponse>();
    expect(body.resultId).toBe('hybrid_structured');
    expect(body.result.title).toBe('Your hybrid model needs clearer rules');
    expect(body.result.cta).toEqual({ label: 'See the 30-day action list', action: 'expand_recommendation' });
    expect(body.state).toEqual({ answers, currentStepId: 'result', rev: 1 });

    const completedAt = ctx.db.prepare('SELECT completed_at FROM sessions WHERE session_id = ?').pluck().get(sessionId);
    ctx.clock.advanceHours(1);
    const second = await submitResult(sessionId, { answers });
    expect(second.json<ResultResponse>()).toMatchObject({ resultId: 'hybrid_structured', state: { rev: 2 } });
    expect(ctx.db.prepare('SELECT completed_at FROM sessions WHERE session_id = ?').pluck().get(sessionId)).toBe(completedAt);
    expect((await getSession(ctx.app, sessionId)).data.session.resultId).toBe('hybrid_structured');
  });

  it('expires a session after the TTL without activity (410) and slides the TTL on activity', async () => {
    const { sessionId, data } = await startOnV1B();
    expect(data.session.expiresAt).toBe('2026-10-11T10:00:00.000Z');

    ctx.clock.advanceHours(48);
    const touched = await getSession(ctx.app, sessionId);
    expect(touched.data.session.expiresAt).toBe('2026-10-13T10:00:00.000Z');
    ctx.clock.advanceHours(48);
    expect((await getSession(ctx.app, sessionId)).status).toBe(200);

    ctx.clock.advanceHours(73);
    const expired = await getSession(ctx.app, sessionId);
    expect(expired.status).toBe(410);
    expect(expired.data).toMatchObject({ error: 'session_expired' });
    expect((await saveState(sessionId, { answers: {}, currentStepId: 'intro', rev: 0 })).statusCode).toBe(410);
    expect((await submitResult(sessionId, { answers: {} })).statusCode).toBe(410);
    expect((await openSession(ctx.app, {}, sessionId)).status).toBe(410);
  });
});

describe('session API', () => {
  it('stores UTM parameters and writes session_started in the same transaction', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const { sessionId, data } = await openSession(ctx.app, { utm: { source: 'google', campaign: 'brand ' } });
    expect(data.session.utm).toEqual({ source: 'google', medium: null, campaign: 'brand', content: null, term: null });
    const started = ctx.db.prepare('SELECT * FROM events WHERE session_id = ?').all(sessionId);
    expect(started).toEqual([
      expect.objectContaining({
        event_id: `session_started:${sessionId}`,
        name: 'session_started',
        step_id: null,
        funnel_version: 1,
        variant: 'A',
        assignment: 'random',
        utm_source: 'google',
        utm_campaign: 'brand',
        client_ts: null,
        server_ts: '2026-10-08T10:00:00.000Z',
        properties_json: '{}',
      }),
    ]);
  });

  it('accepts an empty body, also with a JSON content type', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const noBody = await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${randomUUID()}` });
    expect(noBody.statusCode).toBe(201);
    const emptyJson = await ctx.app.inject({
      method: 'PUT',
      url: `/api/sessions/${randomUUID()}`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(emptyJson.statusCode).toBe(201);
  });

  it('creates one session for concurrent PUTs with the same id', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const sessionId = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => openSession(ctx.app, {}, sessionId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(count(ctx.db, 'SELECT COUNT(*) FROM sessions')).toBe(1);
    expect(count(ctx.db, "SELECT COUNT(*) FROM events WHERE name = 'session_started'")).toBe(1);
  });

  it('validates ids and reports unknown sessions and a missing active version', async () => {
    ctx = await createTestApp();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/sessions/not-a-uuid' })).statusCode).toBe(400);
    const missing = await getSession(ctx.app, randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.data).toMatchObject({ error: 'not_found' });

    const noVersion = await openSession(ctx.app);
    expect(noVersion.status).toBe(503);
    expect(noVersion.data).toEqual({ error: 'internal', message: 'No active version' });
    const otherFunnel = await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${randomUUID()}?funnelId=Bad_Id` });
    expect(otherFunnel.statusCode).toBe(400);
  });

  it('creates the session on the funnel given in the query and needs no funnel to return it', async () => {
    ctx = await createTestApp({ defaultFunnelId: undefined });
    await release(ctx.app, 1);
    expect((await openSession(ctx.app)).status).toBe(400);
    const sessionId = randomUUID();
    const res = await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}?funnelId=workstyle-planner` });
    expect(res.statusCode).toBe(201);
    expect(res.json<SessionResponse>().session.funnelId).toBe('workstyle-planner');
    expect((await openSession(ctx.app, {}, sessionId)).status).toBe(200);
  });
});
