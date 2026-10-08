import { z } from 'zod';
import {
  STEP_TYPES,
  answerKind,
  getProgress,
  hasInput,
  type Answers,
  type ResolvedFunnel,
} from '@funnel/engine';
import { SessionIdSchema, type Utm } from './api';

// ---------------------------------------------------------------------------
// Wire format: POST /api/events
// ---------------------------------------------------------------------------

/** Client-generated idempotency key. UUIDs fit, so does the server's `session_started:<session_id>`. */
export const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_BATCH_SIZE = 100;

const utmField = z.string().max(200).nullable().optional();

export const ClientEventSchema = z.object({
  event_id: z.string().regex(EVENT_ID_RE),
  session_id: SessionIdSchema,
  name: z.string().regex(EVENT_NAME_RE),
  client_ts: z.iso.datetime({ offset: true }),
  step_id: z.string().min(1).max(64).nullable().default(null),
  // Base properties. The server overwrites them from the session row, which is the source of truth.
  funnel_id: z.string().max(64).optional(),
  funnel_version: z.number().int().optional(),
  experiment_id: z.string().max(128).optional(),
  variant: z.string().max(16).optional(),
  utm_source: utmField,
  utm_medium: utmField,
  utm_campaign: utmField,
  properties: z.record(z.string().max(64), z.unknown()).default({}),
});
/** What a client sends. */
export type ClientEvent = z.input<typeof ClientEventSchema>;
export type ParsedClientEvent = z.output<typeof ClientEventSchema>;

/** Each element is validated on its own, so one bad event never fails the batch. */
export const EventBatchRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_BATCH_SIZE),
});

export type RejectReason =
  /** Fails `ClientEventSchema`. */
  | 'invalid_payload'
  | 'unknown_session'
  /** `session_started` is written by the server when the session is created. */
  | 'server_only_event'
  /** Not in `events.allowed` of the session's pinned version. */
  | 'event_not_allowed'
  /** `step_id` (or a step referenced by a property) is not part of the session's variant. */
  | 'unknown_step'
  /** A whitelisted property has the wrong type or refers to an unknown result. */
  | 'invalid_properties';

export type EventStatus = 'accepted' | 'duplicate' | 'rejected';

export interface EventResult {
  /** Position in the request's `events` array. */
  index: number;
  event_id: string | null;
  status: EventStatus;
  reason?: RejectReason;
  message?: string;
}

/**
 * 200 for any well-formed batch, including partially rejected ones. Every status is final for the client:
 * `accepted`, `duplicate` (already stored, e.g. a retry after timeout) and `rejected` events leave the outbox.
 */
export interface EventBatchResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
  results: EventResult[];
}

export const SERVER_ONLY_EVENTS: readonly string[] = ['session_started'];

/** Type rules for known properties. Other whitelisted properties must be JSON primitives (`GenericPropertySchema`). */
export const EVENT_PROPERTY_SCHEMAS: Record<string, z.ZodType> = {
  step_type: z.enum(STEP_TYPES),
  visible_step_index: z.number().int().min(1).nullable(),
  visible_step_count: z.number().int().min(0),
  answer_kind: z.enum(['single_select', 'multi_select', 'number']),
  next_step_id: z.string().min(1).max(64).nullable(),
  destination_step_id: z.string().min(1).max(64),
  result_id: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  source: z.string().min(1).max(64),
};

export const GenericPropertySchema = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);

// ---------------------------------------------------------------------------
// Builders shared by the web runtime and the traffic generator,
// so both emit exactly the same events with the same properties.
// ---------------------------------------------------------------------------

export interface EventDraft {
  name: string;
  step_id: string | null;
  properties: Record<string, unknown>;
}

/** A visible step was rendered (including info and result steps, and again after a refresh or a back navigation). */
export function stepViewed(funnel: ResolvedFunnel, answers: Answers, stepId: string): EventDraft {
  const step = funnel.steps[stepId];
  if (!step) throw new Error(`Unknown step "${stepId}"`);
  const progress = getProgress(funnel, answers, stepId);
  return {
    name: 'step_viewed',
    step_id: stepId,
    properties: { step_type: step.type, visible_step_index: progress.index, visible_step_count: progress.total },
  };
}

/** A valid answer was submitted. Only the kind of answer is sent, never the value. */
export function answerSubmitted(funnel: ResolvedFunnel, stepId: string): EventDraft {
  const step = funnel.steps[stepId];
  if (!step || !hasInput(step)) throw new Error(`Step "${stepId}" does not take an answer`);
  return { name: 'answer_submitted', step_id: stepId, properties: { answer_kind: answerKind(step) } };
}

/** Navigation advanced from a valid interactive (question) step. Not sent for info steps. */
export function stepCompleted(stepId: string, nextStepId: string | null): EventDraft {
  return { name: 'step_completed', step_id: stepId, properties: { next_step_id: nextStepId } };
}

/** The user went to the previous visible step (in-app button or browser Back). */
export function backClicked(fromStepId: string, destinationStepId: string): EventDraft {
  return { name: 'back_clicked', step_id: fromStepId, properties: { destination_step_id: destinationStepId } };
}

/** The result content was rendered (after it loaded). */
export function resultViewed(resultStepId: string, resultId: string): EventDraft {
  return { name: 'result_viewed', step_id: resultStepId, properties: { result_id: resultId } };
}

export function ctaClicked(resultStepId: string, resultId: string, action: string): EventDraft {
  return { name: 'cta_clicked', step_id: resultStepId, properties: { result_id: resultId, action } };
}

/** v3+: the detailed recommendation became visible after the CTA. Dropped for versions that do not allow it. */
export function recommendationExpanded(resultStepId: string, resultId: string, action: string, source = 'cta'): EventDraft {
  return { name: 'recommendation_expanded', step_id: resultStepId, properties: { result_id: resultId, action, source } };
}

export function resultStepId(funnel: ResolvedFunnel): string {
  const id = funnel.sequence.find((stepId) => funnel.steps[stepId]?.type === 'result');
  if (!id) throw new Error(`Funnel ${funnel.funnelId} v${funnel.version} has no result step`);
  return id;
}

export function isEventAllowed(funnel: ResolvedFunnel, name: string): boolean {
  return funnel.events.allowed.some((e) => e.name === name);
}

export interface EventContext {
  sessionId: string;
  funnel: ResolvedFunnel;
  utm: Pick<Utm, 'source' | 'medium' | 'campaign'>;
}

/**
 * Adds base properties and applies the pinned version's event contract:
 * returns `null` for an event the version does not allow and drops properties outside its whitelist.
 */
export function finalizeEvent(draft: EventDraft, ctx: EventContext, eventId: string, clientTs: string): ClientEvent | null {
  const def = ctx.funnel.events.allowed.find((e) => e.name === draft.name);
  if (!def) return null;
  const properties = Object.fromEntries(Object.entries(draft.properties).filter(([key]) => def.properties.includes(key)));
  return {
    event_id: eventId,
    session_id: ctx.sessionId,
    name: draft.name,
    client_ts: clientTs,
    step_id: draft.step_id,
    funnel_id: ctx.funnel.funnelId,
    funnel_version: ctx.funnel.version,
    experiment_id: ctx.funnel.experimentId,
    variant: ctx.funnel.variant,
    utm_source: ctx.utm.source,
    utm_medium: ctx.utm.medium,
    utm_campaign: ctx.utm.campaign,
    properties,
  };
}
