import type { CreateSessionRequest, SessionInfo, SessionResponse, UtmInput } from '@funnel/contracts';
import { HttpError } from '../api/http';
import { createSession, getSession } from '../api/sessions';
import { randomId } from '../tracking/uuid';
import { readSessionId, writeSessionId } from './sessionStore';
import type { LaunchParams } from './url';

export interface BootstrapRequest {
  utm: UtmInput;
  variant: string | null;
  /** Ignore the stored session: `?reset=1`, or the previous session expired. */
  fresh: boolean;
}

export interface PendingSession {
  id: string;
  body: CreateSessionRequest;
}

export interface BootstrapDeps {
  getSession: (sessionId: string) => Promise<SessionResponse>;
  createSession: (sessionId: string, body: CreateSessionRequest) => Promise<SessionResponse>;
  readSessionId: () => string | null;
  writeSessionId: (sessionId: string) => void;
  newId: () => string;
}

const defaultDeps: BootstrapDeps = { getSession, createSession, readSessionId, writeSessionId, newId: randomId };

export function launchRequest(params: LaunchParams): BootstrapRequest {
  return { utm: params.utm, variant: params.variant, fresh: params.reset };
}

/** Replacement for an expired session: same attribution, same forced variant for QA sessions. */
export function restartRequest(session: SessionInfo): BootstrapRequest {
  const utm: UtmInput = {};
  for (const [key, value] of Object.entries(session.utm)) if (value) utm[key as keyof UtmInput] = value;
  return { utm, variant: session.assignment === 'override' ? session.variant : null, fresh: true };
}

/**
 * Continues the stored session or creates a new one. The id of a session being created is kept in `pending`,
 * so a retry after a network error repeats the same idempotent PUT instead of creating a second session.
 */
export async function bootstrapSession(
  request: BootstrapRequest,
  pending: { current: PendingSession | null },
  deps: BootstrapDeps = defaultDeps,
): Promise<SessionResponse> {
  if (!pending.current) {
    const storedId = request.fresh ? null : deps.readSessionId();
    const existing = storedId ? await loadStored(storedId, request.variant, deps) : null;
    if (existing) return existing;
    const body: CreateSessionRequest = request.variant ? { utm: request.utm, variant: request.variant } : { utm: request.utm };
    pending.current = { id: deps.newId(), body };
    deps.writeSessionId(pending.current.id);
  }
  try {
    const created = await deps.createSession(pending.current.id, pending.current.body);
    pending.current = null;
    return created;
  } catch (err) {
    // An expired id cannot be revived: the next attempt starts over with a new one.
    if (err instanceof HttpError && err.status === 410) pending.current = null;
    throw err;
  }
}

async function loadStored(sessionId: string, variant: string | null, deps: BootstrapDeps): Promise<SessionResponse | null> {
  try {
    const found = await deps.getSession(sessionId);
    // A QA link for another variant must not continue the current session.
    return variant && variant !== found.session.variant ? null : found;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return null;
    throw err;
  }
}
