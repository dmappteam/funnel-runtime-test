// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resultStepId, type ClientEvent, type SessionInfo, type SessionState } from '@funnel/contracts';
import { FunnelConfigSchema, getMissingStepIds, resolveResult, resolveVariant, type Answers } from '@funnel/engine';
import v3 from '../../../../configs/funnel-v3.json';
import { getTracker } from '../tracking/tracker';
import { FunnelPage } from './FunnelPage';
import { SESSION_KEY } from './sessionStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config = FunnelConfigSchema.parse(v3);
/** Every question of variant B answered: Continue on office_days opens the result. */
const COMPLETE: Answers = {
  work_mode: 'hybrid',
  meeting_hours: 6,
  timezone_span: 'same',
  team_size: 8,
  async_maturity: 'medium',
  priorities: ['speed', 'focus'],
  office_days: 2,
};
const EXPIRED_NOTICE = 'Your previous session expired, so we started a new one.';

interface StoredSession {
  info: SessionInfo;
  state: SessionState;
}

/** In-memory stand-in for the API with the server's rules: pinned variant, rev check, normalized answers, result rules. */
function fakeServer() {
  const sessions = new Map<string, StoredSession>();
  const expired = new Set<string>();
  const events: ClientEvent[] = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let failNext = 0;

  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const respond = (stored: StoredSession, created: boolean) => ({
    created,
    session: stored.info,
    funnel: resolveVariant(config, stored.info.variant),
    state: stored.state,
  });

  const create = (sessionId: string, variant: string, state?: Partial<SessionState>): StoredSession => {
    const funnel = resolveVariant(config, variant);
    const stored: StoredSession = {
      info: {
        sessionId,
        funnelId: config.funnelId,
        funnelVersion: config.version,
        experimentId: config.experiment.id,
        variant,
        assignment: 'override',
        utm: { source: null, medium: null, campaign: null, content: null, term: null },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        resultId: null,
      },
      state: { answers: {}, currentStepId: funnel.sequence[0]!, rev: 0, ...state },
    };
    sessions.set(sessionId, stored);
    return stored;
  };

  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(input, 'http://localhost').pathname;
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (failNext > 0) {
      failNext--;
      throw new TypeError('Failed to fetch');
    }

    if (path === '/api/events') {
      const batch = (body as { events: ClientEvent[] }).events;
      events.push(...batch);
      return reply(200, {
        accepted: batch.length,
        duplicates: 0,
        rejected: 0,
        results: batch.map((e, index) => ({ index, event_id: e.event_id, status: 'accepted' })),
      });
    }

    const match = /^\/api\/sessions\/([^/]+)(\/state|\/result)?$/.exec(path);
    if (!match) return reply(404, { error: 'not_found', message: path });
    const [, sessionId, action] = match;
    if (expired.has(sessionId!)) return reply(410, { error: 'session_expired', message: 'expired' });
    const stored = sessions.get(sessionId!);

    if (!action && method === 'PUT') {
      if (stored) return reply(200, respond(stored, false));
      const variant = (body as { variant?: string }).variant ?? 'A';
      const created = create(sessionId!, variant);
      created.info.utm = { ...created.info.utm, ...(body as { utm: object }).utm };
      return reply(201, respond(created, true));
    }
    if (!stored) return reply(404, { error: 'not_found', message: 'no session' });
    if (!action) return reply(200, respond(stored, false));

    const funnel = resolveVariant(config, stored.info.variant);
    if (action === '/state') {
      const save = body as { answers: Answers; currentStepId: string; rev: number };
      if (save.rev !== stored.state.rev) {
        return reply(409, { error: 'rev_conflict', message: 'conflict', details: { state: stored.state } });
      }
      stored.state = { answers: save.answers, currentStepId: save.currentStepId, rev: stored.state.rev + 1 };
      return reply(200, { state: stored.state });
    }
    const answers = (body as { answers: Answers }).answers;
    const missingStepIds = getMissingStepIds(funnel, answers);
    if (missingStepIds.length > 0) return reply(409, { error: 'incomplete', message: 'incomplete', details: { missingStepIds } });
    const { resultId, result } = resolveResult(funnel, answers);
    stored.state = { answers, currentStepId: resultStepId(funnel), rev: stored.state.rev + 1 };
    stored.info.resultId = resultId;
    return reply(200, { resultId, result, state: stored.state });
  });

  return {
    fetch,
    sessions,
    events,
    requests,
    create,
    expire: (sessionId: string) => expired.add(sessionId),
    failRequests: (n: number) => {
      failNext = n;
    },
  };
}

// --- DOM helpers (no testing-library in the repo) ---

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (ms = 0) => act(async () => sleep(ms));
const heading = () => document.querySelector('h1')?.textContent ?? '';
const counter = () => document.querySelector('.fn-count')?.textContent ?? null;
const search = () => window.location.search;

async function waitFor(check: () => boolean, what: string) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 3000) throw new Error(`Timed out waiting for ${what}. Heading: "${heading()}"`);
    await settle(10);
  }
}

const waitForHeading = (text: string) => waitFor(() => heading() === text, `heading "${text}"`);

function byText<T extends Element>(selector: string, text: string): T {
  const found = [...document.querySelectorAll<T>(selector)].find((el) => el.textContent?.trim() === text);
  if (!found) throw new Error(`No ${selector} with text "${text}"`);
  return found;
}

const click = (el: Element) => act(async () => (el as HTMLElement).click());

async function type(value: string) {
  const input = document.querySelector<HTMLInputElement>('.fn-number-input')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function answerNumber(value: string) {
  await type(value);
  await click(byText('button', 'Continue'));
}

async function choose(label: string) {
  await click(byText('[role="radio"]', label));
  await settle(260); // auto-advance
}

let root: Root | null = null;
let server: ReturnType<typeof fakeServer>;

async function open(url: string) {
  window.history.replaceState(null, '', url);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StrictMode>
        <FunnelPage />
      </StrictMode>,
    ),
  );
}

async function close() {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}

/** Events of one session in the order they were tracked, sent or still queued. */
function eventsOf(sessionId: string): Array<[string, string | null]> {
  const seen = new Set<string>();
  return [...server.events, ...getTracker().pending()]
    .filter((e) => e.session_id === sessionId && !seen.has(e.event_id) && seen.add(e.event_id))
    .map((e) => [e.name, e.step_id ?? null]);
}

const sessionIdOf = () => window.localStorage.getItem(SESSION_KEY)!;

beforeEach(() => {
  window.localStorage.clear();
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetch);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(async () => {
  await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('funnel page', () => {
  it('walks variant B from the intro to the expanded result and reports every step once', async () => {
    await open('/?utm_source=newsletter&variant=B&reset=1');
    await waitForHeading('Is your team losing time to the way it works?');
    expect(search()).toBe('?step=intro');
    expect(server.requests.filter((r) => r.method === 'PUT' && /sessions\/[^/]+$/.test(r.path))).toHaveLength(1);
    const sessionId = sessionIdOf();
    expect(server.sessions.get(sessionId)!.info.utm.source).toBe('newsletter');

    await click(byText('button', 'Check our setup'));
    await waitForHeading('Where does the team work most of the time?');
    expect(counter()).toBe('Step 1 of 8');
    expect(search()).toBe('?step=work_mode');

    await choose('Hybrid');
    await waitForHeading('How many hours per person go to meetings each week?');
    await answerNumber('50');
    expect(document.querySelector('.fn-error')?.textContent).toBe('Enter a value from 0 to 40.');
    await answerNumber('6');
    await waitForHeading('How far apart are your working hours?');
    await choose('Mostly the same hours');
    await waitForHeading('How many people are on the team?');
    await answerNumber('8');
    await waitForHeading('How are decisions documented today?');
    await choose('Important decisions are documented');

    await waitForHeading('What is the most urgent operating constraint?');
    const continueButton = byText<HTMLButtonElement>('button', 'Continue');
    expect(continueButton.getAttribute('aria-disabled')).toBe('true');
    await click(continueButton);
    expect(document.querySelector('.fn-error')?.textContent).toBe('Choose at least one priority.');
    for (const label of ['Deep-focus time', 'Compliance and access control', 'Decision speed']) {
      await click(byText('label', label));
    }
    expect(document.querySelector('.fn-select-meta')?.textContent).toBe('3 of 3 selected');
    expect(byText('label', 'Lower operating cost').querySelector('input')!.disabled).toBe(true);
    expect(continueButton.getAttribute('aria-disabled')).toBe('false');
    await click(continueButton);

    await waitForHeading('How strict are your information-access constraints?');
    await choose('Standard role-based access');
    await waitForHeading('How many office days are expected each week?');
    expect(counter()).toBe('Step 8 of 8');
    await answerNumber('2');

    await waitForHeading('Your hybrid setup needs firmer rules');
    expect(search()).toBe('?step=result');
    expect(document.querySelector('.fn-recos')).toBeNull();
    await click(byText('button', 'Open the implementation details'));
    expect(document.querySelectorAll('.fn-recos li')).toHaveLength(3);
    await settle(50);

    const saved = server.sessions.get(sessionId)!;
    expect(saved.info.resultId).toBe('hybrid_structured');
    expect(saved.state.answers).toMatchObject({ work_mode: 'hybrid', meeting_hours: 6, priorities: ['speed', 'focus', 'compliance'] });

    const question = (id: string, next: string) => [
      ['answer_submitted', id],
      ['step_completed', id],
      ['step_viewed', next],
    ];
    expect(eventsOf(sessionId)).toEqual([
      ['step_viewed', 'intro'],
      ['step_viewed', 'work_mode'],
      ...question('work_mode', 'meeting_hours'),
      ...question('meeting_hours', 'timezone_span'),
      ...question('timezone_span', 'team_size'),
      ...question('team_size', 'async_maturity'),
      ...question('async_maturity', 'priorities'),
      ...question('priorities', 'security_constraints'),
      ...question('security_constraints', 'office_days'),
      ...question('office_days', 'result'),
      ['result_viewed', 'result'],
      ['cta_clicked', 'result'],
      ['recommendation_expanded', 'result'],
    ]);
  });

  it('goes back with the in-app and the browser button, and a changed answer shrinks the path', async () => {
    await open('/?variant=B&reset=1');
    await waitForHeading('Is your team losing time to the way it works?');
    expect(document.querySelector<HTMLButtonElement>('.fn-back')!.hidden).toBe(true);
    await click(byText('button', 'Check our setup'));
    await waitForHeading('Where does the team work most of the time?');
    await choose('Hybrid');
    await waitForHeading('How many hours per person go to meetings each week?');
    expect(counter()).toBe('Step 2 of 8');

    await click(document.querySelector('.fn-back')!);
    await waitForHeading('Where does the team work most of the time?');
    expect(search()).toBe('?step=work_mode');
    expect(byText('[role="radio"]', 'Hybrid').getAttribute('aria-checked')).toBe('true');

    // Remote hides the office-days question: the total shrinks, the hidden answer would be kept.
    await choose('Fully remote');
    await waitForHeading('How many hours per person go to meetings each week?');
    expect(counter()).toBe('Step 2 of 7');

    await act(async () => window.history.back());
    await waitForHeading('Where does the team work most of the time?');
    await act(async () => window.history.forward());
    await waitForHeading('How many hours per person go to meetings each week?');
    await settle(50);

    const backs = eventsOf(sessionIdOf()).filter(([name]) => name === 'back_clicked');
    expect(backs).toEqual([
      ['back_clicked', 'meeting_hours'],
      ['back_clicked', 'meeting_hours'],
    ]);
  });

  it('resumes a stored session at the requested step, or at the first unanswered one if it is not reachable', async () => {
    const sessionId = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    server.create(sessionId, 'B', { answers: { work_mode: 'office', meeting_hours: 3 }, currentStepId: 'timezone_span', rev: 2 });
    window.localStorage.setItem(SESSION_KEY, sessionId);

    await open('/?step=priorities');
    await waitForHeading('How far apart are your working hours?');
    expect(search()).toBe('?step=timezone_span');
    expect(server.requests.some((r) => r.method === 'PUT' && /sessions\/[^/]+$/.test(r.path))).toBe(false);
    await close();

    await open('/?step=work_mode');
    await waitForHeading('Where does the team work most of the time?');
    expect(byText('[role="radio"]', 'Mostly in the office').getAttribute('aria-checked')).toBe('true');
    expect(sessionIdOf()).toBe(sessionId);
  });

  it('starts a new session at the intro even when the link names a later step', async () => {
    await open('/?step=work_mode&variant=B');
    await waitForHeading('Is your team losing time to the way it works?');
    expect(search()).toBe('?step=intro');
    await settle(50);
    expect(eventsOf(sessionIdOf())).toEqual([['step_viewed', 'intro']]);
  });

  it('shows a retryable error and repeats the same session PUT on retry', async () => {
    server.failRequests(1);
    await open('/');
    await waitForHeading('We could not load this page');
    await click(byText('button', 'Try again'));
    await waitFor(() => document.querySelector('.fn-info') !== null, 'the intro');
    const puts = server.requests.filter((r) => r.method === 'PUT' && /sessions\/[^/]+$/.test(r.path));
    expect(puts).toHaveLength(2);
    expect(puts[0]!.path).toBe(puts[1]!.path);
  });

  it('restarts an expired session once, although a save of the old session still waits for its retry', async () => {
    const sessionId = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    server.create(sessionId, 'B', { answers: COMPLETE, currentStepId: 'office_days', rev: 7 });
    window.localStorage.setItem(SESSION_KEY, sessionId);
    await open('/');
    await waitForHeading('How many office days are expected each week?');

    server.expire(sessionId);
    server.failRequests(1); // the save of the result step gets no response and waits for its retry
    await click(byText('button', 'Continue'));
    await waitForHeading('Is your team losing time to the way it works?');
    expect(document.querySelector('.fn-toast')?.textContent).toBe(EXPIRED_NOTICE);
    const restarted = sessionIdOf();
    expect(restarted).not.toBe(sessionId);

    await settle(1300); // past the old save's retry (backoff of at most 1.2 s)
    expect(sessionIdOf()).toBe(restarted);
    expect(server.requests.filter((r) => r.method === 'PUT' && /sessions\/[^/]+$/.test(r.path))).toHaveLength(1);
  });

  it('starts a new session when the result request finds no session, as after a deploy on a fresh database', async () => {
    const sessionId = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    server.create(sessionId, 'B', { answers: COMPLETE, currentStepId: 'result', rev: 8 });
    window.localStorage.setItem(SESSION_KEY, sessionId);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (input.endsWith('/result')) server.sessions.delete(sessionId); // the database was replaced after the page loaded
      return server.fetch(input, init);
    });

    await open('/');
    await waitForHeading('Is your team losing time to the way it works?');
    expect(document.querySelector('.fn-toast')?.textContent).toBe(EXPIRED_NOTICE);
    expect(sessionIdOf()).not.toBe(sessionId);
    expect(server.requests.filter((r) => r.path.endsWith('/result'))).toHaveLength(1);
  });
});
