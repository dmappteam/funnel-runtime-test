import { ApiClient } from './api';
import { Simulation, runPool } from './simulation';
import type { Transport } from './transport';

export interface DemoTrafficOptions {
  transport: Transport;
  sessions: number;
  concurrency?: number;
  /** Defaults to the current time, so every run draws new users. */
  seed?: number;
}

export interface DemoTrafficResult {
  /** Version the new sessions were pinned to. */
  version: number | null;
  sessions: number;
  completed: number;
  events: { accepted: number; duplicate: number; rejected: number };
}

/** The `generate` scenario as a library call: new demo sessions on the active version, without console output or checks. */
export async function runDemoTraffic(o: DemoTrafficOptions): Promise<DemoTrafficResult> {
  const sim = new Simulation({ api: new ApiClient(o.transport), seed: o.seed ?? Date.now(), now: Date.now() });
  const users = Array.from({ length: o.sessions }, () => sim.newUser());
  await runPool(users, o.concurrency ?? 8, (user) => user.start());
  const records = users.map((u) => u.record);
  const totals = sim.ingestion.totals();
  return {
    version: records.find((r) => r.version !== null)?.version ?? null,
    sessions: records.filter((r) => r.version !== null).length,
    completed: records.filter((r) => r.status === 'completed').length,
    events: { accepted: totals.uniqueValid, duplicate: totals.resentValid, rejected: totals.invalidEvents },
  };
}
