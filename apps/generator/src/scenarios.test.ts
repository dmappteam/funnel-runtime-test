import type { ClientEvent } from '@funnel/contracts';
import { describe, expect, it } from 'vitest';
import { UnreachableError } from './api';
import { FakeServer, type Fault } from './fakeServer';
import { ScenarioError, runScenario } from './scenarios';
import { ADMIN, CONFIGS_DIR, rawConfig, runFake } from './testing';
import { NetworkError, type HttpRequest } from './transport';

const failedAssertions = (run: Awaited<ReturnType<typeof runFake>>) => run.report.assertions.filter((a) => !a.ok);

describe('generate', () => {
  it('matches GET /api/analytics, also as a delta on top of earlier data', async () => {
    const server = new FakeServer({ configs: [rawConfig(1)], admin: ADMIN });
    const first = await runFake({ seed: 1 }, server);
    const second = await runFake({ seed: 2 }, server);
    for (const run of [first, second]) {
      expect(run.report.ok).toBe(true);
      expect(run.report.verification.status).toBe('ok');
      expect(run.report.verification.checks.length).toBeGreaterThan(20);
    }
    const startedA = second.report.verification.checks.find((c) => c.metric === 'started' && c.variant === 'A')!;
    expect(startedA.expected).toBe(second.report.groundTruth.groups.find((g) => g.variant === 'A')!.started);
    expect(second.output.join('\n')).toMatch(/v1: \d+ A\/B sessions already recorded/);
  });

  it('fails on a single wrong number in the analytics answer', async () => {
    const run = await runFake(
      {},
      {
        tamperAnalytics: (body) => {
          if (body.groups[0]) body.groups[0].kpi.ctaClicked += 1;
        },
      },
    );
    expect(run.report.ok).toBe(false);
    expect(run.report.verification.status).toBe('mismatch');
    expect(run.report.verification.checks.filter((c) => !c.ok)).toEqual([expect.objectContaining({ metric: 'ctaClicked' })]);
    expect(run.output.join('\n')).toContain('MISMATCH');
    expect(run.output.at(-1)).toMatch(/^Result: FAILED, 1 of \d+ checks failed$/);
  });

  it('stops before sending traffic when the analytics snapshot fails', async () => {
    const fault = (req: HttpRequest): Fault => (req.path.startsWith('/api/analytics') ? 500 : null);
    await expect(runFake({}, { fault })).rejects.toThrow(/HTTP 500.*--no-verify/);
  });

  it('fails when the analytics API breaks after the run', async () => {
    let calls = 0;
    const fault = (req: HttpRequest): Fault => (req.path.startsWith('/api/analytics') && ++calls > 1 ? 500 : null);
    const run = await runFake({}, { fault });
    expect(run.report.verification.status).toBe('error');
    expect(run.report.ok).toBe(false);
  });

  it('without credentials skips the analytics comparison but still checks the event answers', async () => {
    const run = await runFake({ admin: undefined });
    expect(run.report.verification).toMatchObject({ status: 'skipped', reason: 'no admin credentials' });
    expect(run.report.ingestionChecks.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect(run.report.ok).toBe(true);
    expect(run.output.join('\n')).toContain('WARNING: no admin credentials');
  });

  it('reads the admin API without credentials when the server has no admin password', async () => {
    const run = await runFake({ admin: undefined }, { admin: undefined });
    expect(run.report.verification.status).toBe('ok');
  });

  it('rejects wrong credentials instead of skipping the verification', async () => {
    await expect(runFake({ admin: { user: 'admin', password: 'wrong' } })).rejects.toThrow(ScenarioError);
  });

  it('--no-verify skips only the analytics comparison', async () => {
    const run = await runFake({ verify: false });
    expect(run.report.verification).toMatchObject({ status: 'skipped', reason: '--no-verify', checks: [] });
    expect(run.report.ingestionChecks).toHaveLength(4);
    expect(run.server.requests.some((r) => r.path.startsWith('/api/analytics'))).toBe(false);
  });

  it('stops with a clear message when the server is unreachable', async () => {
    const transport = {
      send: async () => {
        throw new NetworkError('connect ECONNREFUSED 127.0.0.1:3000');
      },
    };
    const run = runScenario({
      transport,
      scenario: 'generate',
      sessions: 5,
      seed: 1,
      concurrency: 2,
      configsDir: CONFIGS_DIR,
      verify: true,
      url: 'http://localhost:3000',
      write: () => {},
    });
    await expect(run).rejects.toThrow(UnreachableError);
    await expect(run).rejects.toThrow('Cannot reach http://localhost:3000: connect ECONNREFUSED 127.0.0.1:3000');
  });
});

describe('demo', () => {
  it('keeps paused v1 sessions on v1 after v2 is published, and new sessions get v2', async () => {
    const run = await runFake({ scenario: 'demo', sessions: 40 });
    expect(failedAssertions(run)).toEqual([]);
    expect(run.report.ok).toBe(true);
    expect(run.report.verification).toMatchObject({ status: 'ok', versions: [1, 2] });
    expect(run.server.activeVersion).toBe(2);

    const records = run.simulation.records;
    const resumed = records.filter((r) => r.resumedOn !== null);
    expect(resumed).toHaveLength(8);
    for (const r of resumed) {
      expect(r).toMatchObject({ version: 1, status: 'completed', resumedOn: { version: 1, configVersion: 1, stepId: r.pausedAt } });
    }
    expect(records.slice(40).every((r) => r.version === 2)).toBe(true);
  });

  it('needs v1 active', async () => {
    await expect(runFake({ scenario: 'demo' }, { configs: [rawConfig(1), rawConfig(2)] })).rejects.toThrow(/needs v1 active, the active version is v2/);
  });

  it('needs admin access', async () => {
    await expect(runFake({ scenario: 'demo', admin: undefined })).rejects.toThrow(/needs admin credentials/);
  });
});

describe('iteration2', () => {
  it('pins v2 and v3 sessions through a publish and a rollback', async () => {
    const run = await runFake({ scenario: 'iteration2', sessions: 40 }, { configs: [rawConfig(1), rawConfig(2)] });
    expect(failedAssertions(run)).toEqual([]);
    expect(run.report.ok).toBe(true);
    expect(run.report.verification).toMatchObject({ status: 'ok', versions: [2, 3] });
    expect(run.server.activeVersion).toBe(2);
    expect(run.report.assertions.map((a) => a.name)).toEqual([
      'new sessions are pinned to v2',
      'v3 is active after publishing',
      'new sessions are pinned to v3',
      'GET /api/sessions/:id still returns v2',
      'resumed sessions finish on v2',
      'variant B of v2 still asks tool_count after v3 dropped it',
      'rollback re-activates v2',
      'GET /api/sessions/:id still returns v3',
      'resumed sessions finish on v3',
      'recommendation_expanded of v3 sessions accepted after the rollback',
      'new sessions are pinned to v2',
    ]);

    const records = run.simulation.records;
    const bAtToolCount = records.filter((r) => r.version === 2 && r.variant === 'B' && r.pausedAt === 'tool_count');
    expect(bAtToolCount.length).toBeGreaterThan(0);
    const v3Expanded = records.filter((r) => r.version === 3 && r.resumedOn).flatMap((r) => r.events.filter((e) => e.name === 'recommendation_expanded'));
    expect(v3Expanded.length).toBeGreaterThan(0);
    expect(records.slice(-3).every((r) => r.version === 2)).toBe(true);
  });

  it('rolls back exactly once when the answer to the rollback is lost', async () => {
    let rollbacks = 0;
    const fault = (req: HttpRequest): Fault => (req.path.endsWith('/rollback') && rollbacks++ === 0 ? 'lost' : null);
    const run = await runFake({ scenario: 'iteration2', sessions: 40 }, { configs: [rawConfig(1), rawConfig(2)], fault });
    expect(failedAssertions(run)).toEqual([]);
    expect(rollbacks).toBe(1);
    expect(run.server.activeVersion).toBe(2);
  });

  it('counts a recommendation_expanded as stored when the retry after a lost answer gets duplicate', async () => {
    let rolledBack = false;
    const lost: string[] = [];
    const fault = (req: HttpRequest): Fault => {
      if (req.path.endsWith('/rollback')) rolledBack = true;
      if (!rolledBack || lost.length > 0 || req.path !== '/api/events' || !req.body?.includes('"recommendation_expanded"')) return null;
      lost.push(req.body);
      return 'lost';
    };
    const run = await runFake({ scenario: 'iteration2', sessions: 40 }, { configs: [rawConfig(1), rawConfig(2)], fault });
    const events = (JSON.parse(lost[0]!) as { events: ClientEvent[] }).events;
    const expanded = events.find((e) => e.name === 'recommendation_expanded')!;
    expect(run.simulation.ingestion.statusesOf(expanded.event_id)[0]).toBe('duplicate');
    expect(failedAssertions(run)).toEqual([]);
    expect(run.report.ok).toBe(true);
  });

  it('needs v2 active', async () => {
    await expect(runFake({ scenario: 'iteration2' })).rejects.toThrow(/needs v2 active, the active version is v1/);
  });
});
