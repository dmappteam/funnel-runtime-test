import { z } from 'zod';
import {
  AnswerValueSchema,
  type Answers,
  type ConfigDiff,
  type ConfigIssue,
  type ResolvedFunnel,
  type ResultDef,
} from '@funnel/engine';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SessionIdSchema = z.string().regex(SESSION_ID_RE, 'session id must be a UUID');

/** Lenient on purpose: a malformed marketing link (`?utm_source=` or a huge value) must never block session creation. */
const utmValue = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().slice(0, 200) || undefined : v),
  z.string().optional(),
);
export const UtmSchema = z.object({
  source: utmValue,
  medium: utmValue,
  campaign: utmValue,
  content: utmValue,
  term: utmValue,
});
export type UtmInput = z.infer<typeof UtmSchema>;

export interface Utm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
}

/**
 * PUT /api/sessions/:sessionId
 * The client generates the session id (UUID), so a retried request cannot create a second session.
 * Creates the session on the active version if it does not exist, otherwise returns the existing one.
 */
export const CreateSessionRequestSchema = z.object({
  utm: UtmSchema.default({}),
  /** QA override of the variant (`?variant=` query parameter). Used only when the session is created. */
  variant: z.string().max(16).optional(),
});
export type CreateSessionRequest = z.input<typeof CreateSessionRequestSchema>;

export type Assignment = 'random' | 'override';

export interface SessionInfo {
  sessionId: string;
  funnelId: string;
  funnelVersion: number;
  experimentId: string;
  variant: string;
  assignment: Assignment;
  utm: Utm;
  createdAt: string;
  expiresAt: string;
  resultId: string | null;
}

export interface SessionState {
  /** Raw answers keyed by input name. Stored only in the session, never in events. */
  answers: Answers;
  currentStepId: string;
  /** Incremented on every save, used for optimistic concurrency. */
  rev: number;
}

/** Response of PUT and GET /api/sessions/:sessionId. */
export interface SessionResponse {
  /** true only for the request that created the session. */
  created: boolean;
  session: SessionInfo;
  /** The session's pinned version, resolved for its variant. */
  funnel: ResolvedFunnel;
  state: SessionState;
}

export const AnswersSchema = z.record(z.string().min(1).max(64), AnswerValueSchema);

/** PUT /api/sessions/:sessionId/state. 409 `rev_conflict` returns the server state in `details.state`. */
export const SaveStateRequestSchema = z.object({
  answers: AnswersSchema,
  currentStepId: z.string().min(1).max(64),
  /** The rev the client's change is based on. */
  rev: z.number().int().min(0),
});
export type SaveStateRequest = z.infer<typeof SaveStateRequestSchema>;

export interface SaveStateResponse {
  state: SessionState;
}

/**
 * POST /api/sessions/:sessionId/result
 * Saves the final answers and returns the result computed by the pinned version's rules.
 * 409 `incomplete` lists unanswered questions in `details.missingStepIds`.
 */
export const ResultRequestSchema = z.object({ answers: AnswersSchema });
export type ResultRequest = z.infer<typeof ResultRequestSchema>;

export interface ResultResponse {
  resultId: string;
  result: ResultDef;
  state: SessionState;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'session_expired'
  | 'rev_conflict'
  | 'incomplete'
  | 'invalid_answers'
  | 'unauthorized'
  | 'forbidden'
  | 'config_invalid'
  | 'version_conflict'
  | 'no_previous_version'
  | 'internal';

export interface ApiError {
  error: ApiErrorCode;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Admin: versions, publication, rollback
// ---------------------------------------------------------------------------

export interface VersionSummary {
  version: number;
  experimentId: string;
  releaseNote: string | null;
  checksum: string;
  createdAt: string;
  isActive: boolean;
  /** Sessions pinned to this version. */
  sessions: number;
}

export type ReleaseAction = 'publish' | 'rollback';

export interface ReleaseEntry {
  id: number;
  /** The version that became active by this action. */
  version: number;
  action: ReleaseAction;
  /** The version that was active before the action. */
  fromVersion: number | null;
  createdAt: string;
}

/** GET /api/admin/funnels/:funnelId */
export interface FunnelAdminResponse {
  funnelId: string;
  activeVersion: number | null;
  /** Version a rollback would activate, `null` if there is none. */
  rollbackTarget: number | null;
  versions: VersionSummary[];
  /** Newest first. */
  releases: ReleaseEntry[];
}

/** GET /api/admin/funnels/:funnelId/versions/:version — the config exactly as uploaded. */
export interface VersionConfigResponse {
  funnelId: string;
  version: number;
  config: unknown;
}

/** POST /api/admin/funnels/:funnelId/validate with the raw config JSON as body. Never stores anything. */
export interface ValidateConfigResponse {
  ok: boolean;
  version: number | null;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  /** Changes against the active version. */
  diff: ConfigDiff | null;
  /** `identical`: this exact config is already stored. `conflict`: the version number is taken by a different config. */
  versionStatus: 'new' | 'identical' | 'conflict' | null;
}

/**
 * POST /api/admin/funnels/:funnelId/versions with the raw config JSON as body.
 * 201 created, 200 identical config already stored (`created: false`), 409 `version_conflict`, 422 `config_invalid`.
 */
export interface CreateVersionResponse {
  version: number;
  created: boolean;
  warnings: ConfigIssue[];
}

/** POST /api/admin/funnels/:funnelId/publish — makes a stored version active for new sessions. */
export const PublishRequestSchema = z.object({ version: z.number().int().positive() });
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export interface PublishResponse {
  activeVersion: number;
  previousVersion: number | null;
}

/** POST /api/admin/funnels/:funnelId/rollback — 409 `no_previous_version` if there is nothing to roll back to. */
export interface RollbackResponse {
  activeVersion: number;
  rolledBackFrom: number;
}
