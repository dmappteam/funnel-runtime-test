import { randomUUID } from 'node:crypto';
import {
  ctaClicked,
  finalizeEvent,
  resultViewed,
  stepViewed,
  type AnalyticsResponse,
  type EventDraft,
  type SessionResponse,
} from '@funnel/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FUNNEL_ID, clientEvent, createTestApp, openSession, postEvents, release, type TestContext } from '../test/helpers';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe('Mandatory #10: analytics route', () => {
  // End to end with the real aggregate(). src/services/analytics.test.ts covers the route wiring with a stub.
  it('returns the aggregated report of the default funnel with ingestion stats', async () => {
    const picks = [0.25, 0.75];
    ctx = await createTestApp({ random: () => picks.shift() ?? 0.25 });
    await release(ctx.app, 1);
    const a = await openSession(ctx.app, { utm: { campaign: 'brand' } });
    const b = await openSession(ctx.app);
    await openSession(ctx.app, { variant: 'B' });
    expect([a.data.session.variant, b.data.session.variant]).toEqual(['A', 'B']);

    const send = (session: { sessionId: string; data: SessionResponse }, drafts: EventDraft[]) =>
      postEvents(
        ctx.app,
        drafts.map((draft) =>
          finalizeEvent(
            draft,
            { sessionId: session.sessionId, funnel: session.data.funnel, utm: session.data.session.utm },
            randomUUID(),
            ctx.clock.now().toISOString(),
          ),
        ),
      );
    await send(a, [
      stepViewed(a.data.funnel, {}, 'intro'),
      resultViewed('result', 'balanced'),
      ctaClicked('result', 'balanced', 'expand_recommendation'),
    ]);
    await send(b, [stepViewed(b.data.funnel, {}, 'intro')]);
    await postEvents(ctx.app, [clientEvent(ctx.clock, randomUUID(), { name: 'step_viewed', step_id: 'intro' })]);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/analytics' });
    expect(res.statusCode).toBe(200);
    const report = res.json<AnalyticsResponse>();
    expect(report.filters).toEqual({ funnelId: FUNNEL_ID, version: null, campaign: null, includeOverrides: false });
    expect(report.available.versions).toEqual([1]);
    expect(report.available.campaigns).toEqual(expect.arrayContaining(['brand', '(none)']));
    expect(report.totals.overrideSessions).toBe(1);
    expect(report.groups.find((g) => g.variant === 'A')?.kpi).toMatchObject({ started: 1, reachedResult: 1, ctaClicked: 1 });
    expect(report.groups.find((g) => g.variant === 'B')?.kpi).toMatchObject({ started: 1, reachedResult: 0, ctaClicked: 0 });
    expect(report.ab).toHaveLength(1);
    expect(report.ingestion).toEqual({ rejected: 1, rejectedByReason: { unknown_session: 1 } });
  });
});
