import { describe, expect, it } from 'vitest';
import type { ClientEvent } from '@funnel/contracts';
import { ApiClient, FUNNEL_ID } from './api';
import type { Persona } from './behaviour';
import { FakeServer } from './fakeServer';
import { computeGroundTruth, reachedSteps } from './groundTruth';
import { NO_CHAOS } from './outbox';
import { Simulation, seededIds } from './simulation';
import { NOW, rawConfig } from './testing';
import { compareCounts, fetchCounts } from './verify';

/** Remote, same hours, low async maturity: balanced in v1, office_days stays hidden. */
const persona: Persona = {
  workMode: 'remote',
  timezoneSpan: 'same',
  asyncMaturity: 'low',
  teamSize: 12,
  meetingHours: 5,
  officeDaysDraw: 0.5,
  priorities: ['focus'],
  wantsCompliance: false,
  securityConstraints: 'standard',
  toolCount: 6,
};

describe('ground truth', () => {
  it('matches hand-checked numbers for a tiny scripted run', async () => {
    // Sessions alternate A, B, A, B; the fifth forces B and is QA traffic.
    const server = new FakeServer({ configs: [rawConfig(1)], assign: (_id, n) => (n % 2 === 0 ? 'A' : 'B') });
    const sim = new Simulation({ api: new ApiClient(server), seed: 1, now: NOW, chaos: NO_CHAOS, idsFor: seededIds(1) });
    const script = { persona, back: null, refreshAtMove: null, variantOverride: null };
    const users = [
      sim.newUser({ ...script, leaveAt: 'intro' }),
      sim.newUser({ ...script, leaveAt: null, cta: false }),
      sim.newUser({ ...script, leaveAt: null, cta: true }),
      sim.newUser({ ...script, leaveAt: 'team_size' }),
      sim.newUser({ ...script, leaveAt: null, cta: false, variantOverride: 'B' }),
    ];
    for (const user of users) await user.start();

    // A: intro, team_size, work_mode, priorities, timezone_span, async_maturity, tool_count, result (office_days hidden).
    // B: intro, work_mode, timezone_span, team_size, async_maturity, priorities, tool_count, result.
    // Events: leaves on intro 1; a finished walk is 1 + 1 + 6 questions × 3 + result_viewed = 21, +1 with the CTA;
    // B leaving on team_size: 1 + 1 + 3 + 3 = 8. Total 1 + 21 + 22 + 8 + 21 = 73.
    const truth = computeGroundTruth(sim.records);
    expect(truth).toEqual({
      sessions: 5,
      overrideSessions: 1,
      failedSessions: 0,
      groups: [
        {
          version: 1,
          variant: 'A',
          started: 2,
          reachedResult: 1,
          ctaClicked: 1,
          backClicked: 0,
          reached: { intro: 2, team_size: 1, work_mode: 1, priorities: 1, timezone_span: 1, async_maturity: 1, tool_count: 1, result: 1 },
          results: { balanced: 1 },
        },
        {
          version: 1,
          variant: 'B',
          started: 2,
          reachedResult: 1,
          ctaClicked: 0,
          backClicked: 0,
          reached: { intro: 2, work_mode: 2, timezone_span: 2, team_size: 2, async_maturity: 1, priorities: 1, tool_count: 1, result: 1 },
          results: { balanced: 1 },
        },
      ],
    });
    expect(sim.records.map((r) => r.events.length)).toEqual([1, 21, 22, 8, 21]);
    expect(sim.ingestion.totals()).toEqual({ uniqueValid: 73, resentValid: 0, invalidEvents: 0, invalidSends: 0, uncertain: 0 });
    expect(server.events.size).toBe(73 + 5);

    const empty = { groups: new Map(), rejected: null };
    const checks = compareCounts(truth, empty, await fetchCounts(new ApiClient(server), FUNNEL_ID, [1]), [1]);
    // Per variant: 3 KPIs and the 9 steps of v1, office_days included with 0 sessions.
    expect(checks).toHaveLength(2 * (3 + 9));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('counts a step as reached by any event on it or a navigation event pointing at it', () => {
    const event = (name: string, step_id: string, properties: Record<string, unknown> = {}): ClientEvent => ({
      event_id: `evt-${name}-${step_id}`,
      session_id: '0b7f6c1e-8a4d-4c52-9a8e-3f1d2c4b5a69',
      name,
      client_ts: '2026-10-08T10:00:00.000Z',
      step_id,
      properties,
    });
    const steps = reachedSteps([
      event('step_viewed', 'intro'),
      event('step_completed', 'work_mode', { next_step_id: 'timezone_span' }),
      event('back_clicked', 'team_size', { destination_step_id: 'priorities' }),
    ]);
    expect([...steps].sort()).toEqual(['intro', 'priorities', 'team_size', 'timezone_span', 'work_mode']);
  });
});
