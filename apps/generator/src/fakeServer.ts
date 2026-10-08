import {
  FunnelConfigSchema,
  getMissingStepIds,
  pickVariant,
  resolveResult,
  resolveVariant,
  type FunnelConfig,
  type ResolvedFunnel,
} from '@funnel/engine';
import {
  ClientEventSchema,
  CreateSessionRequestSchema,
  EVENT_PROPERTY_SCHEMAS,
  GenericPropertySchema,
  PublishRequestSchema,
  ResultRequestSchema,
  SERVER_ONLY_EVENTS,
  SESSION_ID_RE,
  SaveStateRequestSchema,
  resultStepId,
  type AnalyticsEventRow,
  type EventResult,
  type RejectReason,
  type SessionInfo,
  type SessionResponse,
  type SessionState,
} from '@funnel/contracts';
import { hashSeed } from './random';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from './transport';

/** `network`: the request never arrives. `lost`: it is processed but the answer never comes back. A number: answer with that status. */
export type Fault = 'network' | 'lost' | number | null;

export interface FakeServerOptions {
  /** Raw config files, stored and published in this order before the first request. */
  configs: string[];
  admin?: { user: string; password: string };
  /** Variant of a session without an override. Defaults to a hash of the session id, so test runs are reproducible. */
  assign?: (sessionId: string, ordinal: number) => string;
  fault?: (request: HttpRequest) => Fault;
  /** Lets a test corrupt the analytics answer. */
  tamperAnalytics?: (body: FakeAnalytics) => void;
}

export interface FakeAnalytics {
  groups: {
    version: number;
    experimentId: string;
    variant: string;
    kpi: { started: number; reachedResult: number; ctaClicked: number };
    steps: { stepId: string; reached: number }[];
  }[];
  ingestion: { rejected: number; rejectedByReason: Record<string, number> };
}

interface FakeSession {
  info: SessionInfo;
  funnel: ResolvedFunnel;
  state: SessionState;
}

const TIME = '2026-10-08T12:00:00.000Z';

/**
 * In-memory stand-in for the server, for tests only. It serves `resolveVariant` of the real configs and applies
 * the documented ingestion rules, so the generator can be tested end to end without a network.
 */
export class FakeServer implements Transport {
  readonly configs = new Map<number, { raw: string; config: FunnelConfig }>();
  readonly sessions = new Map<string, FakeSession>();
  readonly events = new Map<string, AnalyticsEventRow>();
  readonly rejected: { eventId: string | null; reason: RejectReason }[] = [];
  /** Every request in arrival order. */
  readonly requests: HttpRequest[] = [];
  private readonly releases: number[] = [];

  constructor(private readonly options: FakeServerOptions) {
    for (const raw of options.configs) {
      const config = FunnelConfigSchema.parse(JSON.parse(raw));
      this.configs.set(config.version, { raw, config });
      this.releases.push(config.version);
    }
  }

  get activeVersion(): number | null {
    return this.releases[this.releases.length - 1] ?? null;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const fault = this.options.fault?.(request) ?? null;
    if (fault === 'network') throw new NetworkError('fake: connection reset');
    if (typeof fault === 'number') return { status: fault, body: { error: 'internal', message: 'fake: injected failure' } };
    const response = this.route(request);
    if (fault === 'lost') throw new NetworkError('fake: response lost');
    // Through JSON, like the wire, so the client never shares objects with the server.
    return { status: response.status, body: JSON.parse(JSON.stringify(response.body ?? null)) as unknown };
  }

  private route(req: HttpRequest): HttpResponse {
    const url = new URL(req.path, 'http://fake');
    const path = url.pathname;
    const body: unknown = req.body === undefined ? undefined : JSON.parse(req.body);
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
      return req.method === 'PUT' ? this.createSession(m[1]!, body) : this.getSession(m[1]!);
    }
    if ((m = path.match(/^\/api\/sessions\/([^/]+)\/state$/))) return this.saveState(m[1]!, body);
    if ((m = path.match(/^\/api\/sessions\/([^/]+)\/result$/))) return this.result(m[1]!, body);
    if (path === '/api/events') return this.ingest(body);

    if (path.startsWith('/api/admin/') || path === '/api/analytics') {
      if (!this.authorized(req)) return fail(401, 'unauthorized', 'admin credentials required');
    }
    if (path === '/api/analytics') return this.analytics(url.searchParams);
    if (/^\/api\/admin\/funnels\/[^/]+$/.test(path)) return ok(200, this.admin());
    if (/^\/api\/admin\/funnels\/[^/]+\/versions$/.test(path)) return this.createVersion(req.body ?? '');
    if (/^\/api\/admin\/funnels\/[^/]+\/publish$/.test(path)) return this.publish(body);
    if (/^\/api\/admin\/funnels\/[^/]+\/rollback$/.test(path)) return this.rollback();
    return fail(404, 'not_found', `no route for ${req.method} ${path}`);
  }

  private authorized(req: HttpRequest): boolean {
    const admin = this.options.admin;
    if (!admin) return true;
    const expected = `Basic ${Buffer.from(`${admin.user}:${admin.password}`).toString('base64')}`;
    return req.headers?.authorization === expected;
  }

  // Sessions -------------------------------------------------------------------

  private createSession(id: string, body: unknown): HttpResponse {
    if (!SESSION_ID_RE.test(id)) return fail(400, 'bad_request', 'session id must be a UUID');
    const existing = this.sessions.get(id);
    if (existing) return ok(200, this.sessionResponse(existing, false));
    const parsed = CreateSessionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'bad_request', parsed.error.message);

    const version = this.activeVersion!;
    const config = this.configs.get(version)!.config;
    const override = parsed.data.variant && config.experiment.variants[parsed.data.variant] ? parsed.data.variant : null;
    const variant =
      override ?? this.options.assign?.(id, this.sessions.size) ?? pickVariant(config.experiment.variants, hashSeed(id) / 4294967296);
    const funnel = resolveVariant(config, variant);
    const utm = parsed.data.utm;
    const session: FakeSession = {
      info: {
        sessionId: id,
        funnelId: config.funnelId,
        funnelVersion: version,
        experimentId: config.experiment.id,
        variant,
        assignment: override ? 'override' : 'random',
        utm: { source: utm.source ?? null, medium: utm.medium ?? null, campaign: utm.campaign ?? null, content: utm.content ?? null, term: utm.term ?? null },
        createdAt: TIME,
        expiresAt: TIME,
        resultId: null,
      },
      funnel,
      state: { answers: {}, currentStepId: funnel.sequence[0]!, rev: 0 },
    };
    this.sessions.set(id, session);
    this.store(session, `session_started:${id}`, 'session_started', null, {});
    return ok(201, this.sessionResponse(session, true));
  }

  private getSession(id: string): HttpResponse {
    const session = this.sessions.get(id);
    return session ? ok(200, this.sessionResponse(session, false)) : fail(404, 'not_found', 'unknown session');
  }

  private saveState(id: string, body: unknown): HttpResponse {
    const session = this.sessions.get(id);
    if (!session) return fail(404, 'not_found', 'unknown session');
    const parsed = SaveStateRequestSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'bad_request', parsed.error.message);
    if (parsed.data.rev !== session.state.rev) return fail(409, 'rev_conflict', 'stale rev', { state: session.state });
    if (!session.funnel.steps[parsed.data.currentStepId]) return fail(400, 'bad_request', 'unknown step');
    session.state = { answers: parsed.data.answers, currentStepId: parsed.data.currentStepId, rev: session.state.rev + 1 };
    return ok(200, { state: session.state });
  }

  private result(id: string, body: unknown): HttpResponse {
    const session = this.sessions.get(id);
    if (!session) return fail(404, 'not_found', 'unknown session');
    const parsed = ResultRequestSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'bad_request', parsed.error.message);
    const missingStepIds = getMissingStepIds(session.funnel, parsed.data.answers);
    if (missingStepIds.length > 0) return fail(409, 'incomplete', 'unanswered questions', { missingStepIds });
    const { resultId, result } = resolveResult(session.funnel, parsed.data.answers);
    session.info.resultId = resultId;
    session.state = { answers: parsed.data.answers, currentStepId: resultStepId(session.funnel), rev: session.state.rev + 1 };
    return ok(200, { resultId, result, state: session.state });
  }

  private sessionResponse(session: FakeSession, created: boolean): SessionResponse {
    return { created, session: session.info, funnel: session.funnel, state: session.state };
  }

  // Events ---------------------------------------------------------------------

  private ingest(body: unknown): HttpResponse {
    const events = (body as { events?: unknown })?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 100) return fail(400, 'bad_request', 'events must hold 1..100 items');
    const results: EventResult[] = events.map((raw, index) => ({ index, ...this.ingestOne(raw) }));
    const count = (status: EventResult['status']) => results.filter((r) => r.status === status).length;
    return ok(200, { accepted: count('accepted'), duplicates: count('duplicate'), rejected: count('rejected'), results });
  }

  private ingestOne(raw: unknown): Omit<EventResult, 'index'> {
    const parsed = ClientEventSchema.safeParse(raw);
    const rawId = (raw as { event_id?: unknown })?.event_id;
    const reject = (reason: RejectReason, eventId: string | null) => {
      this.rejected.push({ eventId, reason });
      return { event_id: eventId, status: 'rejected' as const, reason };
    };
    if (!parsed.success) return reject('invalid_payload', typeof rawId === 'string' ? rawId : null);
    const e = parsed.data;
    const session = this.sessions.get(e.session_id);
    if (!session) return reject('unknown_session', e.event_id);
    if (SERVER_ONLY_EVENTS.includes(e.name)) return reject('server_only_event', e.event_id);
    const def = session.funnel.events.allowed.find((d) => d.name === e.name);
    if (!def) return reject('event_not_allowed', e.event_id);
    const inVariant = (stepId: unknown) => typeof stepId === 'string' && session.funnel.sequence.includes(stepId);
    if (e.step_id !== null && !inVariant(e.step_id)) return reject('unknown_step', e.event_id);

    const properties: Record<string, unknown> = {};
    for (const key of def.properties) {
      if (!(key in e.properties)) continue;
      const value = e.properties[key];
      if (!(EVENT_PROPERTY_SCHEMAS[key] ?? GenericPropertySchema).safeParse(value).success) return reject('invalid_properties', e.event_id);
      if ((key === 'next_step_id' || key === 'destination_step_id') && value !== null && !inVariant(value)) return reject('unknown_step', e.event_id);
      if (key === 'result_id' && !session.funnel.results[value as string]) return reject('invalid_properties', e.event_id);
      properties[key] = value;
    }
    if (this.events.has(e.event_id)) return { event_id: e.event_id, status: 'duplicate' };
    this.store(session, e.event_id, e.name, e.step_id, properties, e.client_ts);
    return { event_id: e.event_id, status: 'accepted' };
  }

  private store(
    session: FakeSession,
    eventId: string,
    name: string,
    stepId: string | null,
    properties: Record<string, unknown>,
    clientTs: string | null = null,
  ): void {
    const { info } = session;
    this.events.set(eventId, {
      event_id: eventId,
      session_id: info.sessionId,
      name,
      step_id: stepId,
      funnel_id: info.funnelId,
      funnel_version: info.funnelVersion,
      experiment_id: info.experimentId,
      variant: info.variant,
      assignment: info.assignment,
      utm_source: info.utm.source,
      utm_medium: info.utm.medium,
      utm_campaign: info.utm.campaign,
      client_ts: clientTs,
      server_ts: TIME,
      properties,
    });
  }

  // Admin and analytics --------------------------------------------------------

  private admin() {
    const sessions = [...this.sessions.values()];
    return {
      funnelId: 'workstyle-planner',
      activeVersion: this.activeVersion,
      rollbackTarget: this.releases[this.releases.length - 2] ?? null,
      versions: [...this.configs.entries()].map(([version, { config }]) => ({
        version,
        experimentId: config.experiment.id,
        releaseNote: config.releaseNote ?? null,
        checksum: String(hashSeed(this.configs.get(version)!.raw)),
        createdAt: TIME,
        isActive: version === this.activeVersion,
        sessions: sessions.filter((s) => s.info.funnelVersion === version).length,
      })),
      releases: [],
    };
  }

  private createVersion(raw: string): HttpResponse {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail(400, 'bad_request', 'body is not JSON');
    }
    const parsed = FunnelConfigSchema.safeParse(json);
    if (!parsed.success) return fail(422, 'config_invalid', parsed.error.message);
    const version = parsed.data.version;
    const stored = this.configs.get(version);
    if (stored) {
      return JSON.stringify(JSON.parse(stored.raw)) === JSON.stringify(json)
        ? ok(200, { version, created: false, warnings: [] })
        : fail(409, 'version_conflict', `v${version} is taken by a different config`);
    }
    this.configs.set(version, { raw, config: parsed.data });
    return ok(201, { version, created: true, warnings: [] });
  }

  private publish(body: unknown): HttpResponse {
    const parsed = PublishRequestSchema.safeParse(body);
    if (!parsed.success || !this.configs.has(parsed.data.version)) return fail(404, 'not_found', 'unknown version');
    const previousVersion = this.activeVersion;
    this.releases.push(parsed.data.version);
    return ok(200, { activeVersion: parsed.data.version, previousVersion });
  }

  private rollback(): HttpResponse {
    if (this.releases.length < 2) return fail(409, 'no_previous_version', 'nothing to roll back to');
    const rolledBackFrom = this.releases.pop()!;
    return ok(200, { activeVersion: this.activeVersion, rolledBackFrom });
  }

  /** Distinct sessions per version × variant; `reached` counts sessions with any event on the step. */
  private analytics(query: URLSearchParams): HttpResponse {
    const version = query.get('version') ? Number(query.get('version')) : null;
    const includeOverrides = query.get('includeOverrides') === 'true';
    const groups = new Map<string, { rows: AnalyticsEventRow[]; version: number; variant: string; experimentId: string }>();
    for (const row of this.events.values()) {
      if (version !== null && row.funnel_version !== version) continue;
      if (!includeOverrides && row.assignment === 'override') continue;
      const key = `${row.funnel_version}:${row.variant}`;
      const group = groups.get(key) ?? { rows: [], version: row.funnel_version, variant: row.variant, experimentId: row.experiment_id };
      group.rows.push(row);
      groups.set(key, group);
    }
    const sessionsWith = (rows: AnalyticsEventRow[], match: (row: AnalyticsEventRow) => boolean) =>
      new Set(rows.filter(match).map((r) => r.session_id)).size;

    const body: FakeAnalytics = {
      groups: [...groups.values()].map((g) => {
        const sequence = resolveVariant(this.configs.get(g.version)!.config, g.variant).sequence;
        return {
          version: g.version,
          experimentId: g.experimentId,
          variant: g.variant,
          kpi: {
            started: sessionsWith(g.rows, (r) => r.name === 'session_started'),
            reachedResult: sessionsWith(g.rows, (r) => r.name === 'result_viewed'),
            ctaClicked: sessionsWith(g.rows, (r) => r.name === 'cta_clicked'),
          },
          steps: sequence.map((stepId) => ({ stepId, reached: sessionsWith(g.rows, (r) => r.step_id === stepId) })),
        };
      }),
      ingestion: {
        rejected: this.rejected.length,
        rejectedByReason: this.rejected.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }), {}),
      },
    };
    this.options.tamperAnalytics?.(body);
    return ok(200, body);
  }
}

function ok(status: number, body: unknown): HttpResponse {
  return { status, body };
}

function fail(status: number, error: string, message: string, details?: unknown): HttpResponse {
  return { status, body: { error, message, ...(details === undefined ? {} : { details }) } };
}
