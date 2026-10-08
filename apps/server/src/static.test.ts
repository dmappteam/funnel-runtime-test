import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiError } from '@funnel/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, basicAuthHeader, createTestApp, type TestContext } from './test/helpers';

const INDEX = '<!doctype html><title>Funnel</title><div id="root"></div>';
let webDist: string;

beforeAll(() => {
  webDist = mkdtempSync(join(tmpdir(), 'funnel-web-'));
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), INDEX);
  writeFileSync(join(webDist, 'assets', 'index-3f2a1b.js'), 'console.log(1)');
  writeFileSync(join(webDist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

const get = (url: string, headers?: Record<string, string>) => ctx.app.inject({ method: 'GET', url, headers });

describe('web app', () => {
  it('serves index.html without caching and hashed assets as immutable', async () => {
    ctx = await createTestApp({ webDistDir: webDist });
    for (const url of ['/', '/index.html']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toBe(INDEX);
    }
    const asset = await get('/assets/index-3f2a1b.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/favicon.svg')).headers['cache-control']).toBe('no-cache');
  });

  it('falls back to index.html for app routes but not for the API', async () => {
    ctx = await createTestApp({ webDistDir: webDist });
    for (const url of ['/some/deep/link', '/admin', '/dashboard?version=2']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toBe(INDEX);
    }
    const api = await get('/api/nope');
    expect(api.statusCode).toBe(404);
    expect(api.json<ApiError>().error).toBe('not_found');
    expect((await ctx.app.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404);
  });

  it('protects the admin and dashboard pages, not the funnel or its assets', async () => {
    ctx = await createTestApp({ webDistDir: webDist, adminAuth: ADMIN });
    for (const url of ['/admin', '/admin/', '/dashboard', '/%61dmin']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['www-authenticate']).toBeDefined();
    }
    expect((await get('/admin', basicAuthHeader(ADMIN.user, ADMIN.password))).body).toBe(INDEX);
    expect((await get('/')).statusCode).toBe(200);
    expect((await get('/assets/index-3f2a1b.js')).statusCode).toBe(200);
  });

  it('answers every unknown route with JSON 404 when no web app is configured', async () => {
    ctx = await createTestApp();
    const res = await get('/');
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiError>()).toEqual({ error: 'not_found', message: 'Route GET / not found' });
  });
});
