import { randomUUID } from 'node:crypto';
import {
  answerSubmitted,
  finalizeEvent,
  recommendationExpanded,
  resultStepId,
  stepViewed,
  type ApiError,
  type EventBatchResponse,
} from '@funnel/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clientEvent,
  count,
  createTestApp,
  getSession,
  openSession,
  postEvents,
  release,
  rollback,
  type TestContext,
} from '../test/helpers';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

const clientEventCount = () => count(ctx.db, "SELECT COUNT(*) FROM events WHERE name <> 'session_started'");

async function startOnV1() {
  ctx = await createTestApp();
  await release(ctx.app, 1);
  return openSession(ctx.app, { utm: { source: 'google', medium: 'cpc', campaign: 'brand' } });
}

describe('Mandatory #3: deduplication', () => {
  it('reports a repeated batch as duplicates and stores nothing new', async () => {
    const { sessionId } = await startOnV1();
    const batch = ['intro', 'team_size', 'work_mode'].map((stepId) =>
      clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: stepId, properties: { step_type: 'info' } }),
    );

    const first = await postEvents(ctx.app, batch);
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
    expect(clientEventCount()).toBe(3);

    const second = await postEvents(ctx.app, batch);
    expect(second.data).toMatchObject({ accepted: 0, duplicates: 3, rejected: 0 });
    expect(second.data.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(clientEventCount()).toBe(3);
  });

  it('accepts 4 of 5 events and dead-letters the invalid one with its reason', async () => {
    const { sessionId } = await startOnV1();
    const batch: unknown[] = ['intro', 'team_size', 'work_mode', 'priorities'].map((stepId) =>
      clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: stepId }),
    );
    const invalidId = randomUUID();
    batch.splice(2, 0, { event_id: invalidId, session_id: sessionId, name: 'step_viewed', step_id: 'intro' });

    const res = await postEvents(ctx.app, batch);
    expect(res.data).toMatchObject({ accepted: 4, duplicates: 0, rejected: 1 });
    expect(res.data.results[2]).toMatchObject({ index: 2, event_id: invalidId, status: 'rejected', reason: 'invalid_payload' });
    expect(res.data.results[2]!.message).toContain('client_ts');

    const rejected = ctx.db.prepare('SELECT * FROM rejected_events').all();
    expect(rejected).toEqual([
      expect.objectContaining({
        event_id: invalidId,
        session_id: sessionId,
        reason: 'invalid_payload',
        payload_json: JSON.stringify(batch[2]),
        received_at: '2026-10-08T10:00:00.000Z',
      }),
    ]);
    expect(clientEventCount()).toBe(4);
  });

  it('logs a re-sent invalid event once per reason and still answers rejected every time', async () => {
    const { sessionId } = await startOnV1();
    const invalid = { event_id: randomUUID(), session_id: sessionId, name: 'step_viewed', step_id: 'intro' };
    const noId = { session_id: sessionId, name: 'step_viewed', step_id: 'intro' };

    // A beacon and the later flush carry the same event, and the generator re-sends whole batches.
    const first = await postEvents(ctx.app, [invalid, invalid, noId]);
    const second = await postEvents(ctx.app, [invalid, noId]);
    expect(first.data).toMatchObject({ accepted: 0, duplicates: 0, rejected: 3 });
    expect(second.data).toMatchObject({ accepted: 0, duplicates: 0, rejected: 2 });
    expect(second.data.results).toEqual([
      expect.objectContaining({ event_id: invalid.event_id, status: 'rejected', reason: 'invalid_payload' }),
      expect.objectContaining({ event_id: null, status: 'rejected', reason: 'invalid_payload' }),
    ]);
    // The same id failing for another reason is a new entry.
    const unknownSession = clientEvent(ctx.clock, randomUUID(), { name: 'step_viewed', step_id: 'intro', event_id: invalid.event_id });
    await postEvents(ctx.app, [unknownSession]);

    expect(ctx.db.prepare('SELECT event_id, reason FROM rejected_events ORDER BY id').all()).toEqual([
      { event_id: invalid.event_id, reason: 'invalid_payload' },
      { event_id: null, reason: 'invalid_payload' },
      { event_id: null, reason: 'invalid_payload' },
      { event_id: invalid.event_id, reason: 'unknown_session' },
    ]);
    expect(ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rejected_events'").pluck().all()).toEqual([
      'idx_rejected_events_event_id',
    ]);
  });

  it('marks the second copy of an event id within one batch as duplicate', async () => {
    const { sessionId } = await startOnV1();
    const event = clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'intro' });
    const res = await postEvents(ctx.app, [event, { ...event }]);
    expect(res.data.results.map((r) => r.status)).toEqual(['accepted', 'duplicate']);
    expect(clientEventCount()).toBe(1);
  });

  it('writes one session_started however often the session is created', async () => {
    const { sessionId } = await startOnV1();
    for (let i = 0; i < 3; i++) expect((await openSession(ctx.app, {}, sessionId)).status).toBe(200);
    await Promise.all(Array.from({ length: 5 }, () => openSession(ctx.app, {}, sessionId)));
    expect(count(ctx.db, "SELECT COUNT(*) FROM events WHERE name = 'session_started'")).toBe(1);
    expect(count(ctx.db, 'SELECT COUNT(*) FROM sessions')).toBe(1);
  });
});

describe('Mandatory #5: enrichment and privacy', () => {
  it('takes version, variant, experiment and UTM from the session, not from the client', async () => {
    const { sessionId } = await startOnV1();
    const event = clientEvent(ctx.clock, sessionId, {
      name: 'step_viewed',
      step_id: 'intro',
      funnel_id: 'other-funnel',
      funnel_version: 3,
      experiment_id: 'forged-experiment',
      variant: 'B',
      utm_source: 'forged',
      utm_campaign: null,
    });
    expect((await postEvents(ctx.app, [event])).data.accepted).toBe(1);
    expect(ctx.db.prepare('SELECT * FROM events WHERE event_id = ?').get(event.event_id)).toMatchObject({
      funnel_id: 'workstyle-planner',
      funnel_version: 1,
      experiment_id: 'question-order-and-result-framing-v1',
      variant: 'A',
      assignment: 'random',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'brand',
      client_ts: '2026-10-08T10:00:00.000Z',
      server_ts: '2026-10-08T10:00:00.000Z',
    });
  });

  it('drops properties outside the event whitelist, so raw answers are never stored', async () => {
    const { sessionId } = await startOnV1();
    const event = clientEvent(ctx.clock, sessionId, {
      name: 'answer_submitted',
      step_id: 'work_mode',
      properties: { answer_kind: 'single_select', answer: 'remote', work_mode: 'remote' },
    });
    expect((await postEvents(ctx.app, [event])).data.accepted).toBe(1);
    expect(ctx.db.prepare('SELECT properties_json FROM events WHERE event_id = ?').pluck().get(event.event_id)).toBe(
      '{"answer_kind":"single_select"}',
    );
    expect(count(ctx.db, "SELECT COUNT(*) FROM events WHERE properties_json LIKE '%remote%'")).toBe(0);
  });

  it('normalizes the client time to UTC', async () => {
    const { sessionId } = await startOnV1();
    const event = clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'intro', client_ts: '2026-10-08T13:00:00+03:00' });
    await postEvents(ctx.app, [event]);
    expect(ctx.db.prepare('SELECT client_ts FROM events WHERE event_id = ?').pluck().get(event.event_id)).toBe('2026-10-08T10:00:00.000Z');
  });
});

describe('Mandatory #6: events are validated against the pinned version', () => {
  it('accepts recommendation_expanded from a v3 session after a rollback to v2 and rejects it from a v1 session', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const v1 = await openSession(ctx.app);
    await release(ctx.app, 2);
    await release(ctx.app, 3);
    const v3 = await openSession(ctx.app);
    await rollback(ctx.app);
    expect((await openSession(ctx.app)).data.session.funnelVersion).toBe(2);

    const expanded = (sessionId: string) => {
      const draft = recommendationExpanded(resultStepId(v3.data.funnel), 'balanced', 'expand_recommendation');
      return clientEvent(ctx.clock, sessionId, { ...draft });
    };
    const res = await postEvents(ctx.app, [expanded(v3.sessionId), expanded(v1.sessionId)]);
    expect(res.data.results[0]).toMatchObject({ status: 'accepted' });
    expect(res.data.results[1]).toMatchObject({ status: 'rejected', reason: 'event_not_allowed' });
    expect(ctx.db.prepare("SELECT funnel_version, properties_json FROM events WHERE name = 'recommendation_expanded'").all()).toEqual([
      { funnel_version: 3, properties_json: '{"result_id":"balanced","action":"expand_recommendation","source":"cta"}' },
    ]);
  });
});

describe('event ingestion', () => {
  it('accepts events built with the shared builders', async () => {
    const { sessionId, data } = await startOnV1();
    const context = { sessionId, funnel: data.funnel, utm: { source: 'google', medium: 'cpc', campaign: 'brand' } };
    const ts = ctx.clock.now().toISOString();
    const events = [
      finalizeEvent(stepViewed(data.funnel, {}, 'team_size'), context, randomUUID(), ts),
      finalizeEvent(answerSubmitted(data.funnel, 'team_size'), context, randomUUID(), ts),
    ];
    expect((await postEvents(ctx.app, events)).data).toMatchObject({ accepted: 2, rejected: 0 });
  });

  it('rejects each invalid event with its reason', async () => {
    const { sessionId } = await startOnV1();
    const e = (fields: Parameters<typeof clientEvent>[2]) => clientEvent(ctx.clock, sessionId, fields);
    const batch = [
      e({ name: 'session_started', step_id: 'intro' }),
      clientEvent(ctx.clock, randomUUID(), { name: 'step_viewed', step_id: 'intro' }),
      e({ name: 'recommendation_expanded', step_id: 'result' }),
      e({ name: 'step_viewed', step_id: 'meeting_hours' }),
      e({ name: 'step_viewed' }),
      e({ name: 'back_clicked', step_id: 'work_mode', properties: { destination_step_id: 'security_constraints' } }),
      e({ name: 'step_completed', step_id: 'work_mode', properties: { next_step_id: 'nowhere' } }),
      e({ name: 'step_viewed', step_id: 'intro', properties: { visible_step_index: 'first' } }),
      e({ name: 'result_viewed', step_id: 'result', properties: { result_id: 'regulated_scale' } }),
      e({ name: 'cta_clicked', step_id: 'result', properties: { result_id: 'balanced', action: { nested: true } } }),
      'not an event',
    ];
    const res = await postEvents(ctx.app, batch);
    expect(res.data.results.map((r) => r.reason)).toEqual([
      'server_only_event',
      'unknown_session',
      'event_not_allowed',
      'unknown_step',
      'unknown_step',
      'unknown_step',
      'unknown_step',
      'invalid_properties',
      'invalid_properties',
      'invalid_properties',
      'invalid_payload',
    ]);
    expect(res.data).toMatchObject({ accepted: 0, rejected: batch.length });
    expect(count(ctx.db, 'SELECT COUNT(*) FROM rejected_events')).toBe(batch.length);
    expect(res.data.results.at(-1)).toMatchObject({ event_id: null });
  });

  it('accepts a null next_step_id and a valid back navigation', async () => {
    const { sessionId } = await startOnV1();
    const res = await postEvents(ctx.app, [
      clientEvent(ctx.clock, sessionId, { name: 'step_completed', step_id: 'tool_count', properties: { next_step_id: null } }),
      clientEvent(ctx.clock, sessionId, { name: 'back_clicked', step_id: 'work_mode', properties: { destination_step_id: 'team_size' } }),
    ]);
    expect(res.data.accepted).toBe(2);
  });

  it('accepts sendBeacon bodies sent as text/plain', async () => {
    const { sessionId } = await startOnV1();
    const event = clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'intro' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify({ events: [event] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EventBatchResponse>().accepted).toBe(1);
  });

  it('answers a malformed batch with 400', async () => {
    const { sessionId } = await startOnV1();
    const post = (payload: string, contentType = 'application/json') =>
      ctx.app.inject({ method: 'POST', url: '/api/events', headers: { 'content-type': contentType }, payload });
    expect((await post('{"events": []}')).statusCode).toBe(400);
    expect((await post('{}')).statusCode).toBe(400);
    expect((await post('{"events": [')).json<ApiError>()).toMatchObject({ error: 'bad_request' });
    expect((await post('not json', 'text/plain')).statusCode).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'intro' }));
    expect((await post(JSON.stringify({ events: tooMany }))).statusCode).toBe(400);
    expect(count(ctx.db, 'SELECT COUNT(*) FROM rejected_events')).toBe(0);
  });

  it('truncates a huge rejected payload to 10 KB', async () => {
    const { sessionId } = await startOnV1();
    const huge = { ...clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'intro' }), client_ts: 'x'.repeat(50_000) };
    await postEvents(ctx.app, [huge]);
    const payload = ctx.db.prepare('SELECT payload_json FROM rejected_events').pluck().get() as string;
    expect(payload.length).toBe(10 * 1024);
  });

  it('slides the session TTL on accepted events of live sessions only', async () => {
    const { sessionId } = await startOnV1();
    ctx.clock.advanceHours(48);
    await postEvents(ctx.app, [clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'intro' })]);
    expect((await getSession(ctx.app, sessionId)).data.session.expiresAt).toBe('2026-10-13T10:00:00.000Z');

    ctx.clock.advanceHours(100);
    const late = await postEvents(ctx.app, [clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'team_size' })]);
    expect(late.data.accepted).toBe(1);
    expect((await getSession(ctx.app, sessionId)).status).toBe(410);
  });
});
