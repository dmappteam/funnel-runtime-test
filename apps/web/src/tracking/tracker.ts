import {
  MAX_BATCH_SIZE,
  finalizeEvent,
  type ClientEvent,
  type EventBatchResponse,
  type EventContext,
  type EventDraft,
} from '@funnel/contracts';
import { backoffDelay, isRetryableStatus } from './backoff';
import { randomId } from './uuid';

export const OUTBOX_KEY = 'funnel-runtime:outbox';
export const EVENTS_ENDPOINT = '/api/events';
/** Queue length that triggers an immediate flush. */
export const FLUSH_THRESHOLD = 10;
/** Delay after the first unsent event before a smaller queue is flushed. */
export const FLUSH_DELAY_MS = 2000;
/** Oldest events are dropped beyond this, so a long outage cannot fill localStorage. */
const MAX_OUTBOX = 1000;

type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export interface TrackerOptions {
  endpoint?: string;
  /** `null` keeps the outbox in memory only. Defaults to `localStorage` when it is accessible. */
  storage?: Storage | null;
  fetch?: FetchLike;
  sendBeacon?: ((url: string, data: Blob) => boolean) | null;
  /** Source of `pagehide`, `visibilitychange` and `online`. */
  window?: Window | null;
  now?: () => Date;
  uuid?: () => string;
  random?: () => number;
}

export interface Tracker {
  /** Session the next events belong to. Events tracked without a context are dropped. */
  setContext(ctx: EventContext | null): void;
  /** Persists the event synchronously, then schedules a flush. `null` when the pinned version does not allow it. */
  track(draft: EventDraft): ClientEvent | null;
  /** Sends up to 100 queued events now, unless a request is already in flight. */
  flush(): Promise<void>;
  pending(): ClientEvent[];
  stop(): void;
}

interface Outbox {
  read(): ClientEvent[];
  write(events: ClientEvent[]): void;
}

/**
 * The outbox is re-read before every change, so events another tab added in the meantime survive.
 * When storage is blocked or full the outbox continues in memory.
 */
function createOutbox(storage: Storage | null): Outbox {
  let memory: ClientEvent[] = [];
  let persistent = storage !== null;
  return {
    read() {
      if (!persistent) return memory;
      let raw: string | null;
      try {
        raw = storage!.getItem(OUTBOX_KEY);
      } catch {
        persistent = false;
        return memory;
      }
      try {
        const parsed: unknown = JSON.parse(raw ?? '[]');
        return Array.isArray(parsed) ? (parsed as ClientEvent[]) : [];
      } catch {
        return [];
      }
    },
    write(events) {
      memory = events;
      if (!persistent) return;
      try {
        storage!.setItem(OUTBOX_KEY, JSON.stringify(events));
      } catch {
        persistent = false;
      }
    },
  };
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function defaultBeacon(): ((url: string, data: Blob) => boolean) | null {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return null;
  return (url, data) => navigator.sendBeacon(url, data);
}

export function createTracker(options: TrackerOptions = {}): Tracker {
  const endpoint = options.endpoint ?? EVENTS_ENDPOINT;
  const outbox = createOutbox(options.storage === undefined ? defaultStorage() : options.storage);
  const send: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const sendBeacon = options.sendBeacon === undefined ? defaultBeacon() : options.sendBeacon;
  const win = options.window === undefined ? (typeof window === 'undefined' ? null : window) : options.window;
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomId;
  const random = options.random ?? Math.random;

  let ctx: EventContext | null = null;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed requests. While > 0 the scheduled retry owns the next request. */
  let failures = 0;
  let stopped = false;
  let lastBeacon = '';

  const schedule = (delayMs: number) => {
    if (timer !== null || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const remove = (ids: Set<string>) => {
    if (ids.size > 0) outbox.write(outbox.read().filter((e) => !ids.has(e.event_id)));
  };

  /** `true` when the batch is settled, `false` when it has to be retried. */
  async function post(batch: ClientEvent[]): Promise<boolean> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      return false;
    }
    if (!res.ok) {
      if (isRetryableStatus(res.status)) return false;
      // The batch as a whole was refused: resending the same payload cannot succeed and would block the queue.
      remove(new Set(batch.map((e) => e.event_id)));
      return true;
    }
    let body: EventBatchResponse;
    try {
      body = (await res.json()) as EventBatchResponse;
    } catch {
      return false;
    }
    if (!Array.isArray(body?.results)) return false;
    // accepted, duplicate and rejected are all final. An event without a result stays for the next flush.
    const settled = body.results
      .map((r) => batch[r.index]?.event_id ?? r.event_id)
      .filter((id): id is string => typeof id === 'string');
    remove(new Set(settled));
    return true;
  }

  async function flush(): Promise<void> {
    if (inFlight || stopped) return;
    const batch = outbox.read().slice(0, MAX_BATCH_SIZE);
    if (batch.length === 0) {
      // Another tab sent what failed here: nothing is left to retry, so `track` schedules sends again.
      failures = 0;
      return;
    }
    cancelTimer();
    inFlight = true;
    let settled: boolean;
    try {
      settled = await post(batch);
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (!settled) {
      schedule(backoffDelay(failures++, random));
      return;
    }
    failures = 0;
    const left = outbox.read().length;
    if (left >= FLUSH_THRESHOLD) void flush();
    else if (left > 0) schedule(FLUSH_DELAY_MS);
  }

  function track(draft: EventDraft): ClientEvent | null {
    if (!ctx) return null;
    const event = finalizeEvent(draft, ctx, uuid(), now().toISOString());
    if (!event) return null;
    const queue = [...outbox.read(), event];
    outbox.write(queue.length > MAX_OUTBOX ? queue.slice(queue.length - MAX_OUTBOX) : queue);
    if (!inFlight && failures === 0) {
      if (queue.length >= FLUSH_THRESHOLD) void flush();
      else schedule(FLUSH_DELAY_MS);
    }
    return event;
  }

  /** Best effort on page exit. Events stay in the outbox: if they also arrive later, the server deduplicates by event_id. */
  function beacon() {
    if (!sendBeacon) return;
    const batch = outbox.read().slice(0, MAX_BATCH_SIZE);
    if (batch.length === 0) return;
    // `visibilitychange` and `pagehide` both fire when a tab closes: skip the second, identical payload.
    const key = batch.map((e) => e.event_id).join(',');
    if (key === lastBeacon) return;
    lastBeacon = key;
    try {
      sendBeacon(endpoint, new Blob([JSON.stringify({ events: batch })], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      // Ignored: the events are still in the outbox.
    }
  }

  const onPageHide = () => beacon();
  const onVisibilityChange = () => {
    if (win?.document.visibilityState === 'hidden') beacon();
  };
  const onOnline = () => {
    if (failures === 0 || inFlight) return;
    cancelTimer();
    void flush();
  };

  win?.addEventListener('pagehide', onPageHide);
  win?.addEventListener('online', onOnline);
  win?.document.addEventListener('visibilitychange', onVisibilityChange);

  // Leftovers of a previous page load (closed tab, offline, crash).
  if (outbox.read().length > 0) void flush();

  return {
    setContext(next) {
      ctx = next;
    },
    track,
    flush,
    pending: () => outbox.read(),
    stop() {
      stopped = true;
      cancelTimer();
      win?.removeEventListener('pagehide', onPageHide);
      win?.removeEventListener('online', onOnline);
      win?.document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

let shared: Tracker | null = null;

/** The page-wide tracker, created on first use so that the admin and dashboard pages never start one. */
export function getTracker(): Tracker {
  shared ??= createTracker();
  return shared;
}
