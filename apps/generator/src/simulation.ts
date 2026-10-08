import { randomUUID } from 'node:crypto';
import type { ApiClient } from './api';
import { drawPlan, type SessionPlan } from './behaviour';
import { IngestionLog } from './ingestion';
import { DEFAULT_CHAOS, Outbox, type ChaosRates } from './outbox';
import { Rng, hashSeed } from './random';
import { SessionClock, VirtualUser } from './virtualUser';

/** Id stream of one session. */
export type IdsFor = (sessionIndex: number) => () => string;

/** Random UUIDs: the same seed replays the same users, but a second run never collides with the first one's ids. */
export const randomIds: IdsFor = () => () => randomUUID();

/** Reproducible UUIDs for tests. */
export const seededIds =
  (seed: number): IdsFor =>
  (index) => {
    const rng = new Rng(hashSeed(seed, 'ids', index));
    return () => rng.uuid();
  };

export interface SimulationOptions {
  api: ApiClient;
  seed: number;
  /** Anchor of client time: sessions start within the 7 days before it. */
  now: number;
  chaos?: ChaosRates;
  idsFor?: IdsFor;
}

/**
 * Creates virtual users. Each session index has its own random streams (behaviour, transport, clock),
 * so a session behaves the same whatever the concurrency and whatever happens to other sessions.
 */
export class Simulation {
  readonly ingestion = new IngestionLog();
  readonly users: VirtualUser[] = [];
  private nextIndex = 0;

  constructor(private readonly options: SimulationOptions) {}

  /** `script` replaces parts of the drawn plan. */
  newUser(script: Partial<SessionPlan> = {}): VirtualUser {
    const { api, seed, now } = this.options;
    const index = this.nextIndex++;
    const rng = new Rng(hashSeed(seed, 'session', index));
    // Cloned: a user may change their mind (persona) and a script may be shared between users.
    const plan = structuredClone({ ...drawPlan(rng), ...script });
    const newId = (this.options.idsFor ?? randomIds)(index);
    const transportRng = new Rng(hashSeed(seed, 'transport', index));
    const outbox = new Outbox(api, this.ingestion, transportRng, this.options.chaos ?? DEFAULT_CHAOS, newId);
    const clock = new SessionClock(new Rng(hashSeed(seed, 'clock', index)), now);
    const user = new VirtualUser(index, newId(), plan, api, { rng, clock, outbox, newId });
    this.users.push(user);
    return user;
  }

  get records() {
    return this.users.map((u) => u.record);
  }
}

/** Runs `worker` over `items` with at most `concurrency` in flight. The first error stops new work and is rethrown. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  onDone?: (done: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  let failed = false;
  let failure: unknown;
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        await worker(items[index]!, index);
      } catch (err) {
        if (!failed) failure = err;
        failed = true;
        return;
      }
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
  if (failed) throw failure;
}
