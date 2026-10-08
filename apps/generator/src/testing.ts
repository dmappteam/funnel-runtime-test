import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeServer, type FakeServerOptions } from './fakeServer';
import { runScenario, type RunOptions, type RunResult } from './scenarios';
import { seededIds } from './simulation';

/** Test helpers. */

export const CONFIGS_DIR = fileURLToPath(new URL('../../../configs', import.meta.url));
export const ADMIN = { user: 'admin', password: 'secret' };
export const NOW = Date.parse('2026-10-08T12:00:00.000Z');

export function rawConfig(version: 1 | 2 | 3): string {
  return readFileSync(`${CONFIGS_DIR}/funnel-v${version}.json`, 'utf8');
}

export interface FakeRun extends RunResult {
  server: FakeServer;
  output: string[];
}

/** Runs a scenario against a fresh fake server with reproducible ids, no backoff delays and captured output. */
export async function runFake(
  run: Partial<RunOptions>,
  server: Partial<FakeServerOptions> = {},
): Promise<FakeRun> {
  const fake = new FakeServer({ configs: [rawConfig(1)], admin: ADMIN, ...server });
  const output: string[] = [];
  const seed = run.seed ?? 42;
  const result = await runScenario({
    transport: fake,
    scenario: 'generate',
    sessions: 40,
    seed,
    concurrency: 4,
    configsDir: CONFIGS_DIR,
    admin: ADMIN,
    verify: true,
    url: 'fake://server',
    idsFor: seededIds(seed),
    now: NOW,
    sleep: async () => {},
    write: (line) => output.push(line),
    ...run,
  });
  return { ...result, server: fake, output };
}
