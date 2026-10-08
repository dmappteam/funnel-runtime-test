import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FunnelAdminResponse } from '@funnel/contracts';
import type { ResolvedFunnel } from '@funnel/engine';
import { ApiClient, FUNNEL_ID, HttpError, type AdminCredentials } from './api';
import { midFunnelStep } from './behaviour';
import { computeGroundTruth, type GroundTruth } from './groundTruth';
import type { IngestionCheck, IngestionTotals } from './ingestion';
import type { ChaosRates } from './outbox';
import { Rng, hashSeed } from './random';
import {
  Logger,
  eventLines,
  groundTruthLines,
  ingestionLines,
  okText,
  phaseSummary,
  sessionSummary,
  verificationLines,
  type LogEntry,
  type SessionSummary,
} from './report';
import { Simulation, runPool, type IdsFor } from './simulation';
import type { Transport } from './transport';
import { compareCounts, fetchCounts, type AnalyticsCounts, type MetricCheck } from './verify';
import type { VirtualUser } from './virtualUser';

export const SCENARIOS = ['generate', 'demo', 'iteration2'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface RunOptions {
  transport: Transport;
  scenario: ScenarioName;
  /** Sessions per phase. */
  sessions: number;
  seed: number;
  concurrency: number;
  /** Where `funnel-v2.json` and `funnel-v3.json` are read from. */
  configsDir: string;
  admin?: AdminCredentials;
  verify: boolean;
  /** Shown in the log. */
  url: string;
  idsFor?: IdsFor;
  /** Anchor of client time, ms. */
  now?: number;
  chaos?: ChaosRates;
  sleep?: (ms: number) => Promise<void>;
  write?: (line: string) => void;
}

export interface Assertion {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Verification {
  /** `error`: GET /api/analytics failed after the run. */
  status: 'ok' | 'mismatch' | 'error' | 'skipped';
  reason?: string;
  versions: number[];
  checks: MetricCheck[];
  /** Change of the server's rejected-events log during the run, for information. */
  rejectedLogDelta: number | null;
}

export interface RunReport {
  ok: boolean;
  generator: {
    scenario: ScenarioName;
    seed: number;
    sessionsPerPhase: number;
    concurrency: number;
    url: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  assertions: Assertion[];
  groundTruth: GroundTruth;
  events: IngestionTotals & { batches: Record<string, number>; requests: number; retries: number };
  responses: { accepted: number; duplicate: number; rejected: number; rejectedByReason: Record<string, number>; anomalies: string[] };
  ingestionChecks: IngestionCheck[];
  verification: Verification;
  sessions: SessionSummary[];
  log: LogEntry[];
}

export interface RunResult {
  report: RunReport;
  simulation: Simulation;
}

/** A precondition of the scenario does not hold: missing credentials or an unexpected active version. */
export class ScenarioError extends Error {}

export function runScenario(options: RunOptions): Promise<RunResult> {
  return new Run(options).execute();
}

interface PhaseOptions {
  /** Share of sessions that pause mid-funnel and come back later. */
  pauseShare?: number;
  /** Where a pausing session stops. Defaults to a random question in the middle of its path. */
  pauseAt?: (funnel: ResolvedFunnel, user: VirtualUser, rng: Rng) => string | null;
  /** Version every new session must be pinned to. */
  expectVersion?: number;
}

const REQUIRED_ACTIVE: Partial<Record<ScenarioName, { version: number; hint: string }>> = {
  demo: { version: 1, hint: 'Start the server on a fresh database, where only v1 exists.' },
  iteration2: { version: 2, hint: 'Run the demo scenario first (npm run demo), it publishes v2.' },
};

class Run {
  private readonly api: ApiClient;
  private readonly sim: Simulation;
  private readonly log: Logger;
  private readonly assertions: Assertion[] = [];
  private before: AnalyticsCounts = { groups: new Map(), rejected: null };
  /** The admin API answered, so GET /api/analytics can be read too. */
  private adminAccess = false;
  private readonly startedAt = new Date();

  constructor(private readonly o: RunOptions) {
    this.api = new ApiClient(o.transport, { admin: o.admin, sleep: o.sleep, baseUrl: o.url });
    this.sim = new Simulation({ api: this.api, seed: o.seed, now: o.now ?? Date.now(), chaos: o.chaos, idsFor: o.idsFor });
    this.log = new Logger(o.write ?? ((line) => console.log(line)));
  }

  async execute(): Promise<RunResult> {
    this.log.section(
      `Funnel Runtime traffic generator: scenario ${this.o.scenario}, ${this.o.sessions} sessions per phase, ` +
        `seed ${this.o.seed}, concurrency ${this.o.concurrency}, ${this.o.url}`,
    );
    const admin = await this.serverCheck();
    if (this.o.verify && admin) await this.snapshot(admin);
    if (this.o.scenario === 'generate') await this.generate();
    else if (this.o.scenario === 'demo') await this.demo();
    else await this.iteration2();
    return { report: await this.finish(), simulation: this.sim };
  }

  // -------------------------------------------------------------------------
  // Scenarios
  // -------------------------------------------------------------------------

  private async generate(): Promise<void> {
    await this.phase(`${this.o.sessions} sessions on the active version`, this.o.sessions);
  }

  /** Iteration 1: a version published while sessions are in flight does not touch them. */
  private async demo(): Promise<void> {
    const n = this.o.sessions;
    const v1 = await this.phase(`${n} sessions on v1, about 20% pause mid-funnel`, n, { pauseShare: 0.2, expectVersion: 1 });
    await this.upload(2);
    await this.publish(2);
    await this.resume('Paused v1 sessions come back while v2 is active', paused(v1), 1);
    await this.phase(`${n} new sessions`, n, { expectVersion: 2 });
  }

  /** Iteration 2: v3 changes the B sequence and adds an event; a rollback must not break v3 sessions in flight. */
  private async iteration2(): Promise<void> {
    const n = this.o.sessions;
    const half = Math.max(1, Math.round(n / 2));
    const v2 = await this.phase(`${half} sessions on v2, about 20% pause (variant B at tool_count)`, half, {
      pauseShare: 0.2,
      expectVersion: 2,
      pauseAt: (funnel, user, rng) =>
        funnel.variant === 'B' && funnel.steps.tool_count ? 'tool_count' : midFunnelStep(funnel, user.plan.persona, rng),
    });
    v2.push(...(await this.ensureBPausedAtToolCount(v2)));
    await this.upload(3);
    await this.publish(3);
    const v3 = await this.phase(`${n} sessions on v3, about 20% pause mid-funnel`, n, { pauseShare: 0.2, expectVersion: 3 });

    const pausedV2 = paused(v2);
    await this.resume('Paused v2 sessions come back while v3 is active', pausedV2, 2);
    const atToolCount = pausedV2.filter((u) => u.record.variant === 'B' && u.record.pausedAt === 'tool_count');
    const asked = atToolCount.filter(
      (u) => u.record.resumedOn?.stepId === 'tool_count' && u.record.events.some((e) => e.name === 'answer_submitted' && e.step_id === 'tool_count'),
    );
    this.assert('variant B of v2 still asks tool_count after v3 dropped it', asked.length === atToolCount.length && asked.length > 0, `${asked.length}/${atToolCount.length}`);

    await this.rollback(2);
    const pausedV3 = paused(v3);
    await this.resume('Paused v3 sessions come back after the rollback', pausedV3, 3, true);
    const expanded = pausedV3.flatMap((u) => u.record.events.filter((e) => e.name === 'recommendation_expanded'));
    const accepted = expanded.filter((e) => this.sim.ingestion.statusesOf(e.event_id)[0] === 'accepted');
    this.assert(
      'recommendation_expanded of v3 sessions accepted after the rollback',
      expanded.length > 0 && accepted.length === expanded.length,
      `${accepted.length}/${expanded.length} accepted`,
    );

    const few = Math.max(3, Math.round(n / 20));
    await this.phase(`${few} new sessions after the rollback`, few, { expectVersion: 2 });
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /** Without credentials the admin API is still tried: a server started without ADMIN_PASSWORD leaves it open. */
  private async serverCheck(): Promise<FunnelAdminResponse | null> {
    this.log.step('Server check');
    await this.api.ping();
    this.log.info(`${this.o.url} answers`);
    let admin: FunnelAdminResponse;
    try {
      admin = await this.api.getFunnel(FUNNEL_ID);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 401)) throw err;
      if (this.api.hasCredentials) throw new ScenarioError('The server rejected the admin credentials (HTTP 401).');
      if (this.o.scenario !== 'generate') {
        throw new ScenarioError(
          `The ${this.o.scenario} scenario publishes versions and needs admin credentials: --admin-password or ADMIN_PASSWORD.`,
        );
      }
      this.log.warn('no admin credentials (--admin-password or ADMIN_PASSWORD): GET /api/analytics is out of reach, verification will be skipped');
      return null;
    }
    this.adminAccess = true;
    const stored = admin.versions.map((v) => `v${v.version}`).join(', ') || 'none';
    this.log.info(`${FUNNEL_ID}: active ${admin.activeVersion === null ? 'none' : `v${admin.activeVersion}`}, stored ${stored}`);
    const required = REQUIRED_ACTIVE[this.o.scenario];
    if (required && admin.activeVersion !== required.version) {
      throw new ScenarioError(
        `The ${this.o.scenario} scenario needs v${required.version} active, the active version is ` +
          `${admin.activeVersion === null ? 'none' : `v${admin.activeVersion}`}. ${required.hint}`,
      );
    }
    return admin;
  }

  /** Analytics may already hold data, so the verification compares deltas. Without a snapshot there is nothing to verify, so a failure stops the run. */
  private async snapshot(admin: FunnelAdminResponse): Promise<void> {
    this.log.step('Analytics snapshot before the run');
    const versions = admin.versions.map((v) => v.version).sort((a, b) => a - b);
    try {
      this.before = await fetchCounts(this.api, FUNNEL_ID, versions);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      throw new ScenarioError(`${err.message}. Fix the analytics API or run with --no-verify to send traffic without verification.`);
    }
    for (const version of versions) {
      const started = [...this.before.groups.entries()]
        .filter(([key]) => key.startsWith(`${version}:`))
        .reduce((sum, [, g]) => sum + g.started, 0);
      this.log.info(`v${version}: ${started} A/B sessions already recorded`);
    }
    if (versions.length === 0) this.log.info('no version stored yet');
  }

  private async phase(title: string, count: number, opts: PhaseOptions = {}): Promise<VirtualUser[]> {
    this.log.step(title);
    const users = Array.from({ length: count }, () => this.sim.newUser());
    const first = users[0]?.record.index ?? 0;
    const pausing = new Set(new Rng(hashSeed(this.o.seed, 'pausing', first)).shuffle(users).slice(0, Math.round(count * (opts.pauseShare ?? 0))));
    const choose = opts.pauseAt ?? ((funnel, user, rng) => midFunnelStep(funnel, user.plan.persona, rng));
    await runPool(
      users,
      this.o.concurrency,
      (user) => {
        const rng = new Rng(hashSeed(this.o.seed, 'pause', user.record.index));
        return user.start(pausing.has(user) ? { pauseAt: (funnel) => choose(funnel, user, rng) } : {});
      },
      this.progress(count),
    );
    this.log.lines(phaseSummary(users.map((u) => u.record)));
    this.reportFailures(users);
    if (opts.expectVersion !== undefined) {
      const created = users.filter((u) => u.record.version !== null);
      const pinned = created.filter((u) => u.record.version === opts.expectVersion);
      this.assert(`new sessions are pinned to v${opts.expectVersion}`, created.length > 0 && pinned.length === created.length, `${pinned.length}/${count}`);
    }
    return users;
  }

  /** Variant assignment is the server's 50/50 draw, so a B session paused at tool_count is not guaranteed by the phase alone. */
  private async ensureBPausedAtToolCount(users: VirtualUser[]): Promise<VirtualUser[]> {
    const atToolCount = (list: VirtualUser[]) =>
      list.filter((u) => u.record.status === 'paused' && u.record.variant === 'B' && u.record.pausedAt === 'tool_count');
    const extra: VirtualUser[] = [];
    if (atToolCount(users).length === 0) {
      this.log.info('no variant B session paused at tool_count yet, adding sessions until one does');
      for (let i = 0; i < 30 && atToolCount(extra).length === 0; i++) {
        const user = this.sim.newUser();
        await user.start({ pauseAt: (funnel) => (funnel.variant === 'B' && funnel.steps.tool_count ? 'tool_count' : null) });
        extra.push(user);
      }
      this.log.lines(phaseSummary(extra.map((u) => u.record)));
    }
    const total = atToolCount([...users, ...extra]).length;
    this.log.info(`${total} variant B session(s) paused at tool_count`);
    return extra;
  }

  private async upload(version: number): Promise<void> {
    const file = join(this.o.configsDir, `funnel-v${version}.json`);
    this.log.step(`Upload funnel-v${version}.json`);
    const res = await this.api.createVersion(FUNNEL_ID, readFileSync(file, 'utf8'));
    this.log.info(
      res.status === 201
        ? `201 created v${res.body.version}`
        : `${res.status}: this exact config is already stored as v${res.body.version}`,
    );
    for (const w of res.body.warnings ?? []) this.log.warn(`${w.path ? `${w.path}: ` : ''}${w.message}`);
  }

  private async publish(version: number): Promise<void> {
    this.log.step(`Publish v${version}`);
    const res = await this.api.publish(FUNNEL_ID, version);
    this.log.info(`active v${res.activeVersion}, previous ${res.previousVersion === null ? 'none' : `v${res.previousVersion}`}`);
    this.assert(`v${version} is active after publishing`, res.activeVersion === version, `active v${res.activeVersion}`);
  }

  private async rollback(expected: number): Promise<void> {
    this.log.step('Roll back');
    const res = await this.api.rollback(FUNNEL_ID);
    this.log.info(`active v${res.activeVersion}, rolled back from v${res.rolledBackFrom}`);
    this.assert(`rollback re-activates v${expected}`, res.activeVersion === expected, `active v${res.activeVersion}`);
  }

  /** Paused sessions come back: GET /api/sessions/:id must still serve the pinned version, and they finish on it. */
  private async resume(title: string, users: VirtualUser[], version: number, ctaOnFirst = false): Promise<void> {
    this.log.step(`${title} (${users.length})`);
    if (users.length === 0) {
      this.assert(`paused sessions on v${version} exist`, false, 'none');
      return;
    }
    await runPool(users, this.o.concurrency, (user, i) => user.resume(ctaOnFirst && i === 0 ? { cta: true } : {}), this.progress(users.length));
    const pinned = users.filter((u) => u.record.resumedOn?.version === version && u.record.resumedOn.configVersion === version);
    this.assert(`GET /api/sessions/:id still returns v${version}`, pinned.length === users.length, `${pinned.length}/${users.length}`);
    const finished = users.filter((u) => u.record.status === 'completed');
    this.assert(`resumed sessions finish on v${version}`, finished.length === users.length, `${finished.length}/${users.length} reached the result`);
    this.reportFailures(users);
  }

  // -------------------------------------------------------------------------
  // Ground truth and verification
  // -------------------------------------------------------------------------

  private async finish(): Promise<RunReport> {
    const records = this.sim.records;
    const truth = computeGroundTruth(records);
    const ingestion = this.sim.ingestion;
    const totals = ingestion.totals();

    this.log.section(`Ground truth from the simulation's own records (${truth.overrideSessions} override sessions excluded)`);
    this.log.lines(groundTruthLines(truth));
    this.log.section('Events sent');
    this.log.lines(eventLines(totals, ingestion, this.api.stats.retries));

    // Needs nothing but the batch answers, so it runs even with --no-verify.
    const ingestionChecks = ingestion.checks();
    this.log.section('Server answers to POST /api/events');
    this.log.lines(ingestionLines(ingestion, ingestionChecks));

    const verification = await this.verify(truth);
    const failed = records.filter((r) => r.status === 'failed').length;
    const checks = [
      ...this.assertions.map((a) => a.ok),
      ...ingestionChecks.map((c) => c.ok),
      ...verification.checks.map((c) => c.ok),
      ...(verification.status === 'error' ? [false] : []),
      failed === 0,
    ];
    const failures = checks.filter((ok) => !ok).length;
    const ok = failures === 0;

    this.log.section('Scenario assertions');
    if (this.assertions.length === 0) this.log.info('none for this scenario');
    for (const a of this.assertions) this.log.info(`${a.ok ? 'OK' : 'FAILED'}  ${a.name}: ${a.detail}`);
    if (failed > 0) this.log.warn(`${failed} session(s) failed, see "sessions[].error" in the report`);
    this.log.section(ok ? `Result: OK, ${checks.length} checks passed` : `Result: FAILED, ${failures} of ${checks.length} checks failed`);

    const finishedAt = new Date();
    return {
      ok,
      generator: {
        scenario: this.o.scenario,
        seed: this.o.seed,
        sessionsPerPhase: this.o.sessions,
        concurrency: this.o.concurrency,
        url: this.o.url,
        startedAt: this.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      },
      assertions: this.assertions,
      groundTruth: truth,
      events: { ...totals, batches: { ...ingestion.batches }, requests: this.api.stats.requests, retries: this.api.stats.retries },
      responses: { ...ingestion.responses, rejectedByReason: { ...ingestion.rejectedByReason }, anomalies: [...ingestion.anomalies] },
      ingestionChecks,
      verification,
      sessions: records.map(sessionSummary),
      log: this.log.entries,
    };
  }

  private async verify(truth: GroundTruth): Promise<Verification> {
    const versions = [...new Set(this.sim.records.flatMap((r) => (r.version === null ? [] : [r.version])))].sort((a, b) => a - b);
    const skipped = (reason: string): Verification => ({ status: 'skipped', reason, versions, checks: [], rejectedLogDelta: null });
    this.log.section('Verification against GET /api/analytics?includeOverrides=false (delta since the snapshot)');
    if (!this.o.verify) {
      this.log.info('skipped (--no-verify)');
      return skipped('--no-verify');
    }
    if (!this.adminAccess) {
      this.log.warn('skipped: no admin credentials (--admin-password or ADMIN_PASSWORD)');
      return skipped('no admin credentials');
    }
    let after: AnalyticsCounts;
    try {
      after = await fetchCounts(this.api, FUNNEL_ID, versions);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      this.log.warn(err.message);
      return { status: 'error', reason: err.message, versions, checks: [], rejectedLogDelta: null };
    }
    const checks = compareCounts(truth, this.before, after, versions);
    this.log.lines(verificationLines(checks));
    const rejectedLogDelta = after.rejected === null ? null : after.rejected - (this.before.rejected ?? 0);
    if (rejectedLogDelta !== null) this.log.info(`rejected-events log grew by ${rejectedLogDelta} (information only)`);
    const mismatches = checks.filter((c) => !c.ok).length;
    this.log.info(mismatches === 0 ? `${checks.length} metrics match` : `${mismatches} of ${checks.length} metrics: ${okText(false)}`);
    return { status: mismatches === 0 ? 'ok' : 'mismatch', versions, checks, rejectedLogDelta };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private assert(name: string, ok: boolean, detail: string): void {
    this.assertions.push({ name, ok, detail });
    this.log.info(`${ok ? 'OK' : 'FAILED'}  ${name}: ${detail}`);
  }

  private progress(total: number): (done: number) => void {
    const marks = new Set([0.25, 0.5, 0.75].map((q) => Math.round(total * q)).filter((m) => m > 0 && m < total));
    return (done) => {
      if (total >= 20 && marks.has(done)) this.log.info(`${done}/${total}`);
    };
  }

  private reportFailures(users: VirtualUser[]): void {
    for (const u of users.filter((x) => x.record.status === 'failed').slice(0, 5)) {
      this.log.warn(`session ${u.record.sessionId} failed: ${u.record.error}`);
    }
  }
}

function paused(users: VirtualUser[]): VirtualUser[] {
  return users.filter((u) => u.record.status === 'paused');
}
