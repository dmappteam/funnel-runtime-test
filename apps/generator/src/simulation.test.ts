import { describe, expect, it } from 'vitest';
import { computePath, resolveVariant } from '@funnel/engine';
import { loadConfig } from '@funnel/engine/testing';
import { ClientEventSchema, type ClientEvent } from '@funnel/contracts';
import type { Fault } from './fakeServer';
import { rawConfig, runFake, type FakeRun } from './testing';
import type { HttpRequest } from './transport';
import type { SessionRecord } from './virtualUser';

const eventsOf = (run: FakeRun) => run.simulation.records.map((r) => r.events);

function eventBodies(run: FakeRun): string[] {
  return run.server.requests.filter((r) => r.path === '/api/events').map((r) => r.body!);
}

function sentEvents(run: FakeRun): ClientEvent[] {
  return eventBodies(run).flatMap((body) => (JSON.parse(body) as { events: ClientEvent[] }).events);
}

describe('determinism', () => {
  it('replays the same sessions and events for the same seed, whatever the concurrency', async () => {
    const a = await runFake({ seed: 7, sessions: 60, concurrency: 8 });
    const b = await runFake({ seed: 7, sessions: 60, concurrency: 1 });
    expect(eventsOf(b)).toEqual(eventsOf(a));
    expect(b.report.groundTruth).toEqual(a.report.groundTruth);
    expect(b.simulation.ingestion.totals()).toEqual(a.simulation.ingestion.totals());

    const other = await runFake({ seed: 8, sessions: 60 });
    expect(eventsOf(other)).not.toEqual(eventsOf(a));
  });

  it('keeps the users of a seed when the server assigns other variants', async () => {
    const users = (run: FakeRun) => run.simulation.records.map((r) => [r.sessionId, r.profile, r.requestedVariant]);
    const random = await runFake({ seed: 7, sessions: 30 });
    const allA = await runFake({ seed: 7, sessions: 30 }, { assign: () => 'A' });
    expect(users(allA)).toEqual(users(random));
    expect(allA.simulation.records.filter((r) => r.assignment === 'random').every((r) => r.variant === 'A')).toBe(true);
  });
});

describe('events', () => {
  it.each([1, 3] as const)('v%i: every event passes ClientEventSchema and its pinned version, except the deliberate invalid ones', async (version) => {
    const run = await runFake({ sessions: 150 }, { configs: [rawConfig(version)] });
    const { ingestion } = run.simulation;
    let invalid = 0;
    for (const event of sentEvents(run)) {
      if (!ingestion.isValid(event.event_id)) {
        invalid++;
        expect(ingestion.statusesOf(event.event_id).every((s) => s === 'rejected')).toBe(true);
        continue;
      }
      const funnel = run.server.sessions.get(event.session_id)!.funnel;
      const def = funnel.events.allowed.find((d) => d.name === event.name);
      expect(ClientEventSchema.safeParse(event).success).toBe(true);
      expect(def, event.name).toBeDefined();
      expect(Object.keys(event.properties ?? {}).every((key) => def!.properties.includes(key))).toBe(true);
      expect(funnel.sequence).toContain(event.step_id);
    }
    expect(invalid).toBeGreaterThan(0);
    expect(run.report.ingestionChecks.every((c) => c.ok)).toBe(true);
    const expanded = sentEvents(run).some((e) => e.name === 'recommendation_expanded');
    expect(expanded).toBe(version === 3);
  });

  it('re-sends whole batches with the identical payload, so the same event ids come back as duplicates', async () => {
    const run = await runFake({ sessions: 80 });
    const { ingestion } = run.simulation;
    const counts = new Map<string, number>();
    for (const body of eventBodies(run)) counts.set(body, (counts.get(body) ?? 0) + 1);
    const resent = [...counts.entries()].filter(([, n]) => n > 1).map(([body]) => body);
    expect(resent.length).toBe(ingestion.batches.resent);
    expect(resent.length).toBeGreaterThan(0);
    for (const body of resent) {
      for (const event of (JSON.parse(body) as { events: ClientEvent[] }).events) {
        const expected = ingestion.isValid(event.event_id) ? ['accepted', 'duplicate'] : ['rejected', 'rejected'];
        expect(ingestion.statusesOf(event.event_id)).toEqual(expected);
      }
    }
    // Stored exactly once: one row per unique valid event plus the server's session_started rows.
    expect(run.server.events.size).toBe(run.report.events.uniqueValid + run.report.groundTruth.sessions);
  });

  it('retries lost and failed requests with the same payload and still stores every event once', async () => {
    let n = 0;
    const faulted: string[] = [];
    const fault = (req: HttpRequest): Fault => {
      n++;
      const f: Fault = n % 11 === 0 ? 'lost' : n % 17 === 0 ? 503 : n % 23 === 0 ? 'network' : null;
      if (f !== null) faulted.push(`${req.method} ${req.path} ${req.body ?? ''}`);
      return f;
    };
    const run = await runFake({ sessions: 60 }, { fault });
    const sent = run.server.requests.map((r) => `${r.method} ${r.path} ${r.body ?? ''}`);
    expect(faulted.length).toBeGreaterThan(10);
    for (const request of faulted) expect(sent.filter((s) => s === request).length).toBeGreaterThan(1);
    expect(run.report.events.retries).toBe(faulted.length);
    expect(run.report.ok).toBe(true);
    expect(run.server.events.size).toBe(run.report.events.uniqueValid + run.report.groundTruth.sessions);
  });
});

describe('virtual user', () => {
  const funnelOf = (r: SessionRecord) => resolveVariant(loadConfig(r.version as 1 | 2 | 3), r.variant!);
  const collapse = (ids: (string | null | undefined)[]) => ids.filter((id, i) => id !== ids[i - 1]);

  it("follows the engine's path: the viewed steps and every step_completed match computePath of the answers", async () => {
    const run = await runFake({ sessions: 150 }, { configs: [rawConfig(3)] });
    const straight = run.simulation.records.filter((r) => r.backClicks === 0);
    expect(straight.length).toBeGreaterThan(100);
    for (const record of straight) {
      const path = computePath(funnelOf(record), record.answers).entries.map((e) => e.stepId);
      // Reloads and comebacks show the same step again.
      const viewed = collapse(record.events.filter((e) => e.name === 'step_viewed').map((e) => e.step_id));
      expect(viewed).toEqual(path.slice(0, viewed.length));
      if (record.status === 'completed') expect(viewed).toEqual(path);
      for (const e of record.events.filter((x) => x.name === 'step_completed')) {
        expect(e.properties?.next_step_id).toBe(path[path.indexOf(e.step_id!) + 1]);
      }
    }
  });

  it('emits answer_submitted, step_completed, step_viewed per forward move and step_viewed after back_clicked', async () => {
    const run = await runFake({ sessions: 150 }, { configs: [rawConfig(3)] });
    const records = run.simulation.records;
    expect(records.some((r) => r.backClicks > 0)).toBe(true);
    expect(records.some((r) => r.branchChanged)).toBe(true);
    for (const record of records) {
      const funnel = funnelOf(record);
      const events = record.events;
      expect(events[0]).toMatchObject({ name: 'step_viewed', step_id: funnel.sequence[0] });
      events.forEach((e, i) => {
        const next = events[i + 1];
        if (e.name === 'answer_submitted') expect(next).toMatchObject({ name: 'step_completed', step_id: e.step_id });
        if (e.name === 'step_completed') expect(next).toMatchObject({ name: 'step_viewed', step_id: e.properties?.next_step_id });
        if (e.name === 'back_clicked') {
          const destination = e.properties?.destination_step_id as string;
          expect(next).toMatchObject({ name: 'step_viewed', step_id: destination });
          expect(funnel.sequence.indexOf(destination)).toBeLessThan(funnel.sequence.indexOf(e.step_id!));
        }
        if (e.name === 'cta_clicked') expect(events[i - 1]?.name).toBe('result_viewed');
      });
      expect(events.some((e) => e.name === 'session_started')).toBe(false);
    }
  });

  it('covers the branches and results of v3, compliance included', async () => {
    const run = await runFake({ sessions: 200 }, { configs: [rawConfig(3)] });
    const records = run.simulation.records;
    const results = new Set(records.map((r) => r.resultId));
    for (const id of ['regulated_scale', 'meeting_heavy', 'async_native', 'hybrid_structured', 'office_core', 'balanced']) {
      expect(results).toContain(id);
    }
    const priorities = records.flatMap((r) => (Array.isArray(r.answers.priorities) ? [r.answers.priorities] : []));
    const compliance = priorities.filter((p) => p.includes('compliance')).length / priorities.length;
    expect(compliance).toBeGreaterThan(0.15);
    expect(compliance).toBeLessThan(0.35);
    expect(new Set(records.map((r) => r.answers.security_constraints))).toEqual(new Set([undefined, 'standard', 'strict', 'regulated']));
    expect(records.filter((r) => r.lastStepId === 'intro' && r.status === 'left').length).toBeGreaterThan(0);
    expect(records.filter((r) => r.status === 'completed' && !r.ctaClicked).length).toBeGreaterThan(0);
    expect(records.some((r) => r.validationErrors > 0)).toBe(true);
    expect(records.some((r) => r.refreshes > 0)).toBe(true);
    expect(new Set(records.map((r) => r.profile)).size).toBe(5);
  });
});
