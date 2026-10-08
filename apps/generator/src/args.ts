import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AdminCredentials } from './api';
import { SCENARIOS, type ScenarioName } from './scenarios';

export interface CliOptions {
  url: string;
  sessions: number;
  seed: number;
  concurrency: number;
  scenario: ScenarioName;
  admin?: AdminCredentials;
  configsDir: string;
  report?: string;
  verify: boolean;
  help: boolean;
}

export const USAGE = `Usage: npm run generate -- [options]
       npm run demo -- [options]

Generates synthetic funnel traffic against a running server and checks that the
analytics API shows exactly what was sent.

Options:
  --url <url>              Server base URL (default http://localhost:3000)
  --sessions <n>           Sessions per phase (default 120)
  --seed <n>               Random seed: the same seed replays the same users (default 42)
  --concurrency <n>        Sessions in flight (default 8)
  --scenario <name>        generate | demo | iteration2 (default generate)
  --admin-user <user>      Basic auth user for admin and analytics (default $ADMIN_USER)
  --admin-password <pw>    Basic auth password (default $ADMIN_PASSWORD)
  --configs-dir <dir>      Directory with funnel-v2.json and funnel-v3.json (default <repo>/configs)
  --report <file>          Write the full JSON report to this file
  --no-verify              Skip the checks against POST /api/events answers and GET /api/analytics
  -h, --help               Show this help

Scenarios:
  generate    N sessions on the active version.
  demo        Iteration 1, needs v1 active: N sessions on v1 (about 20% pause), upload and
              publish v2, the paused sessions come back and finish on v1, N sessions on v2.
  iteration2  Needs v2 active: N/2 sessions on v2 (B pauses at tool_count), upload and publish
              v3, N sessions on v3, the paused v2 sessions finish on v2, roll back, the paused
              v3 sessions finish on v3, a few new sessions get v2.

Exit code 0 when every check passes, 1 on a failed check or an unreachable server.`;

/** Parses CLI flags. Throws an Error with a readable message on bad input. */
export function parseCliArgs(argv: string[], env: Record<string, string | undefined>, defaultConfigsDir: string): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'http://localhost:3000' },
      sessions: { type: 'string', default: '120' },
      seed: { type: 'string', default: '42' },
      concurrency: { type: 'string', default: '8' },
      scenario: { type: 'string', default: 'generate' },
      'admin-user': { type: 'string' },
      'admin-password': { type: 'string' },
      'configs-dir': { type: 'string' },
      report: { type: 'string' },
      verify: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowNegative: true,
    strict: true,
  });

  const scenario = values.scenario as ScenarioName;
  if (!SCENARIOS.includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')}, got "${values.scenario}"`);
  const user = values['admin-user'] ?? env.ADMIN_USER;
  const password = values['admin-password'] ?? env.ADMIN_PASSWORD;

  return {
    url: values.url.replace(/\/+$/, ''),
    sessions: integer('--sessions', values.sessions, 1),
    seed: integer('--seed', values.seed, Number.MIN_SAFE_INTEGER),
    concurrency: integer('--concurrency', values.concurrency, 1),
    scenario,
    admin: user && password ? { user, password } : undefined,
    configsDir: resolve(values['configs-dir'] ?? defaultConfigsDir),
    report: values.report,
    verify: values.verify,
    help: values.help,
  };
}

function integer(flag: string, text: string, min: number): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${flag} must be an integer${min > 0 ? ` of at least ${min}` : ''}, got "${text}"`);
  return n;
}
