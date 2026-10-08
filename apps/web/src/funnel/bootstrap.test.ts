import { describe, expect, it, vi } from 'vitest';
import { FunnelConfigSchema, resolveVariant } from '@funnel/engine';
import type { CreateSessionRequest, SessionInfo, SessionResponse } from '@funnel/contracts';
import v3 from '../../../../configs/funnel-v3.json';
import { HttpError } from '../api/http';
import { bootstrapSession, launchRequest, restartRequest, type BootstrapDeps, type PendingSession } from './bootstrap';
import { readLaunchParams } from './url';

const STORED = '0b7f6c1e-8a4d-4c52-9a8e-3f1d2c4b5a69';
const config = FunnelConfigSchema.parse(v3);

function sessionResponse(sessionId: string, variant = 'A', created = false): SessionResponse {
  const session: SessionInfo = {
    sessionId,
    funnelId: config.funnelId,
    funnelVersion: config.version,
    experimentId: config.experiment.id,
    variant,
    assignment: 'random',
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
    createdAt: '2026-10-08T10:00:00.000Z',
    expiresAt: '2026-10-11T10:00:00.000Z',
    resultId: null,
  };
  return { created, session, funnel: resolveVariant(config, variant), state: { answers: {}, currentStepId: 'intro', rev: 0 } };
}

function deps(overrides: Partial<BootstrapDeps> & { stored?: string | null } = {}) {
  let ids = 0;
  const written: string[] = [];
  const created: Array<{ id: string; body: CreateSessionRequest }> = [];
  const value: BootstrapDeps = {
    getSession: vi.fn(async (id: string) => sessionResponse(id)),
    createSession: vi.fn(async (id: string, body: CreateSessionRequest) => {
      created.push({ id, body });
      return sessionResponse(id, body.variant ?? 'A', true);
    }),
    readSessionId: () => (overrides.stored === undefined ? STORED : overrides.stored),
    writeSessionId: (id) => written.push(id),
    newId: () => `9a1c1f2e-0000-4000-8000-00000000000${++ids}`,
    ...overrides,
  };
  return { deps: value, written, created };
}

const pending = (): { current: PendingSession | null } => ({ current: null });
const launch = (search: string) => launchRequest(readLaunchParams(search));

describe('session bootstrap', () => {
  it('continues the stored session', async () => {
    const { deps: d, created } = deps();
    const res = await bootstrapSession(launch('?utm_source=google'), pending(), d);
    expect(res.session.sessionId).toBe(STORED);
    expect(created).toEqual([]);
  });

  it.each([
    ['no stored session', '', { stored: null }],
    ['reset=1', '?reset=1', {}],
    ['an unknown session', '', { getSession: async () => Promise.reject(new HttpError(404, null)) }],
    ['an expired session', '', { getSession: async () => Promise.reject(new HttpError(410, null)) }],
    ['a QA link for another variant', '?variant=B', {}],
  ])('creates a new session for %s', async (_case, search, overrides) => {
    const { deps: d, created, written } = deps(overrides as Partial<BootstrapDeps>);
    const res = await bootstrapSession(launch(`${search}${search ? '&' : '?'}utm_campaign=spring`), pending(), d);
    expect(created).toHaveLength(1);
    expect(created[0]!.body.utm).toEqual({ campaign: 'spring' });
    expect(res.session.sessionId).toBe(created[0]!.id);
    expect(written).toEqual([created[0]!.id]);
  });

  it('keeps the stored session when the QA variant matches it', async () => {
    const { deps: d, created } = deps();
    await bootstrapSession(launch('?variant=A'), pending(), d);
    expect(created).toEqual([]);
  });

  it('repeats the same idempotent PUT when retried after a network error', async () => {
    const createSession = vi
      .fn<BootstrapDeps['createSession']>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async (id) => sessionResponse(id, 'B', true));
    const { deps: d } = deps({ stored: null, createSession });
    const attempt = pending();
    await expect(bootstrapSession(launch('?variant=B'), attempt, d)).rejects.toThrow('Failed to fetch');
    const res = await bootstrapSession(launch('?variant=B'), attempt, d);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[1]).toEqual(createSession.mock.calls[0]);
    expect(createSession.mock.calls[0]![1]).toEqual({ utm: {}, variant: 'B' });
    expect(res.session.sessionId).toBe(createSession.mock.calls[0]![0]);
    expect(attempt.current).toBeNull();
  });

  it('surfaces a network error while loading the stored session', async () => {
    const { deps: d, created } = deps({ getSession: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(bootstrapSession(launch(''), pending(), d)).rejects.toThrow('Failed to fetch');
    expect(created).toEqual([]);
  });

  it('restarts an expired session with the same attribution and forced variant', () => {
    const session: SessionInfo = {
      ...sessionResponse(STORED, 'B').session,
      assignment: 'override',
      utm: { source: 'google', medium: null, campaign: 'spring', content: null, term: null },
    };
    expect(restartRequest(session)).toEqual({ utm: { source: 'google', campaign: 'spring' }, variant: 'B', fresh: true, session: null });
    expect(restartRequest({ ...session, assignment: 'preview' }).variant).toBe('B');
    expect(restartRequest({ ...session, assignment: 'random' }).variant).toBeNull();
  });

  it('opens an admin preview from the URL without replacing the stored session', async () => {
    const preview = '5e0c2b7a-3d1f-4a8b-9c6d-7e5f4a3b2c1d';
    const { deps: d, created, written } = deps();
    const res = await bootstrapSession(launch(`?session=${preview}`), pending(), d);
    expect(res.session.sessionId).toBe(preview);
    expect(created).toEqual([]);
    expect(written).toEqual([]);
  });

  it('falls back to the stored session when the preview is gone', async () => {
    const getSession = vi.fn(async (id: string) => {
      if (id === STORED) return sessionResponse(id);
      throw new HttpError(410, null);
    });
    const { deps: d } = deps({ getSession });
    const res = await bootstrapSession(launch('?session=5e0c2b7a-3d1f-4a8b-9c6d-7e5f4a3b2c1d'), pending(), d);
    expect(res.session.sessionId).toBe(STORED);
  });
});

describe('launch parameters', () => {
  it('reads utm, a valid variant, reset and step', () => {
    expect(readLaunchParams('?utm_source=%20google%20&utm_medium=&variant=B&reset=1&step=work_mode')).toEqual({
      utm: { source: 'google' },
      variant: 'B',
      reset: true,
      step: 'work_mode',
      session: null,
    });
    expect(readLaunchParams('?variant=../../etc').variant).toBeNull();
    expect(readLaunchParams('?session=5E0C2B7A-3D1F-4A8B-9C6D-7E5F4A3B2C1D').session).toBe('5E0C2B7A-3D1F-4A8B-9C6D-7E5F4A3B2C1D');
    expect(readLaunchParams('?session=not-a-session').session).toBeNull();
  });
});
