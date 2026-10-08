import type { SaveStateRequest, SaveStateResponse, SessionState } from '@funnel/contracts';
import type { Answers } from '@funnel/engine';
import { HttpError } from '../api/http';
import { saveState } from '../api/sessions';
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
  onExpired: () => void;
  save?: (sessionId: string, body: SaveStateRequest) => Promise<SaveStateResponse>;
  random?: () => number;
}

export interface StateSync {
  /** Queues the latest state. Only the newest snapshot is sent: each one contains all answers. */
  save(snapshot: Snapshot): void;
  /** Records the rev returned by another write to the session (the result request). */
  observeRev(rev: number): void;
  stop(): void;
}

function canonical(answers: Answers): string {
  return JSON.stringify(Object.keys(answers).sort().map((key) => [key, answers[key]]));
}

export function sameAnswers(a: Answers, b: Answers): boolean {
  return canonical(a) === canonical(b);
}

function conflictState(err: HttpError): SessionState | null {
  if (err.status !== 409 || err.body?.error !== 'rev_conflict') return null;
  const state = (err.body.details as { state?: SessionState } | undefined)?.state;
  return state && typeof state.rev === 'number' && typeof state.answers === 'object' ? state : null;
}

/** Background persistence of the session state: one request at a time, retries with backoff, optimistic concurrency by rev. */
export function createStateSync(options: StateSyncOptions): StateSync {
  const send = options.save ?? saveState;
  const random = options.random ?? Math.random;
  let rev = options.rev;
  let queued: Snapshot | null = null;
  let inFlight = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const kick = () => {
    if (!inFlight && timer === null && queued && !stopped) void run();
  };

  async function run() {
    const snapshot = queued!;
    queued = null;
    inFlight = true;
    let retry = false;
    try {
      const res = await send(options.sessionId, { ...snapshot, rev });
      rev = Math.max(rev, res.state.rev);
      failures = 0;
    } catch (err) {
      if (!(err instanceof HttpError) || isRetryableStatus(err.status)) {
        retry = true;
        queued ??= snapshot;
      } else if (err.status === 410) {
        stopped = true;
        options.onExpired();
      } else {
        const server = conflictState(err);
        if (server) {
          rev = Math.max(rev, server.rev);
          if (!sameAnswers(server.answers, snapshot.answers)) {
            queued = null;
            options.onConflict(server);
          } else if (server.currentStepId !== snapshot.currentStepId) {
            // Same answers (our own earlier write won the race): only the position is outdated.
            queued ??= snapshot;
          }
        }
        // Any other client error cannot succeed on retry: the snapshot is dropped.
      }
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (retry) {
      timer = setTimeout(() => {
        timer = null;
        kick();
      }, backoffDelay(failures++, random));
      return;
    }
    kick();
  }

  return {
    save(snapshot) {
      queued = snapshot;
      kick();
    },
    observeRev(next) {
      rev = Math.max(rev, next);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
