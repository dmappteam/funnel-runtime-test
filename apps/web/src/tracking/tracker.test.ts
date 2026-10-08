// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FunnelConfigSchema, resolveVariant } from '@funnel/engine';
import {
  finalizeEvent,
  recommendationExpanded,
  resultStepId,
  stepViewed,
  type ClientEvent,
  type EventBatchResponse,
  type EventContext,
  type EventStatus,
} from '@funnel/contracts';
import v1 from '../../../../configs/funnel-v1.json';
import v3 from '../../../../configs/funnel-v3.json';
import { FLUSH_DELAY_MS, OUTBOX_KEY, createTracker, type Tracker, type TrackerOptions } from './tracker';

function context(raw: unknown): EventContext {
  return {
    sessionId: '0b7f6c1e-8a4d-4c52-9a8e-3f1d2c4b5a69',
    funnel: resolveVariant(FunnelConfigSchema.parse(raw), 'A'),
    utm: { source: 'google', medium: 'cpc', campaign: 'brand' },
  };
}

const v1ctx = context(v1);
const v3ctx = context(v3);
const intro = () => stepViewed(v3ctx.funnel, {}, 'intro');

function batchResponse(events: ClientEvent[], status: EventStatus = 'accepted'): EventBatchResponse {
  return {
    accepted: status === 'accepted' ? events.length : 0,
    duplicates: status === 'duplicate' ? events.length : 0,
    rejected: status === 'rejected' ? events.length : 0,
    results: events.map((e, index) => ({ index, event_id: e.event_id, status })),
  };
}

type Reply = { status: number; body?: unknown } | Error;

/** fetch mock answering requests with the queued replies in order. Without a reply every event is accepted. */
function server(replies: Reply[] = []) {
  const batches: ClientEvent[][] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const events = (JSON.parse(String(init.body)) as { events: ClientEvent[] }).events;
    batches.push(events);
    const reply = replies.shift() ?? { status: 200 };
    if (reply instanceof Error) throw reply;
    const body = reply.body ?? batchResponse(events);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => body };
  });
  return { fetch, batches, replies, ids: () => batches.map((b) => b.map((e) => e.event_id)) };
}

/** Lets pending promises (fetch responses) settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

let trackers: Tracker[] = [];

function start(options: TrackerOptions = {}): Tracker {
  const tracker = createTracker({ random: () => 0.5, sendBeacon: null, ...options });
  tracker.setContext(v3ctx);
  trackers.push(tracker);
  return tracker;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  trackers.forEach((t) => t.stop());
  trackers = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tracker', () => {
  it('persists an event before any request and sends it from the next page load', async () => {
    const offline = server();
    const first = start({ fetch: offline.fetch });
    const event = first.track(intro())!;
    expect(JSON.parse(localStorage.getItem(OUTBOX_KEY)!)).toEqual([event]);
    expect(offline.fetch).not.toHaveBeenCalled();
    first.stop(); // the tab is closed before the flush

    const api = server();
    const second = start({ fetch: api.fetch });
    await settle();
    expect(api.batches).toEqual([[event]]);
    expect(second.pending()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(OUTBOX_KEY)!)).toEqual([]);
  });

  it('waits 2 s for a small queue and flushes at once when 10 events are queued', async () => {
    const api = server();
    const tracker = start({ fetch: api.fetch });
    for (let i = 0; i < 3; i++) tracker.track(intro());
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 1);
    expect(api.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.batches.map((b) => b.length)).toEqual([3]);

    for (let i = 0; i < 10; i++) tracker.track(intro());
    expect(api.batches.map((b) => b.length)).toEqual([3, 10]);
    await settle();
    expect(tracker.pending()).toEqual([]);
  });

  it('sends at most 100 events per request and keeps one request in flight', async () => {
    const leftovers = Array.from(
      { length: 150 },
      (_, i) => finalizeEvent(intro(), v3ctx, `evt-${String(i).padStart(8, '0')}`, new Date().toISOString())!,
    );
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(leftovers));

    const api = server();
    const waiting: Array<() => void> = [];
    const tracker = start({
      fetch: (url, init) => new Promise((resolve) => waiting.push(() => resolve(api.fetch(url, init)))),
    });
    expect(waiting).toHaveLength(1);
    tracker.track(intro());
    expect(waiting).toHaveLength(1);

    waiting.shift()!();
    await settle();
    expect(waiting).toHaveLength(1);
    waiting.shift()!();
    await settle();

    expect(api.batches.map((b) => b.length)).toEqual([100, 51]);
    expect(api.batches[0]!.map((e) => e.event_id)).toEqual(leftovers.slice(0, 100).map((e) => e.event_id));
    expect(tracker.pending()).toEqual([]);
  });

  it('retries after a network error and a 5xx with the same event_id, backing off 1 s then 2 s', async () => {
    const api = server([new TypeError('Failed to fetch'), { status: 503 }]);
    const tracker = start({ fetch: api.fetch });
    const event = tracker.track(intro())!;

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(tracker.pending()).toEqual([event]);

    await vi.advanceTimersByTimeAsync(999);
    expect(api.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(tracker.pending()).toEqual([event]);

    await vi.advanceTimersByTimeAsync(1999);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.ids()).toEqual([[event.event_id], [event.event_id], [event.event_id]]);
    expect(tracker.pending()).toEqual([]);
  });

  it('does not send new requests while backing off from a 429', async () => {
    const api = server([{ status: 429 }]);
    const tracker = start({ fetch: api.fetch });
    for (let i = 0; i < 10; i++) tracker.track(intro());
    await settle();
    expect(api.fetch).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 12; i++) tracker.track(intro());
    expect(api.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.batches.map((b) => b.length)).toEqual([10, 22]);
    expect(tracker.pending()).toEqual([]);
  });

  it('removes accepted, duplicate and rejected events and keeps an event without a result', async () => {
    const api = server();
    const tracker = start({ fetch: api.fetch });
    const [a, b, c, d] = [0, 1, 2, 3].map(() => tracker.track(intro())!);
    api.replies.push({
      status: 200,
      body: {
        accepted: 1,
        duplicates: 1,
        rejected: 1,
        results: [
          { index: 0, event_id: a!.event_id, status: 'accepted' },
          { index: 1, event_id: b!.event_id, status: 'duplicate' },
          { index: 2, event_id: c!.event_id, status: 'rejected', reason: 'invalid_payload' },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(tracker.pending()).toEqual([d]);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(api.ids()).toEqual([[a!.event_id, b!.event_id, c!.event_id, d!.event_id], [d!.event_id]]);
    expect(tracker.pending()).toEqual([]);
  });

  it('drops a batch the server refuses as a whole instead of retrying it forever', async () => {
    const api = server([{ status: 400, body: { error: 'bad_request', message: 'bad batch' } }]);
    const tracker = start({ fetch: api.fetch });
    tracker.track(intro());
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(tracker.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips events the pinned version does not allow', async () => {
    const api = server();
    const tracker = start({ fetch: api.fetch });
    tracker.setContext(v1ctx);
    const draft = recommendationExpanded(resultStepId(v1ctx.funnel), 'balanced', 'expand_recommendation');
    expect(tracker.track(draft)).toBeNull();
    expect(tracker.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(api.fetch).not.toHaveBeenCalled();

    tracker.setContext(v3ctx);
    expect(tracker.track(draft)).toMatchObject({
      name: 'recommendation_expanded',
      funnel_version: 3,
      variant: 'A',
      properties: { result_id: 'balanced', action: 'expand_recommendation', source: 'cta' },
    });
  });

  it('beacons the outbox as text/plain when the page is hidden and keeps the events', async () => {
    const beacons: Blob[] = [];
    const sendBeacon = vi.fn((_url: string, data: Blob) => beacons.push(data) > 0);
    const tracker = start({ fetch: server().fetch, sendBeacon });
    const events = [tracker.track(intro())!, tracker.track(intro())!];

    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledWith('/api/events', expect.any(Blob));
    expect(beacons[0]!.type.toLowerCase()).toBe('text/plain;charset=utf-8');
    expect(JSON.parse(await beacons[0]!.text())).toEqual({ events });
    expect(tracker.pending()).toEqual(events);

    // A tab close fires both events: the identical payload is not sent twice.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    tracker.track(intro());
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it('keeps working in memory when storage is unavailable', async () => {
    const api = server();
    const tracker = start({ fetch: api.fetch, storage: null });
    const event = tracker.track(intro())!;
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
    expect(tracker.pending()).toEqual([event]);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(api.batches).toEqual([[event]]);
    expect(tracker.pending()).toEqual([]);
  });
});
