import { SESSION_ID_RE } from '@funnel/contracts';

export const SESSION_KEY = 'funnel-runtime:session-id';

export function readSessionId(): string | null {
  try {
    const id = window.localStorage.getItem(SESSION_KEY);
    return id && SESSION_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function writeSessionId(sessionId: string): void {
  try {
    window.localStorage.setItem(SESSION_KEY, sessionId);
  } catch {
    // Storage blocked: the session still works for this page, a reload starts a new one.
  }
}
