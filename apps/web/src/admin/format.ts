import type { ConfigIssue } from '@funnel/engine';
import { HttpError } from '../api/http';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

export interface Problem {
  title: string;
  detail?: string;
  errors?: ConfigIssue[];
  warnings?: ConfigIssue[];
}

function issues(value: unknown): ConfigIssue[] | undefined {
  return Array.isArray(value) ? value.filter((i): i is ConfigIssue => typeof i?.message === 'string') : undefined;
}

/** Turns an API failure into something an operator can act on. */
export function describeError(err: unknown): Problem {
  if (!(err instanceof HttpError)) {
    return { title: 'The server could not be reached', detail: err instanceof Error ? err.message : undefined };
  }
  const body = err.body;
  switch (body?.error) {
    case 'unauthorized':
      return { title: 'Authentication required', detail: 'Reload the page and sign in with the admin credentials.' };
    case 'version_conflict':
      return { title: body.message, detail: 'Increase "version" in the config, validate and save again.' };
    case 'config_invalid': {
      const details = body.details as { errors?: unknown; warnings?: unknown } | undefined;
      return { title: body.message, errors: issues(details?.errors), warnings: issues(details?.warnings) };
    }
    case 'no_previous_version':
      return { title: body.message };
    default:
      return { title: body?.message ?? `Request failed (HTTP ${err.status})`, detail: body ? `HTTP ${err.status} · ${body.error}` : undefined };
  }
}
