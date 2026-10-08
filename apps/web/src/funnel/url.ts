import { SESSION_ID_RE, type UtmInput } from '@funnel/contracts';

/** Query parameters of the landing URL. After bootstrap they live on the session and the URL keeps only `step` and `session`. */
export interface LaunchParams {
  utm: UtmInput;
  /** QA override of the experiment variant. */
  variant: string | null;
  /** `reset=1` starts a new session even if one is stored. */
  reset: boolean;
  step: string | null;
  /** `session=<id>`: an admin preview of a stored version. It lives in the URL, never in storage. */
  session: string | null;
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;
/** Same rule as variant names in the config schema. Anything else could never match a variant. */
const VARIANT_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MAX_UTM_LENGTH = 200;

export function readLaunchParams(search: string = window.location.search): LaunchParams {
  const query = new URLSearchParams(search);
  const utm: UtmInput = {};
  for (const key of UTM_KEYS) {
    const value = query.get(`utm_${key}`)?.trim();
    if (value) utm[key] = value.slice(0, MAX_UTM_LENGTH);
  }
  const variant = query.get('variant')?.trim() ?? '';
  const reset = query.get('reset');
  return {
    utm,
    variant: VARIANT_RE.test(variant) ? variant : null,
    reset: reset === '1' || reset === 'true',
    step: readStepParam(search),
    session: readSessionParam(search),
  };
}

function readSessionParam(search: string): string | null {
  const session = new URLSearchParams(search).get('session')?.trim() ?? '';
  return SESSION_ID_RE.test(session) ? session : null;
}

export function readStepParam(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get('step')?.trim() || null;
}

/** Keeps a preview's `session`, so a reload stays in the preview. */
export function stepHref(stepId: string): string {
  const params = new URLSearchParams();
  const session = readSessionParam(window.location.search);
  if (session) params.set('session', session);
  params.set('step', stepId);
  return `${window.location.pathname}?${params.toString()}`;
}
