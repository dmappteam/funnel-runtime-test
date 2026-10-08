import type { AnalyticsEventRow, AnalyticsFilters, AnalyticsReport, Assignment, GroupReport } from '@funnel/contracts';
import type { FunnelConfig } from '@funnel/engine';
import { loadConfig } from '@funnel/engine/testing';
import { aggregate } from './aggregate';

// Test-only helpers: a session builder that emits the events the web runtime would send.

export const FUNNEL_ID = 'workstyle-planner';
export const CONFIGS: Record<number, FunnelConfig> = { 1: loadConfig(1), 2: loadConfig(2), 3: loadConfig(3) };
export const NOW = '2026-10-08T12:00:00.000Z';

export interface SessionOptions {
  version?: number;
  variant?: string;
  campaign?: string | null;
  assignment?: Assignment;
  funnelId?: string;
  /** server_ts and client_ts of the first event. Later events follow one second apart. */
  start?: string;
  /** Emit the server's session_started first (default true). */
  started?: boolean;
}

export class SessionBuilder {
  readonly events: AnalyticsEventRow[] = [];
  private clock: number;
  private seq = 0;

  constructor(
    readonly sessionId: string,
    private readonly opts: SessionOptions = {},
  ) {
    this.clock = Date.parse(opts.start ?? '2026-10-01T09:00:00.000Z');
    if (opts.started !== false) this.add('session_started', null, {}, `session_started:${sessionId}`);
  }

  get version(): number {
    return this.opts.version ?? 1;
  }

  add(name: string, stepId: string | null, properties: Record<string, unknown> = {}, eventId?: string): this {
    const ts = new Date(this.clock).toISOString();
    this.clock += 1000;
    this.seq += 1;
    const campaign = this.opts.campaign ?? null;
    this.events.push({
      event_id: eventId ?? `${this.sessionId}-${String(this.seq).padStart(3, '0')}`,
      session_id: this.sessionId,
      name,
      step_id: stepId,
      funnel_id: this.opts.funnelId ?? FUNNEL_ID,
      funnel_version: this.version,
      experiment_id: CONFIGS[this.version]?.experiment.id ?? `experiment-v${this.version}`,
      variant: this.opts.variant ?? 'A',
      assignment: this.opts.assignment ?? 'random',
      utm_source: campaign ? 'newsletter' : null,
      utm_medium: campaign ? 'email' : null,
      utm_campaign: campaign,
      client_ts: ts,
      server_ts: ts,
      properties,
    });
    return this;
  }

  view(stepId: string): this {
    return this.add('step_viewed', stepId);
  }

  /** Answers the question and navigates forward. */
  complete(stepId: string, nextStepId: string): this {
    return this.add('answer_submitted', stepId).add('step_completed', stepId, { next_step_id: nextStepId });
  }

  back(fromStepId: string, toStepId: string): this {
    return this.add('back_clicked', fromStepId, { destination_step_id: toStepId });
  }

  result(resultId: string): this {
    return this.add('result_viewed', 'result', { result_id: resultId });
  }

  cta(resultId: string): this {
    return this.add('cta_clicked', 'result', { result_id: resultId, action: 'expand_recommendation' });
  }

  /** Views every step in order and completes each question on the way (info steps send no step_completed). */
  walk(stepIds: readonly string[]): this {
    stepIds.forEach((id, i) => {
      this.view(id);
      const next = stepIds[i + 1];
      if (next && CONFIGS[this.version]?.steps[id]?.type !== 'info') this.complete(id, next);
    });
    return this;
  }
}

export function session(id: string, opts?: SessionOptions): SessionBuilder {
  return new SessionBuilder(id, opts);
}

export function sequence(version: number, variant: string): string[] {
  return [...CONFIGS[version]!.experiment.variants[variant]!.stepSequence];
}

/** The variant's sequence from its start up to and including `last`, without the listed steps. */
export function pathTo(version: number, variant: string, last: string, skip: readonly string[] = []): string[] {
  const seq = sequence(version, variant);
  return seq.slice(0, seq.indexOf(last) + 1).filter((id) => !skip.includes(id));
}

export function eventsOf(...sessions: SessionBuilder[]): AnalyticsEventRow[] {
  return sessions.flatMap((s) => s.events);
}

export function run(events: AnalyticsEventRow[], filters: Partial<AnalyticsFilters> = {}): AnalyticsReport {
  return aggregate({
    events,
    configs: CONFIGS,
    filters: { funnelId: FUNNEL_ID, version: null, campaign: null, includeOverrides: false, ...filters },
    now: NOW,
  });
}

export function groupOf(report: AnalyticsReport, version: number, variant: string): GroupReport {
  const group = report.groups.find((g) => g.version === version && g.variant === variant);
  if (!group) throw new Error(`No group v${version} ${variant}`);
  return group;
}

/** Deterministic Fisher–Yates shuffle (mulberry32). */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
