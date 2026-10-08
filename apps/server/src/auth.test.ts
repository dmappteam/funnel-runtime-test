import { randomUUID } from 'node:crypto';
import type { AggregateInput, AnalyticsReport, ApiError } from '@funnel/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CHALLENGE, checkBasicAuth } from './auth';
import {
  ADMIN,
  FUNNEL_ID,
  basicAuthHeader,
  clientEvent,
  createTestApp,
  release,
  type TestContext,
} from './test/helpers';

// The real aggregate() is merged from the analytics track. Here it only has to return something.
vi.mock('@funnel/analytics', () => ({
  aggregate: (input: AggregateInput): AnalyticsReport => ({
    generatedAt: input.now ?? '',
    filters: input.filters,
    available: { versions: [], campaigns: [] },
    totals: { events: input.events.length, sessions: 0, overrideSessions: 0 },
    versions: [],
    groups: [],
    ab: [],
  }),
}));

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

const admin = basicAuthHeader(ADMIN.user, ADMIN.password);
const protectedRequests = [
  { method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}` },
  { method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}/versions/1` },
  { method: 'POST', url: `/api/admin/funnels/${FUNNEL_ID}/rollback` },
  { method: 'GET', url: '/api/analytics' },
] as const;

describe('Mandatory #9: basic auth', () => {
  it('answers 401 with a challenge on admin and analytics without valid credentials', async () => {
    ctx = await createTestApp({ adminAuth: ADMIN });
    await release(ctx.app, 1, admin);
    const wrong = [{}, basicAuthHeader(ADMIN.user, 'wrong'), basicAuthHeader('root', ADMIN.password), { authorization: 'Bearer x' }];
    for (const request of protectedRequests) {
      for (const headers of wrong) {
        const res = await ctx.app.inject({ ...request, headers });
        expect(res.statusCode, `${request.method} ${request.url}`).toBe(401);
        expect(res.headers['www-authenticate']).toBe(AUTH_CHALLENGE);
        expect(res.json<ApiError>()).toEqual({ error: 'unauthorized', message: 'Authentication required' });
      }
    }
    expect((await ctx.app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}` })).statusCode).toBe(401);
  });

  it('serves admin and analytics with valid credentials', async () => {
    ctx = await createTestApp({ adminAuth: ADMIN });
    await release(ctx.app, 1, admin);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}`, headers: admin })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/analytics', headers: admin })).statusCode).toBe(200);
  });

  it('cannot be bypassed with a percent-encoded path', async () => {
    ctx = await createTestApp({ adminAuth: ADMIN });
    const res = await ctx.app.inject({ method: 'GET', url: `/api/%61dmin/funnels/${FUNNEL_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('keeps session, event and health endpoints public', async () => {
    ctx = await createTestApp({ adminAuth: ADMIN });
    await release(ctx.app, 1, admin);
    const sessionId = randomUUID();
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}` })).statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).statusCode).toBe(200);
    const events = await ctx.app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { events: [clientEvent(ctx.clock, sessionId, { name: 'step_viewed', step_id: 'intro' })] },
    });
    expect(events.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('is off when no credentials are configured', async () => {
    ctx = await createTestApp();
    expect((await ctx.app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}` })).statusCode).toBe(200);
  });
});

describe('cross-site guard', () => {
  it('rejects mutating admin requests started by another site, even with valid credentials', async () => {
    ctx = await createTestApp({ adminAuth: ADMIN });
    await release(ctx.app, 1, admin);
    const url = `/api/admin/funnels/${FUNNEL_ID}/rollback`;
    for (const site of ['cross-site', 'same-site']) {
      const res = await ctx.app.inject({ method: 'POST', url, headers: { ...admin, 'sec-fetch-site': site } });
      expect(res.statusCode, site).toBe(403);
      expect(res.json<ApiError>().error).toBe('forbidden');
    }
    // Same-origin pages and non-browser clients pass; the rollback then fails only because there is one version.
    for (const headers of [{ ...admin, 'sec-fetch-site': 'same-origin' }, admin]) {
      expect((await ctx.app.inject({ method: 'POST', url, headers })).statusCode).toBe(409);
    }
    // Reads stay available, e.g. a dashboard link opened from a chat.
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/funnels/${FUNNEL_ID}`,
      headers: { ...admin, 'sec-fetch-site': 'cross-site' },
    });
    expect(read.statusCode).toBe(200);
  });
});

describe('checkBasicAuth', () => {
  const header = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

  it('splits at the first colon, so a password may contain colons', () => {
    expect(checkBasicAuth(header('admin:a:b'), { user: 'admin', password: 'a:b' })).toBe(true);
    expect(checkBasicAuth(header('admin:a'), { user: 'admin', password: 'a:b' })).toBe(false);
  });

  it('rejects missing and malformed headers', () => {
    const expected = { user: 'admin', password: 'x' };
    expect(checkBasicAuth(undefined, expected)).toBe(false);
    expect(checkBasicAuth('Basic', expected)).toBe(false);
    expect(checkBasicAuth('Basic !!!', expected)).toBe(false);
    expect(checkBasicAuth(header('no-colon'), expected)).toBe(false);
    expect(checkBasicAuth(`basic ${Buffer.from('admin:x').toString('base64')}`, expected)).toBe(true);
  });
});
