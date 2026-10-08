import { randomUUID } from 'node:crypto';
import {
  resultStepId,
  type Assignment,
  type CreateSessionRequestSchema,
  type ResultRequest,
  type ResultResponse,
  type SaveStateRequest,
  type SaveStateResponse,
  type SessionInfo,
  type SessionResponse,
  type SessionState,
} from '@funnel/contracts';
import {
  getMissingStepIds,
  hasInput,
  pickVariant,
  resolveResult,
  validateAnswer,
  type Answers,
  type InputStep,
  type ResolvedFunnel,
} from '@funnel/engine';
import type { z } from 'zod';
import type { Db } from '../db';
import { ApiHttpError, badRequest, notFound } from '../errors';
import type { VersionService } from './versions';

export type CreateSessionInput = z.output<typeof CreateSessionRequestSchema>;

export interface SessionRow {
  session_id: string;
  funnel_id: string;
  funnel_version: number;
  experiment_id: string;
  variant: string;
  assignment: Assignment;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  /** `{ answers, currentStepId }`. The rev lives in `state_rev`. */
  state_json: string;
  state_rev: number;
  result_id: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  completed_at: string | null;
  /** 1 for demo traffic, which the dashboard can remove. */
  demo: number;
}

/** One entry of `details` in a 422 `invalid_answers` response. */
export interface AnswerIssue {
  /** `null` when the answer name is not a question of the session's funnel. */
  stepId: string | null;
  answer: string;
  code: string;
  message: string;
}

const HOUR_MS = 3_600_000;

function addHours(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * HOUR_MS).toISOString();
}

export function isExpired(row: Pick<SessionRow, 'expires_at'>, now: Date): boolean {
  return Date.parse(row.expires_at) <= now.getTime();
}

function stateOf(row: SessionRow): SessionState {
  const stored = JSON.parse(row.state_json) as Omit<SessionState, 'rev'>;
  return { answers: stored.answers, currentStepId: stored.currentStepId, rev: row.state_rev };
}

function stateJson(state: Omit<SessionState, 'rev'>): string {
  return JSON.stringify({ answers: state.answers, currentStepId: state.currentStepId });
}

function toSessionInfo(row: SessionRow): SessionInfo {
  return {
    sessionId: row.session_id,
    funnelId: row.funnel_id,
    funnelVersion: row.funnel_version,
    experimentId: row.experiment_id,
    variant: row.variant,
    assignment: row.assignment,
    utm: {
      source: row.utm_source,
      medium: row.utm_medium,
      campaign: row.utm_campaign,
      content: row.utm_content,
      term: row.utm_term,
    },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resultId: row.result_id,
  };
}

/**
 * Every answer must belong to a question of the session's variant and pass its validation.
 * Returns the normalized answers (numbers parsed, multi-select in option order).
 */
function checkAnswers(funnel: ResolvedFunnel, answers: Answers): Answers {
  const steps = new Map<string, InputStep>();
  for (const id of funnel.sequence) {
    const step = funnel.steps[id];
    if (step && hasInput(step)) steps.set(step.input.name, step);
  }
  const normalized: Answers = {};
  const issues: AnswerIssue[] = [];
  for (const [name, value] of Object.entries(answers)) {
    const step = steps.get(name);
    if (!step) {
      issues.push({ stepId: null, answer: name, code: 'unknown_answer', message: `"${name}" is not a question of this funnel` });
      continue;
    }
    const check = validateAnswer(step, value);
    if (check.ok) normalized[name] = check.value;
    else issues.push({ stepId: step.id, answer: name, code: check.code, message: check.message });
  }
  if (issues.length > 0) throw new ApiHttpError(422, 'invalid_answers', 'Some answers are invalid', issues);
  return normalized;
}

function prepareStatements(db: Db) {
  return {
    find: db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE session_id = ?'),
    insert: db.prepare<SessionRow>(
      `INSERT INTO sessions (session_id, funnel_id, funnel_version, experiment_id, variant, assignment,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term, state_json, state_rev, result_id,
         created_at, last_seen_at, expires_at, completed_at, demo)
       VALUES (@session_id, @funnel_id, @funnel_version, @experiment_id, @variant, @assignment,
         @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term, @state_json, @state_rev, @result_id,
         @created_at, @last_seen_at, @expires_at, @completed_at, @demo)`,
    ),
    // The server-side session_started event. Its id is derived from the session id, so it exists at most once.
    insertStarted: db.prepare<SessionRow>(
      `INSERT INTO events (event_id, session_id, name, step_id, funnel_id, funnel_version, experiment_id, variant,
         assignment, utm_source, utm_medium, utm_campaign, client_ts, server_ts, properties_json)
       VALUES ('session_started:' || @session_id, @session_id, 'session_started', NULL, @funnel_id, @funnel_version,
         @experiment_id, @variant, @assignment, @utm_source, @utm_medium, @utm_campaign, NULL, @created_at, '{}')
       ON CONFLICT(event_id) DO NOTHING`,
    ),
    touch: db.prepare<[string, string, string]>('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE session_id = ?'),
    saveState: db.prepare<[string, number, string, string, string]>(
      'UPDATE sessions SET state_json = ?, state_rev = ?, last_seen_at = ?, expires_at = ? WHERE session_id = ?',
    ),
    saveResult: db.prepare<[string, number, string, string, string, string, string]>(
      `UPDATE sessions SET state_json = ?, state_rev = ?, result_id = ?, completed_at = COALESCE(completed_at, ?),
         last_seen_at = ?, expires_at = ? WHERE session_id = ?`,
    ),
  };
}

/** Session lifecycle. A session is pinned to the version and variant it was created with. */
export class SessionService {
  private readonly db: Db;
  private readonly versions: VersionService;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly stmt: ReturnType<typeof prepareStatements>;

  constructor(db: Db, versions: VersionService, now: () => Date, random: () => number) {
    this.db = db;
    this.versions = versions;
    this.now = now;
    this.random = random;
    this.stmt = prepareStatements(db);
  }

  /** Creates the session on the active version, or returns the existing one unchanged (funnel and body are then ignored). */
  open(sessionId: string, funnelId: string | undefined, request: CreateSessionInput): SessionResponse {
    return this.db
      .transaction((): SessionResponse => {
        const now = this.now();
        const existing = this.stmt.find.get(sessionId);
        if (existing) return this.respond(this.extend(this.ensureLive(existing, now), now), false);
        if (!funnelId) throw badRequest('funnelId is required');

        const version = this.versions.getActiveVersion(funnelId);
        const config = version === null ? null : this.versions.getConfig(funnelId, version);
        if (version === null || !config) throw new ApiHttpError(503, 'internal', 'No active version');

        const variants = config.experiment.variants;
        const forced = request.variant !== undefined && Object.hasOwn(variants, request.variant) ? request.variant : undefined;
        const row = this.insertNew(sessionId, now, {
          funnelId,
          version,
          variant: forced ?? pickVariant(variants, this.random()),
          assignment: forced ? 'override' : 'random',
          utm: request.utm,
          demo: request.demo === true,
        });
        return this.respond(row, true);
      })
      .immediate();
  }

  /** A new session on any stored version and variant, published or not. It never counts in analytics. */
  openPreview(funnelId: string, version: number, variant: string): SessionResponse {
    return this.db
      .transaction((): SessionResponse => {
        const config = this.versions.getConfig(funnelId, version);
        if (!config) throw notFound(`Funnel ${funnelId} has no version ${version}`);
        if (!Object.hasOwn(config.experiment.variants, variant)) throw badRequest(`Version ${version} has no variant "${variant}"`);
        const row = this.insertNew(randomUUID(), this.now(), { funnelId, version, variant, assignment: 'preview', utm: {}, demo: false });
        return this.respond(row, true);
      })
      .immediate();
  }

  get(sessionId: string): SessionResponse {
    return this.db
      .transaction((): SessionResponse => {
        const now = this.now();
        return this.respond(this.extend(this.load(sessionId, now), now), false);
      })
      .immediate();
  }

  saveState(sessionId: string, body: SaveStateRequest): SaveStateResponse {
    return this.db
      .transaction((): SaveStateResponse => {
        const now = this.now();
        const row = this.load(sessionId, now);
        const funnel = this.funnelOf(row);
        if (!funnel.sequence.includes(body.currentStepId)) {
          throw badRequest(`Step "${body.currentStepId}" is not part of this funnel`);
        }
        const answers = checkAnswers(funnel, body.answers);
        if (body.rev !== row.state_rev) {
          throw new ApiHttpError(409, 'rev_conflict', 'The state was changed by another request', { state: stateOf(row) });
        }
        const state: SessionState = { answers, currentStepId: body.currentStepId, rev: row.state_rev + 1 };
        this.stmt.saveState.run(stateJson(state), state.rev, now.toISOString(), addHours(now, funnel.session.ttlHours), sessionId);
        return { state };
      })
      .immediate();
  }

  /** Computes the result with the pinned version's rules. Idempotent and not subject to the rev check. */
  submitResult(sessionId: string, body: ResultRequest): ResultResponse {
    return this.db
      .transaction((): ResultResponse => {
        const now = this.now();
        const row = this.load(sessionId, now);
        const funnel = this.funnelOf(row);
        const answers = checkAnswers(funnel, body.answers);
        const missingStepIds = getMissingStepIds(funnel, answers);
        if (missingStepIds.length > 0) {
          throw new ApiHttpError(409, 'incomplete', 'Some questions are not answered yet', { missingStepIds });
        }
        const { resultId, result } = resolveResult(funnel, answers);
        const state: SessionState = { answers, currentStepId: resultStepId(funnel), rev: row.state_rev + 1 };
        const nowIso = now.toISOString();
        this.stmt.saveResult.run(
          stateJson(state),
          state.rev,
          resultId,
          nowIso,
          nowIso,
          addHours(now, funnel.session.ttlHours),
          sessionId,
        );
        return { resultId, result, state };
      })
      .immediate();
  }

  findRow(sessionId: string): SessionRow | undefined {
    return this.stmt.find.get(sessionId);
  }

  /** The session's pinned version resolved for its variant. Never the active version. */
  funnelOf(row: Pick<SessionRow, 'funnel_id' | 'funnel_version' | 'variant'>): ResolvedFunnel {
    return this.versions.getFunnel(row.funnel_id, row.funnel_version, row.variant);
  }

  /** Sliding TTL: activity moves the expiry to now + `ttlHours` of the pinned version. */
  extend(row: SessionRow, now: Date): SessionRow {
    const lastSeen = now.toISOString();
    const expires = addHours(now, this.funnelOf(row).session.ttlHours);
    this.stmt.touch.run(lastSeen, expires, row.session_id);
    return { ...row, last_seen_at: lastSeen, expires_at: expires };
  }

  /** Inserts the session at its first step together with the server-side session_started event. */
  private insertNew(
    sessionId: string,
    now: Date,
    s: { funnelId: string; version: number; variant: string; assignment: Assignment; utm: CreateSessionInput['utm']; demo: boolean },
  ): SessionRow {
    const funnel = this.versions.getFunnel(s.funnelId, s.version, s.variant);
    const created = now.toISOString();
    const row: SessionRow = {
      session_id: sessionId,
      funnel_id: s.funnelId,
      funnel_version: s.version,
      experiment_id: funnel.experimentId,
      variant: s.variant,
      assignment: s.assignment,
      utm_source: s.utm.source ?? null,
      utm_medium: s.utm.medium ?? null,
      utm_campaign: s.utm.campaign ?? null,
      utm_content: s.utm.content ?? null,
      utm_term: s.utm.term ?? null,
      state_json: stateJson({ answers: {}, currentStepId: funnel.sequence[0]! }),
      state_rev: 0,
      result_id: null,
      created_at: created,
      last_seen_at: created,
      expires_at: addHours(now, funnel.session.ttlHours),
      completed_at: null,
      demo: s.demo ? 1 : 0,
    };
    this.stmt.insert.run(row);
    this.stmt.insertStarted.run(row);
    return row;
  }

  private load(sessionId: string, now: Date): SessionRow {
    const row = this.stmt.find.get(sessionId);
    if (!row) throw notFound(`Session ${sessionId} does not exist`);
    return this.ensureLive(row, now);
  }

  private ensureLive(row: SessionRow, now: Date): SessionRow {
    if (isExpired(row, now)) throw new ApiHttpError(410, 'session_expired', 'The session has expired');
    return row;
  }

  private respond(row: SessionRow, created: boolean): SessionResponse {
    return { created, session: toSessionInfo(row), funnel: this.funnelOf(row), state: stateOf(row) };
  }
}

/** Privacy: empties the raw answers of sessions that expired more than 24 hours ago. Returns the number of sessions purged. */
export function purgeExpiredState(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  return db
    .prepare<[string]>(
      `UPDATE sessions SET state_json = json_set(state_json, '$.answers', json('{}'))
       WHERE expires_at < ? AND json_extract(state_json, '$.answers') <> '{}'`,
    )
    .run(cutoff).changes;
}
