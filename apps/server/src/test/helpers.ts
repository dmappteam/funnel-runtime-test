import { randomUUID } from 'node:crypto';
import type { ClientEvent, EventBatchResponse, SessionResponse } from '@funnel/contracts';
import { hasInput, type Answers, type ResolvedFunnel } from '@funnel/engine';
import { readRawConfig } from '@funnel/engine/testing';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp, type AppOptions } from '../app';
import { openDb, type Db } from '../db';

export const FUNNEL_ID = 'workstyle-planner';
export const ADMIN = { user: 'admin', password: 'correct horse' };

type Headers = Record<string, string>;

export function basicAuthHeader(user: string, password: string): Headers {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

export class TestClock {
  private time = Date.parse('2026-10-08T10:00:00.000Z');
  readonly now = (): Date => new Date(this.time);

  advanceHours(hours: number): void {
    this.time += hours * 3_600_000;
  }
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  clock: TestClock;
  close(): Promise<void>;
}

/** App on a fresh in-memory DB with an injected clock. Random assignment yields variant A unless `random` is given. */
export async function createTestApp(options: Partial<Omit<AppOptions, 'db' | 'now'>> = {}): Promise<TestContext> {
  const db = openDb(':memory:');
  const clock = new TestClock();
  const app = await buildApp({ db, now: clock.now, random: () => 0.25, defaultFunnelId: FUNNEL_ID, ...options });
  return {
    app,
    db,
    clock,
    async close() {
      await app.close();
      db.close();
    },
  };
}

export function uploadVersion(app: FastifyInstance, config: object, headers?: Headers) {
  return app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL_ID}/versions`, payload: config, headers });
}

export function publishVersion(app: FastifyInstance, version: number, headers?: Headers) {
  return app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL_ID}/publish`, payload: { version }, headers });
}

export function rollback(app: FastifyInstance, headers?: Headers) {
  return app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL_ID}/rollback`, headers });
}

/** Uploads a shipped config (configs/funnel-vN.json) and publishes it. */
export async function release(app: FastifyInstance, version: 1 | 2 | 3, headers?: Headers): Promise<void> {
  const upload = await uploadVersion(app, readRawConfig(version), headers);
  expect(upload.statusCode, upload.body).toBe(201);
  const publish = await publishVersion(app, version, headers);
  expect(publish.statusCode, publish.body).toBe(200);
}

export async function openSession(app: FastifyInstance, body: object = {}, sessionId: string = randomUUID()) {
  const res = await app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}`, payload: body });
  return { sessionId, status: res.statusCode, data: res.json<SessionResponse>() };
}

export async function getSession(app: FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  return { status: res.statusCode, data: res.json<SessionResponse>() };
}

/** Valid answers for every question of v1–v3. */
const ANSWER_POOL: Answers = {
  team_size: 12,
  work_mode: 'hybrid',
  priorities: ['focus'],
  security_constraints: 'standard',
  timezone_span: 'same',
  office_days: 2,
  meeting_hours: 5,
  async_maturity: 'low',
  tool_count: 6,
};

/** Answers for exactly the questions of `funnel` (the pool, with `overrides` applied). */
export function answersFor(funnel: ResolvedFunnel, overrides: Answers = {}): Answers {
  const pool = { ...ANSWER_POOL, ...overrides };
  const answers: Answers = {};
  for (const id of funnel.sequence) {
    const step = funnel.steps[id];
    if (step && hasInput(step) && step.input.name in pool) answers[step.input.name] = pool[step.input.name]!;
  }
  return answers;
}

export function clientEvent(
  clock: TestClock,
  sessionId: string,
  fields: Pick<ClientEvent, 'name'> & Partial<ClientEvent>,
): ClientEvent {
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    client_ts: clock.now().toISOString(),
    step_id: null,
    properties: {},
    ...fields,
  };
}

export async function postEvents(app: FastifyInstance, events: unknown[]) {
  const res = await app.inject({ method: 'POST', url: '/api/events', payload: { events } });
  return { status: res.statusCode, data: res.json<EventBatchResponse>() };
}

export function count(db: Db, sql: string, ...params: unknown[]): number {
  return db.prepare(sql).pluck().get(...params) as number;
}
