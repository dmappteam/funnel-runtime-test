import { randomUUID } from 'node:crypto';
import type { AggregateInput, AnalyticsReport, AnalyticsResponse } from '@funnel/contracts';
import { readRawConfig } from '@funnel/engine/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FUNNEL_ID,
  clientEvent,
  createTestApp,
  openSession,
  postEvents,
  release,
  type TestContext,
} from '../test/helpers';

// Checks what the route hands to aggregate(), independent of the analytics track's implementation.
const aggregate = vi.hoisted(() =>
  vi.fn(
    (input: AggregateInput): AnalyticsReport => ({
      generatedAt: input.now ?? '',
      filters: input.filters,
      available: { versions: [], campaigns: [] },
      totals: { events: input.events.length, sessions: 0, overrideSessions: 0, previewSessions: 0 },
      versions: [],
      groups: [],
      ab: [],
    }),
  ),
);
vi.mock('@funnel/analytics', () => ({ aggregate }));

let ctx: TestContext;
afterEach(async () => {
  aggregate.mockClear();
  await ctx?.close();
});

describe('analytics route wiring', () => {
  it('passes the funnel events, the configs of their versions and the filters, and adds ingestion stats', async () => {
    ctx = await createTestApp();
    const { app } = ctx;
    await release(app, 1);
    const a = await openSession(app, { utm: { campaign: 'brand' } });
    await release(app, 2);
    const b = await openSession(app, { variant: 'B' });

    const other = { ...readRawConfig(1), funnelId: 'other-funnel' };
    await app.inject({ method: 'POST', url: '/api/admin/funnels/other-funnel/versions', payload: other });
    await app.inject({ method: 'POST', url: '/api/admin/funnels/other-funnel/publish', payload: { version: 1 } });
    await app.inject({ method: 'PUT', url: `/api/sessions/${randomUUID()}?funnelId=other-funnel` });

    const viewed = clientEvent(ctx.clock, a.sessionId, { name: 'step_viewed', step_id: 'intro', properties: { step_type: 'info' } });
    await postEvents(app, [
      viewed,
      clientEvent(ctx.clock, randomUUID(), { name: 'step_viewed', step_id: 'intro' }),
      { name: 'garbage' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/analytics' });
    expect(res.statusCode).toBe(200);
    expect(aggregate).toHaveBeenCalledTimes(1);
    const input = aggregate.mock.calls[0]![0];
    expect(input.filters).toEqual({ funnelId: FUNNEL_ID, version: null, campaign: null, includeOverrides: false });
    expect(input.now).toBe('2026-10-08T10:00:00.000Z');
    expect(input.events).toHaveLength(3);
    expect(input.events.every((e) => e.funnel_id === FUNNEL_ID)).toBe(true);
    expect(input.events.find((e) => e.event_id === viewed.event_id)).toEqual({
      event_id: viewed.event_id,
      session_id: a.sessionId,
      name: 'step_viewed',
      step_id: 'intro',
      funnel_id: FUNNEL_ID,
      funnel_version: 1,
      experiment_id: 'question-order-and-result-framing-v1',
      variant: 'A',
      assignment: 'random',
      utm_source: null,
      utm_medium: null,
      utm_campaign: 'brand',
      client_ts: '2026-10-08T10:00:00.000Z',
      server_ts: '2026-10-08T10:00:00.000Z',
      properties: { step_type: 'info' },
    });
    expect(input.events.find((e) => e.session_id === b.sessionId)).toMatchObject({ funnel_version: 2, assignment: 'override' });
    expect(Object.keys(input.configs)).toEqual(['1', '2']);
    expect(input.configs[2]?.version).toBe(2);

    expect(res.json<AnalyticsResponse>().ingestion).toEqual({
      rejected: 2,
      rejectedByReason: { unknown_session: 1, invalid_payload: 1 },
    });
  });

  it('maps the query string to filters and rejects a malformed one', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/analytics?funnelId=other-funnel&version=2&campaign=(none)&includeOverrides=true',
    });
    expect(res.statusCode).toBe(200);
    expect(aggregate.mock.calls[0]![0].filters).toEqual({
      funnelId: 'other-funnel',
      version: 2,
      campaign: '(none)',
      includeOverrides: true,
    });
    expect(res.json<AnalyticsResponse>().ingestion).toEqual({ rejected: 0, rejectedByReason: {} });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/analytics?version=latest' })).statusCode).toBe(400);
  });
});
