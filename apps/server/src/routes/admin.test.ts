import type {
  ApiError,
  CreateVersionResponse,
  FunnelAdminResponse,
  ValidateConfigResponse,
  VersionConfigResponse,
} from '@funnel/contracts';
import { readRawConfig } from '@funnel/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FUNNEL_ID,
  count,
  createTestApp,
  openSession,
  publishVersion,
  release,
  rollback,
  uploadVersion,
  type TestContext,
} from '../test/helpers';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

const overview = async () => (await ctx.app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}` })).json<FunnelAdminResponse>();

describe('Mandatory #4: publish and rollback', () => {
  it('rejects an invalid config with 422 and keeps the active version', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const broken = readRawConfig(2) as any;
    broken.steps.office_days.visibleWhen.operator = 'matches';

    const res = await uploadVersion(ctx.app, broken);
    expect(res.statusCode).toBe(422);
    const body = res.json<ApiError>();
    expect(body.error).toBe('config_invalid');
    expect(body.details).toMatchObject({ errors: [{ path: 'steps.office_days.visibleWhen', message: 'Unsupported operator "matches"' }] });
    expect((await overview()).activeVersion).toBe(1);
    expect(count(ctx.db, 'SELECT COUNT(*) FROM funnel_versions')).toBe(1);
  });

  it('rejects a config of another funnel', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/funnels/other-funnel/versions', payload: readRawConfig(1) });
    expect(res.statusCode).toBe(422);
    expect(res.json<ApiError>().details).toMatchObject({ errors: [{ path: 'funnelId' }] });
  });

  it('treats an identical config as already stored, also with a different key order', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const same = await uploadVersion(ctx.app, readRawConfig(1));
    expect(same.statusCode).toBe(200);
    expect(same.json<CreateVersionResponse>()).toEqual({ version: 1, created: false, warnings: [] });

    const reordered = Object.fromEntries(Object.entries(readRawConfig(1)).reverse());
    expect((await uploadVersion(ctx.app, reordered)).json<CreateVersionResponse>().created).toBe(false);
  });

  it('rejects the same version number with different content with 409', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    const changed = readRawConfig(1);
    changed.title = 'Changed title';
    const res = await uploadVersion(ctx.app, changed);
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiError>().error).toBe('version_conflict');
  });

  it('answers a rollback without a previous version with 409', async () => {
    ctx = await createTestApp();
    expect((await rollback(ctx.app)).statusCode).toBe(409);
    await release(ctx.app, 1);
    const res = await rollback(ctx.app);
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiError>().error).toBe('no_previous_version');
    expect((await overview()).activeVersion).toBe(1);
  });

  it('publishes v2 and v3, then rolls back twice to v1', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    await release(ctx.app, 2);
    await release(ctx.app, 3);
    expect((await overview()).activeVersion).toBe(3);

    expect((await rollback(ctx.app)).json()).toEqual({ activeVersion: 2, rolledBackFrom: 3 });
    expect((await rollback(ctx.app)).json()).toEqual({ activeVersion: 1, rolledBackFrom: 2 });
    const after = await overview();
    expect(after.activeVersion).toBe(1);
    expect(after.rollbackTarget).toBeNull();
    expect(after.releases.map((r) => [r.action, r.version, r.fromVersion])).toEqual([
      ['rollback', 1, 2],
      ['rollback', 2, 3],
      ['publish', 3, 2],
      ['publish', 2, 1],
      ['publish', 1, null],
    ]);
    expect((await openSession(ctx.app)).data.session.funnelVersion).toBe(1);
  });

  it('treats publishing the active version as a no-op and rejects an unknown version', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    expect((await publishVersion(ctx.app, 1)).json()).toEqual({ activeVersion: 1, previousVersion: 1 });
    expect(count(ctx.db, 'SELECT COUNT(*) FROM funnel_releases')).toBe(1);

    const unknown = await publishVersion(ctx.app, 7);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<ApiError>().error).toBe('not_found');
    const malformed = await ctx.app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL_ID}/publish`, payload: { version: 'two' } });
    expect(malformed.statusCode).toBe(400);
  });

  it('can publish an older version again, which makes the previous one the rollback target', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    await release(ctx.app, 2);
    expect((await publishVersion(ctx.app, 1)).json()).toEqual({ activeVersion: 1, previousVersion: 2 });
    expect(await overview()).toMatchObject({ activeVersion: 1, rollbackTarget: 2 });
    expect((await rollback(ctx.app)).json()).toEqual({ activeVersion: 2, rolledBackFrom: 1 });
  });
});

describe('admin API', () => {
  it('lists versions and releases newest first with session counts', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 1);
    await openSession(ctx.app);
    await openSession(ctx.app);
    await release(ctx.app, 2);
    await openSession(ctx.app);
    expect((await uploadVersion(ctx.app, readRawConfig(3))).statusCode).toBe(201);

    const body = await overview();
    expect(body).toMatchObject({ funnelId: FUNNEL_ID, activeVersion: 2, rollbackTarget: 1 });
    expect(body.versions.map((v) => [v.version, v.isActive, v.sessions])).toEqual([
      [3, false, 0],
      [2, true, 1],
      [1, false, 2],
    ]);
    expect(body.versions[0]).toMatchObject({
      experimentId: 'question-order-and-result-framing-v3',
      releaseNote: 'Adds a compliance branch, shortens variant B and introduces recommendation_expanded.',
      createdAt: '2026-10-08T10:00:00.000Z',
    });
    expect(body.versions[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(body.releases.map((r) => r.version)).toEqual([2, 1]);
  });

  it('returns an empty overview for a funnel without versions and 400 for a malformed id', async () => {
    ctx = await createTestApp();
    expect(await overview()).toEqual({ funnelId: FUNNEL_ID, activeVersion: null, rollbackTarget: null, versions: [], releases: [] });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/funnels/Not_Valid' })).statusCode).toBe(400);
  });

  it('returns a stored config exactly as uploaded', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 2);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}/versions/2` });
    expect(res.json<VersionConfigResponse>()).toEqual({ funnelId: FUNNEL_ID, version: 2, config: readRawConfig(2) });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}/versions/9` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL_ID}/versions/abc` })).statusCode).toBe(400);
  });

  it('validates a candidate against the active version without storing it', async () => {
    ctx = await createTestApp();
    await release(ctx.app, 2);
    const validate = (config: object) =>
      ctx.app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL_ID}/validate`, payload: config });

    const candidate = (await validate(readRawConfig(3))).json<ValidateConfigResponse>();
    expect(candidate).toMatchObject({ ok: true, version: 3, errors: [], warnings: [], versionStatus: 'new' });
    expect(candidate.diff).toMatchObject({
      fromVersion: 2,
      toVersion: 3,
      stepsAdded: ['security_constraints'],
      eventsAdded: ['recommendation_expanded'],
    });
    expect(count(ctx.db, 'SELECT COUNT(*) FROM funnel_versions')).toBe(1);

    expect((await validate(readRawConfig(2))).json<ValidateConfigResponse>().versionStatus).toBe('identical');
    const conflicting = readRawConfig(2);
    conflicting.title = 'Changed';
    expect((await validate(conflicting)).json<ValidateConfigResponse>().versionStatus).toBe('conflict');

    const invalid = (await validate({ funnelId: FUNNEL_ID })).json<ValidateConfigResponse>();
    expect(invalid).toMatchObject({ ok: false, version: null, diff: null, versionStatus: null });
    expect(invalid.errors.length).toBeGreaterThan(0);
  });
});
