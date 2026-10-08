import type { SaveStateRequest, SaveStateResponse, SessionState } from '@funnel/contracts';
import type { Answers } from '@funnel/engine';
import { HttpError } from '../api/http';
import { isSessionGone, saveState } from '../api/sessions';
import { backoffDelay, isRetryableStatus } from '../tracking/backoff';

export interface Snapshot {
  answers: Answers;
  currentStepId: string;
}

export interface StateSyncOptions {
  sessionId: string;
  rev: number;
  /** The server holds different answers, e.g. another tab moved on. The runtime adopts them. */
  onConflict: (state: SessionState) => void;
  /** The session expired or no longer exists (`isSessionGone`). The runtime starts a new one. */
  onExpired: () => void;
  save?: (sessionId: string, body: SaveStateRequest) => Promise<SaveStateResponse>;
  random?: () => number;
}

export interface StateSync {
  /** Queues the latest state. Only the newest snapshot is sent: each one contains all answers. */
  save(snapshot: Snapshot): void;
  /**
   * Runs another write to the session (the result request, which also bumps the rev) between saves:
   * it waits for the save in flight and holds queued saves until it is done, so the tab never conflicts with itself.
   */
  exclusive<T extends { state: SessionState }>(write: () => Promise<T>): Promise<T>;
  /** No more saves or retries, and a response that arrives later triggers no callback. */
  stop(): void;
}

function canonical(answers: Answers): string {
  return JSON.stringify(Object.keys(answers).sort().map((key) => [key, answers[key]]));
}

export function sameAnswers(a: Answers, b: Answers): boolean {
  return canonical(a) === canonical(b);
}

function sameState(a: Snapshot, b: Snapshot): boolean {
  return a.currentStepId === b.currentStepId && sameAnswers(a.answers, b.answers);
}

function conflictState(err: HttpError): SessionState | null {
  if (err.status !== 409 || err.body?.error !== 'rev_conflict') return null;
  const state = (err.body.details as { state?: SessionState } | undefined)?.state;
  return state && typeof state.rev === 'number' && typeof state.answers === 'object' ? state : null;
}

/** Background persistence of the session state: one write at a time, retries with backoff, optimistic concurrency by rev. */
export function createStateSync(options: StateSyncOptions): StateSync {
  const send = options.save ?? saveState;
  const random = options.random ?? Math.random;
  let rev = options.rev;
  let queued: Snapshot | null = null;
  /**
   * Snapshots sent with the current rev whose save may have been stored although no response arrived
   * (network error, retryable status). The server holds at most one of them.
   */
  let uncertain: Snapshot[] = [];
  let running: Promise<void> | null = null;
  let exclusiveWrites = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /** The server's rev is known again: a save sent with an older rev can no longer be stored. */
  const advance = (serverRev: number) => {
    rev = Math.max(rev, serverRev);
    uncertain = [];
  };

  const kick = () => {
    if (running || exclusiveWrites > 0 || timer !== null || !queued || stopped) return;
    running = run().finally(() => {
      running = null;
      kick();
    });
  };

  async function run() {
    const snapshot = queued!;
    queued = null;
    try {
      const res = await send(options.sessionId, { ...snapshot, rev });
      if (stopped) return;
      advance(res.state.rev);
      failures = 0;
    } catch (err) {
      // After stop() the runtime is gone, e.g. replaced by a restarted session: a late response changes nothing.
      if (stopped) return;
      if (!(err instanceof HttpError) || isRetryableStatus(err.status)) {
        if (!uncertain.includes(snapshot)) uncertain.push(snapshot);
        queued ??= snapshot;
        timer = setTimeout(() => {
          timer = null;
          kick();
        }, backoffDelay(failures++, random));
      } else if (isSessionGone(err)) {
        stopped = true;
        options.onExpired();
      } else {
        const server = conflictState(err);
        if (server) {
          const own = uncertain.some((sent) => sameState(sent, server));
          advance(server.rev);
          if (own) {
            // This tab's earlier save was stored but its response was lost: the newer snapshot goes on top of it.
            if (!sameState(server, snapshot)) queued ??= snapshot;
          } else if (!sameAnswers(server.answers, snapshot.answers)) {
            queued = null;
            options.onConflict(server);
          } else if (server.currentStepId !== snapshot.currentStepId) {
            // Same answers (e.g. another tab at another step): only the position is outdated.
            queued ??= snapshot;
          }
        }
        // Any other client error cannot succeed on retry: the snapshot is dropped.
      }
    }
  }

  return {
    save(snapshot) {
      queued = snapshot;
      kick();
    },
    async exclusive(write) {
      exclusiveWrites++;
      try {
        if (running) await running;
        const value = await write();
        if (stopped) return value;
        advance(value.state.rev);
        if (queued && sameState(queued, value.state)) queued = null;
        return value;
      } finally {
        exclusiveWrites--;
        kick();
      }
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
