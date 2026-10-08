import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveStateRequest, SaveStateResponse, SessionState } from '@funnel/contracts';
import { HttpError } from '../api/http';
import { createStateSync, type StateSyncOptions } from './stateSync';

const SESSION_ID = '0b7f6c1e-8a4d-4c52-9a8e-3f1d2c4b5a69';

interface Call {
  body: SaveStateRequest;
  ok: (rev: number) => void;
  fail: (err: unknown) => void;
}

/** A save function whose requests the test settles one by one. */
function controlledSave() {
  const calls: Call[] = [];
  const save = vi.fn(
    (_sessionId: string, body: SaveStateRequest) =>
      new Promise<SaveStateResponse>((resolve, reject) => {
        calls.push({
          body,
          ok: (rev) => resolve({ state: { answers: body.answers, currentStepId: body.currentStepId, rev } }),
          fail: reject,
        });
      }),
  );
  return { save, calls };
}

function setup(overrides: Partial<StateSyncOptions> = {}) {
  const { save, calls } = controlledSave();
  const onConflict = vi.fn();
  const onExpired = vi.fn();
  const sync = createStateSync({ sessionId: SESSION_ID, rev: 0, onConflict, onExpired, save, random: () => 0.5, ...overrides });
  return { sync, save, calls, onConflict, onExpired };
}

const conflict = (state: SessionState) =>
  new HttpError(409, { error: 'rev_conflict', message: 'State changed', details: { state } });

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('state sync', () => {
  it('keeps one request in flight and sends only the newest queued snapshot with the new rev', async () => {
    const { sync, calls } = setup();
    sync.save({ answers: { work_mode: 'remote' }, currentStepId: 'meeting_hours' });
    sync.save({ answers: { work_mode: 'remote', meeting_hours: 4 }, currentStepId: 'timezone_span' });
    sync.save({ answers: { work_mode: 'remote', meeting_hours: 5 }, currentStepId: 'timezone_span' });
    expect(calls).toHaveLength(1);

    calls[0]!.ok(1);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ answers: { work_mode: 'remote', meeting_hours: 5 }, currentStepId: 'timezone_span', rev: 1 });
  });

  it('retries a failed save after a backoff', async () => {
    const { sync, calls } = setup();
    sync.save({ answers: { work_mode: 'office' }, currentStepId: 'meeting_hours' });
    calls[0]!.fail(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
  });

  it('adopts the server state when another tab saved different answers', async () => {
    const { sync, calls, onConflict } = setup();
    const server: SessionState = { answers: { work_mode: 'hybrid', meeting_hours: 20 }, currentStepId: 'timezone_span', rev: 4 };
    sync.save({ answers: { work_mode: 'remote' }, currentStepId: 'meeting_hours' });
    sync.save({ answers: { work_mode: 'remote', meeting_hours: 2 }, currentStepId: 'timezone_span' });
    calls[0]!.fail(conflict(server));
    await settle();
    expect(onConflict).toHaveBeenCalledWith(server);
    expect(calls).toHaveLength(1);

    sync.save({ answers: server.answers, currentStepId: 'team_size' });
    expect(calls[1]!.body.rev).toBe(4);
  });

  it('only refreshes the rev when the conflicting state has the same answers', async () => {
    const { sync, calls, onConflict } = setup();
    const answers = { work_mode: 'remote' };
    sync.save({ answers, currentStepId: 'meeting_hours' });
    calls[0]!.fail(conflict({ answers, currentStepId: 'result', rev: 3 }));
    await settle();
    expect(onConflict).not.toHaveBeenCalled();
    expect(calls[1]!.body).toEqual({ answers, currentStepId: 'meeting_hours', rev: 3 });
  });

  it('stops and reports an expired session', async () => {
    const { sync, calls, onExpired } = setup();
    sync.save({ answers: {}, currentStepId: 'intro' });
    calls[0]!.fail(new HttpError(410, { error: 'session_expired', message: 'Session expired' }));
    await settle();
    expect(onExpired).toHaveBeenCalledTimes(1);
    sync.save({ answers: {}, currentStepId: 'work_mode' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });

  it('runs the result request between saves and continues with its rev', async () => {
    const { sync, calls } = setup();
    const answers = { work_mode: 'remote' };
    sync.save({ answers, currentStepId: 'result' });

    let resolveResult!: () => void;
    const write = vi.fn(
      () =>
        new Promise<{ state: SessionState }>((resolve) => {
          resolveResult = () => resolve({ state: { answers, currentStepId: 'result', rev: 2 } });
        }),
    );
    const result = sync.exclusive(write);
    await settle();
    expect(write).not.toHaveBeenCalled(); // waits for the save in flight

    calls[0]!.ok(1);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    sync.save({ answers, currentStepId: 'meeting_hours' });
    expect(calls).toHaveLength(1); // held while the result request runs

    resolveResult();
    await expect(result).resolves.toMatchObject({ state: { rev: 2 } });
    await settle();
    expect(calls[1]!.body).toEqual({ answers, currentStepId: 'meeting_hours', rev: 2 });
  });

  it('skips a queued save that the result request has already stored', async () => {
    const { sync, calls } = setup();
    const answers = { work_mode: 'remote' };
    sync.save({ answers, currentStepId: 'tool_count' });
    sync.save({ answers, currentStepId: 'result' });
    const result = sync.exclusive(async () => ({ state: { answers, currentStepId: 'result', rev: 2 } }));
    calls[0]!.ok(1);
    await result;
    await settle();
    expect(calls).toHaveLength(1);
  });
});
