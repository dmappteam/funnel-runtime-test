import type { ConfigIssue } from '@funnel/engine';
import { HttpError } from '../api/http';
import type { Messages } from '../internal/en';

export interface Problem {
  title: string;
  detail?: string;
  errors?: ConfigIssue[];
  warnings?: ConfigIssue[];
}

function issues(value: unknown): ConfigIssue[] | undefined {
  return Array.isArray(value) ? value.filter((i): i is ConfigIssue => typeof i?.message === 'string') : undefined;
}

/** Turns an API failure into something an operator can act on. Server messages stay in English. */
export function describeError(err: unknown, t: Messages): Problem {
  if (!(err instanceof HttpError)) {
    return { title: t.errors.unreachable, detail: err instanceof Error ? err.message : undefined };
  }
  const body = err.body;
  switch (body?.error) {
    case 'unauthorized':
      return { title: t.errors.authRequired, detail: t.errors.authHint };
    case 'version_conflict':
      return { title: body.message, detail: t.errors.versionConflictHint };
    case 'config_invalid': {
      const details = body.details as { errors?: unknown; warnings?: unknown } | undefined;
      return { title: body.message, errors: issues(details?.errors), warnings: issues(details?.warnings) };
    }
    case 'no_previous_version':
      return { title: body.message };
    default:
      return { title: body?.message ?? t.errors.requestFailed(err.status), detail: body ? `HTTP ${err.status} · ${body.error}` : undefined };
  }
}
