import { describe, expect, it } from 'vitest';
import { NO_CAMPAIGN, type AnalyticsEventRow, type GroupReport } from '@funnel/contracts';
import { aggregate } from './aggregate';
import { CONFIGS, FUNNEL_ID, NOW, eventsOf, groupOf, pathTo, run, sequence, session, shuffle } from './testing';

// v1 A: intro, team_size, work_mode, priorities, timezone_span, office_days (hybrid/office only), async_maturity, tool_count, result
const full = pathTo(1, 'A', 'result');
const remote = pathTo(1, 'A', 'result', ['office_days']);

/** [stepId, reached, advanced, dropoff] per step. */
const funnel = (g: GroupReport) => g.steps.map((s) => [s.stepId, s.reached, s.advanced, s.dropoff]);
const stepOf = (g: GroupReport, stepId: string) => g.steps.find((s) => s.stepId === stepId)!;
const resultEvents = (events: AnalyticsEventRow[]) => events.filter((e) => e.name === 'result_viewed');

/** Five v1 A sessions: a remote and a hybrid one reach the result, two leave midway, one never renders a step. */
function basicSessions() {
  return [
    session('s1').walk(remote).result('async_native').cta('async_native'),
    session('s2').walk(full).result('hybrid_structured'),
    session('s3').walk(pathTo(1, 'A', 'async_maturity', ['office_days'])),
    session('s4').walk(pathTo(1, 'A', 'office_days')),
    session('s5'),
  ];
}

/** Every situation at once: versions, variants, campaigns, overrides, back navigation, changed results, new events. */
function mixedDataset(): AnalyticsEventRow[] {
  const changed = session('m-change', { campaign: 'spring' }).walk(remote).result('async_native').back('result', 'tool_count');
  changed.view('tool_count').back('tool_count', 'async_maturity').view('async_maturity');
  changed.walk(pathTo(1, 'A', 'result').slice(6)).result('office_core').cta('office_core');
  return eventsOf(
    ...basicSessions(),
    changed,
    session('m-back', { variant: 'B' }).walk(pathTo(1, 'B', 'team_size')).back('team_size', 'timezone_span').view('timezone_span'),
    session('m-qa', { variant: 'B', assignment: 'override', campaign: 'spring' }).walk(pathTo(1, 'B', 'result')).result('balanced'),
    session('m-v2', { version: 2, campaign: 'brand' }).walk(pathTo(2, 'A', 'meeting_hours')),
    session('m-v3', { version: 3, variant: 'B' })
      .walk(pathTo(3, 'B', 'result', ['security_constraints', 'office_days']))
      .result('meeting_heavy')
      .cta('meeting_heavy')
      .add('recommendation_expanded', 'result', { result_id: 'meeting_heavy', action: 'expand_recommendation', source: 'cta' }),
    session('m-v3a', { version: 3, campaign: 'brand' }).walk(pathTo(3, 'A', 'security_constraints')),
  );
}

describe('step funnel', () => {
  it('counts distinct sessions per step and gives a conditional step its own denominator', () => {
    const g = groupOf(run(eventsOf(...basicSessions())), 1, 'A');
    // reached: s1–s4 enter every step up to timezone_span; office_days only s2 and s4 (hybrid);
    //   async_maturity s1, s2, s3; tool_count and result s1, s2. s5 never rendered a step.
    // advanced: the furthest step lies later. After timezone_span: s1, s2 (result), s3 (async_maturity), s4 (office_days),
    //   so the remote sessions that skip office_days do not lower timezone_span's conversion (4 / 4).
    // dropoff: s4 at office_days, s3 at async_maturity.
    expect(funnel(g)).toEqual([
      ['intro', 4, 4, 0],
      ['team_size', 4, 4, 0],
      ['work_mode', 4, 4, 0],
      ['priorities', 4, 4, 0],
      ['timezone_span', 4, 4, 0],
      ['office_days', 2, 1, 1],
      ['async_maturity', 3, 2, 1],
      ['tool_count', 2, 2, 0],
      ['result', 2, 0, 0],
    ]);
    expect(stepOf(g, 'timezone_span').conversion).toBe(1);
    expect(stepOf(g, 'office_days')).toMatchObject({
      position: 5,
      type: 'number',
      conditional: true,
      conversion: 0.5,
      dropoffRate: 0.5,
      reachedFromStart: 0.4,
    });
    expect(stepOf(g, 'async_maturity').conversion).toBeCloseTo(2 / 3, 10);
    expect(stepOf(g, 'intro')).toMatchObject({ type: 'info', conditional: false, reachedFromStart: 0.8 });
  });

  it('computes KPIs over started sessions with Wilson intervals', () => {
    const g = groupOf(run(eventsOf(...basicSessions())), 1, 'A');
    // 5 started (s5 included), 2 saw a result, 1 clicked the CTA, nobody went back.
    expect(g.kpi).toMatchObject({ started: 5, reachedResult: 2, ctaClicked: 1 });
    expect(g.kpi.resultRate).toMatchObject({ numerator: 2, denominator: 5, value: 0.4 });
    expect(g.kpi.ctr).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(g.kpi.ctaConversion).toMatchObject({ numerator: 1, denominator: 5, value: 0.2 });
    expect(g.kpi.backRate).toMatchObject({ numerator: 0, denominator: 5, value: 0, ciLow: 0 });
    expect(g.kpi.ctaConversion.ciLow).toBeLessThan(0.2);
    expect(g.kpi.ctaConversion.ciHigh).toBeGreaterThan(0.2);
    expect(g.results).toEqual([
      { resultId: 'async_native', sessions: 1 },
      { resultId: 'hybrid_structured', sessions: 1 },
    ]);
  });

  it('counts repeated views of a step once', () => {
    // s1 refreshes team_size twice and leaves there.
    const s1 = session('s1').walk(['intro', 'team_size']).view('team_size').view('team_size');
    const g = groupOf(run(s1.events), 1, 'A');
    expect(funnel(g).slice(0, 3)).toEqual([
      ['intro', 1, 1, 0],
      ['team_size', 1, 0, 1],
      ['work_mode', 0, 0, 0],
    ]);
    expect(stepOf(g, 'work_mode').conversion).toBeNull();
    // The events table still shows every view: intro + 3 × team_size.
    expect(g.events.find((e) => e.name === 'step_viewed')).toEqual({ name: 'step_viewed', sessions: 1, events: 4 });
  });

  it('keeps the furthest step after back navigation', () => {
    // s1: forward to priorities (C), back to work_mode (B), leaves → furthest = priorities, drop-off there.
    const s1 = session('s1').walk(pathTo(1, 'A', 'priorities')).back('priorities', 'work_mode').view('work_mode');
    // s2: the same detour, then forward to the result: every step still counts once.
    const s2 = session('s2').walk(pathTo(1, 'A', 'priorities')).back('priorities', 'work_mode');
    s2.walk(remote.slice(remote.indexOf('work_mode'))).result('balanced');
    const g = groupOf(run(eventsOf(s1, s2)), 1, 'A');
    expect(funnel(g).slice(1, 5)).toEqual([
      ['team_size', 2, 2, 0],
      ['work_mode', 2, 2, 0],
      ['priorities', 2, 1, 1],
      ['timezone_span', 1, 1, 0],
    ]);
    expect(g.kpi.backRate.value).toBe(1);
    // step_viewed: s1 5 (work_mode twice), s2 10 (work_mode and priorities twice).
    expect(g.events.find((e) => e.name === 'step_viewed')).toEqual({ name: 'step_viewed', sessions: 2, events: 15 });
    expect(g.events.find((e) => e.name === 'back_clicked')).toEqual({ name: 'back_clicked', sessions: 2, events: 2 });
  });

  it('ignores step ids that are not in the variant sequence', () => {
    // v3 B has no tool_count: a stray event on it must not move the furthest step.
    const s1 = session('s1', { version: 3, variant: 'B' }).walk(['intro', 'work_mode']).view('tool_count');
    const g = groupOf(run(s1.events), 3, 'B');
    expect(g.steps.map((s) => s.stepId)).toEqual(sequence(3, 'B'));
    expect(stepOf(g, 'work_mode')).toMatchObject({ reached: 1, advanced: 0, dropoff: 1 });
  });
});

describe('duplicates and arrival order', () => {
  it('drops duplicated event_ids, e.g. a retried batch', () => {
    const events = eventsOf(...basicSessions());
    const retried = [...events, ...events.slice(10, 30), ...events];
    expect(run(retried)).toEqual(run(events));
    expect(run(retried).totals.events).toBe(events.length);
  });

  it('keeps the first occurrence of a conflicting duplicate', () => {
    const s1 = session('s1').walk(['intro', 'team_size']);
    // Same event_id as the team_size view, different content.
    const conflicting = { ...s1.events[2]!, step_id: 'tool_count' };
    expect(stepOf(groupOf(run([...s1.events, conflicting]), 1, 'A'), 'tool_count').reached).toBe(0);
    expect(stepOf(groupOf(run([conflicting, ...s1.events]), 1, 'A'), 'tool_count').reached).toBe(1);
  });

  it('gives identical reports for reversed and shuffled input', () => {
    const events = mixedDataset();
    for (const filters of [{}, { includeOverrides: true }, { campaign: 'spring', includeOverrides: true }, { version: 3 }]) {
      const expected = run(events, filters);
      expect(run([...events].reverse(), filters)).toEqual(expected);
      for (const seed of [1, 2, 3, 42, 2026]) expect(run(shuffle(events, seed), filters)).toEqual(expected);
      expect(run(shuffle([...events, ...events], 7), filters)).toEqual(expected);
    }
  });

  it('counts a result_viewed that arrives before the step_completed events leading to it', () => {
    const s1 = session('s1').walk(remote).result('async_native').cta('async_native');
    // The outbox flushed the result events first, so they also carry earlier server times.
    const resultFirst = ['result_viewed', 'cta_clicked'];
    const early = s1.events
      .filter((e) => resultFirst.includes(e.name))
      .map((e, i) => ({ ...e, server_ts: `2026-10-01T08:59:5${i}.000Z` }));
    const late = s1.events.filter((e) => !resultFirst.includes(e.name));
    const g = groupOf(run([...early, ...late]), 1, 'A');
    expect(g).toEqual(groupOf(run(s1.events), 1, 'A'));
    expect(g.kpi).toMatchObject({ started: 1, reachedResult: 1, ctaClicked: 1 });
    expect(g.steps.every((s) => s.dropoff === 0)).toBe(true);
  });

  it('infers a step from step_completed when its view is lost, and a seen result from cta_clicked', () => {
    // s1 lost the step_viewed of tool_count: async_maturity's step_completed (next_step_id: tool_count) proves it.
    const s1 = session('s1').walk(pathTo(1, 'A', 'tool_count', ['office_days']));
    const lost = s1.events.filter((e) => !(e.name === 'step_viewed' && e.step_id === 'tool_count'));
    // s2 lost its result_viewed but clicked the CTA.
    const s2 = session('s2').walk(remote).cta('balanced');
    const g = groupOf(run([...lost, ...s2.events]), 1, 'A');
    expect(stepOf(g, 'tool_count')).toMatchObject({ reached: 2, advanced: 1, dropoff: 1 });
    expect(g.kpi).toMatchObject({ started: 2, reachedResult: 1, ctaClicked: 1 });
    expect(g.kpi.ctr.value).toBe(1);
    // Result attribution only uses result_viewed.
    expect(g.results).toEqual([]);
  });
});

describe('result attribution', () => {
  it('attributes the latest result after going back and changing an answer', () => {
    // s1 gets async_native as a remote team, goes back to work_mode, switches to hybrid and gets hybrid_structured.
    const s1 = session('s1').walk(remote).result('async_native');
    const backPath = ['result', 'tool_count', 'async_maturity', 'timezone_span', 'priorities', 'work_mode'];
    backPath.slice(1).forEach((to, i) => s1.back(backPath[i]!, to).view(to));
    s1.walk(full.slice(full.indexOf('work_mode'))).result('hybrid_structured');
    // The second result reached the server first: server time disagrees with client time.
    const [first, second] = resultEvents(s1.events);
    [first!.server_ts, second!.server_ts] = [second!.server_ts, first!.server_ts];

    for (const events of [s1.events, [...s1.events].reverse()]) {
      const g = groupOf(run(events), 1, 'A');
      expect(g.results).toEqual([{ resultId: 'hybrid_structured', sessions: 1 }]);
      expect(stepOf(g, 'office_days')).toMatchObject({ reached: 1, advanced: 1 });
      expect(g.steps.every((s) => s.dropoff === 0)).toBe(true);
    }
  });

  it('compares client times across offsets and falls back to server time', () => {
    // s1: the later result in real time has the lexicographically smaller timestamp.
    const s1 = session('s1').walk(remote).result('balanced').result('async_native');
    const [late, early] = resultEvents(s1.events);
    late!.client_ts = '2026-10-01T09:00:30.000Z';
    early!.client_ts = '2026-10-01T19:00:20.000+10:00'; // 09:00:20Z
    // s2: no client times, the server time decides.
    const s2 = session('s2').walk(remote).result('async_native').result('office_core');
    for (const e of resultEvents(s2.events)) e.client_ts = null;

    expect(groupOf(run(eventsOf(s1, s2)), 1, 'A').results).toEqual([
      { resultId: 'balanced', sessions: 1 },
      { resultId: 'office_core', sessions: 1 },
    ]);
  });
});

describe('filters', () => {
  const campaigns = () =>
    eventsOf(
      session('c1', { campaign: 'spring' }).walk(remote).result('async_native').cta('async_native'),
      session('c2', { campaign: 'spring' }).walk(pathTo(1, 'A', 'work_mode')),
      session('c3', { campaign: 'brand', variant: 'B' }).walk(pathTo(1, 'B', 'work_mode')),
      session('c4').walk(remote).result('balanced'),
      session('c5'),
    );

  it('filters by exact campaign and by NO_CAMPAIGN', () => {
    const all = run(campaigns());
    expect(all.totals).toEqual({ events: campaigns().length, sessions: 5, overrideSessions: 0, previewSessions: 0 });
    expect(all.available.campaigns).toEqual(['brand', 'spring', NO_CAMPAIGN]);

    const spring = run(campaigns(), { campaign: 'spring' });
    expect(spring.groups.map((g) => [g.variant, g.kpi.started, g.kpi.reachedResult, g.kpi.ctaClicked])).toEqual([['A', 2, 1, 1]]);
    // c4 and c5 have no campaign.
    const none = run(campaigns(), { campaign: NO_CAMPAIGN });
    expect(none.groups.map((g) => [g.variant, g.kpi.started, g.kpi.reachedResult, g.kpi.ctaClicked])).toEqual([['A', 2, 1, 0]]);
    // The campaign options do not depend on the selection.
    expect(none.available).toEqual(all.available);
    expect(run(campaigns(), { campaign: 'unknown' }).groups).toEqual([]);
    expect(run(campaigns(), { campaign: '' }).filters.campaign).toBeNull();
  });

  it('excludes QA override sessions unless asked, and counts them within the campaign filter', () => {
    const events = eventsOf(
      session('r1', { campaign: 'spring' }).walk(remote).result('async_native').cta('async_native'),
      session('r2', { variant: 'B' }).walk(pathTo(1, 'B', 'work_mode')),
      session('o1', { variant: 'B', assignment: 'override', campaign: 'spring' })
        .walk(pathTo(1, 'B', 'result', ['office_days']))
        .result('async_native')
        .cta('async_native'),
      session('o2', { assignment: 'override' }).walk(['intro']),
    );
    const variants = (r: ReturnType<typeof run>) => r.groups.map((g) => [g.variant, g.kpi.started, g.kpi.ctaClicked]);

    const excluded = run(events);
    expect(excluded.totals).toMatchObject({ sessions: 2, overrideSessions: 2 });
    expect(variants(excluded)).toEqual([
      ['A', 1, 1],
      ['B', 1, 0],
    ]);
    const included = run(events, { includeOverrides: true });
    expect(included.totals).toMatchObject({ sessions: 4, overrideSessions: 2 });
    expect(variants(included)).toEqual([
      ['A', 2, 1],
      ['B', 2, 1],
    ]);
    expect(run(events, { campaign: 'spring' }).totals).toMatchObject({ sessions: 1, overrideSessions: 1 });
    expect(run(events, { campaign: NO_CAMPAIGN }).totals).toMatchObject({ sessions: 1, overrideSessions: 1 });
  });

  it('restricts groups and A/B to the selected version but lists every version', () => {
    const events = eventsOf(
      ...[1, 2, 3].flatMap((version) => [
        session(`v${version}a`, { version }).walk(['intro']),
        session(`v${version}b`, { version, variant: 'B' }).walk(['intro']),
      ]),
    );
    const r = run(events, { version: 2 });
    expect(r.filters.version).toBe(2);
    expect(r.groups.map((g) => `${g.version}${g.variant}`)).toEqual(['2A', '2B']);
    expect(r.ab.map((a) => a.version)).toEqual([2]);
    expect(r.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(r.available.versions).toEqual([1, 2, 3]);
    expect(r.totals.sessions).toBe(6);
    expect(run(events, { version: 4 }).groups).toEqual([]);
  });

  it('ignores other funnels everywhere, including the available filter values', () => {
    const own = session('s1').walk(['intro']);
    const other = session('x1', { funnelId: 'other-funnel', version: 7, campaign: 'elsewhere' }).walk(['intro']);
    const r = run(eventsOf(own, other));
    expect(r.available).toEqual({ versions: [1], campaigns: [NO_CAMPAIGN] });
    expect(r.totals).toEqual({ events: own.events.length, sessions: 1, overrideSessions: 0, previewSessions: 0 });
  });

  it('never counts admin preview sessions, even with overrides included', () => {
    const events = eventsOf(
      session('r1').walk(remote).result('async_native').cta('async_native'),
      session('p1', { variant: 'B', assignment: 'preview' }).walk(pathTo(1, 'B', 'work_mode')),
      // A preview of an unpublished version must not appear among the versions to pick.
      session('p2', { version: 3, assignment: 'preview' }).walk(['intro']),
    );
    for (const includeOverrides of [false, true]) {
      const r = run(events, { includeOverrides });
      expect(r.totals).toMatchObject({ sessions: 1, overrideSessions: 0, previewSessions: 2 });
      expect(r.groups.map((g) => [g.version, g.variant, g.kpi.started])).toEqual([[1, 'A', 1]]);
      expect(r.available.versions).toEqual([1]);
    }
  });
});

describe('session attributes', () => {
  it('takes version and variant from session_started when events disagree, else from the smallest event_id', () => {
    const s1 = session('s1').walk(['intro', 'team_size']);
    s1.events[2] = { ...s1.events[2]!, funnel_version: 2, variant: 'B' };
    // No session_started: s2-001 (v3 B) is smaller than s2-002, which claims v1 A.
    const s2 = session('s2', { version: 3, variant: 'B', started: false }).walk(['intro', 'work_mode']);
    s2.events[1] = { ...s2.events[1]!, funnel_version: 1, variant: 'A' };
    const r = run(eventsOf(s1, s2));
    expect(r.groups.map((g) => [g.version, g.variant, g.kpi.started])).toEqual([
      [1, 'A', 1],
      [3, 'B', 1],
    ]);
    expect(stepOf(groupOf(r, 1, 'A'), 'team_size').reached).toBe(1);
    expect(stepOf(groupOf(r, 3, 'B'), 'work_mode').reached).toBe(1);
  });
});

describe('events', () => {
  it('lists every event name, including ones introduced by a later version', () => {
    const v3 = session('n1', { version: 3, variant: 'B' })
      .walk(pathTo(3, 'B', 'result', ['security_constraints', 'office_days']))
      .result('async_native')
      .cta('async_native')
      .add('recommendation_expanded', 'result', { result_id: 'async_native', action: 'expand_recommendation', source: 'cta' })
      .add('faq_opened', null);
    const v1 = session('o1').walk(remote).result('async_native');
    const r = run(eventsOf(v3, v1));
    // Config order of events.allowed, then names the config does not know.
    expect(groupOf(r, 3, 'B').events.map((e) => e.name)).toEqual([
      'session_started',
      'step_viewed',
      'answer_submitted',
      'step_completed',
      'result_viewed',
      'cta_clicked',
      'recommendation_expanded',
      'faq_opened',
    ]);
    expect(groupOf(r, 3, 'B').events).toContainEqual({ name: 'recommendation_expanded', sessions: 1, events: 1 });
    expect(groupOf(r, 1, 'A').events.map((e) => e.name)).not.toContain('recommendation_expanded');
  });
});

describe('versions', () => {
  it('reports several versions, each grouped and ordered by its own config', () => {
    const a1 = session('a1', { start: '2026-09-01T10:00:00.000Z' }).walk(remote).result('async_native').cta('async_native');
    const a2 = session('a2', { variant: 'B', start: '2026-09-02T10:00:00.000Z' }).walk(['intro']);
    const b1 = session('b1', { version: 2, start: '2026-09-10T10:00:00.000Z' })
      .walk(pathTo(2, 'A', 'result', ['office_days']))
      .result('meeting_heavy');
    const c1 = session('c1', { version: 3, variant: 'B', start: '2026-09-20T10:00:00.000Z' })
      .walk(pathTo(3, 'B', 'result', ['security_constraints', 'office_days']))
      .result('async_native')
      .cta('async_native');
    const c2 = session('c2', { version: 3, start: '2026-09-21T10:00:00.000Z' }).walk(['intro', 'team_size']);
    const r = run(shuffle(eventsOf(a1, a2, b1, c1, c2), 5));
    const experiment = (version: number) => CONFIGS[version]!.experiment.id;

    expect(r.groups.map((g) => [g.version, g.variant, g.experimentId])).toEqual([
      [1, 'A', experiment(1)],
      [1, 'B', experiment(1)],
      [2, 'A', experiment(2)],
      [3, 'A', experiment(3)],
      [3, 'B', experiment(3)],
    ]);
    // Each variant keeps its own order: v3 B asks work_mode second and has no tool_count.
    expect(groupOf(r, 3, 'B').steps.map((s) => s.stepId)).toEqual(sequence(3, 'B'));
    expect(groupOf(r, 3, 'A').steps.map((s) => s.stepId)).toEqual(sequence(3, 'A'));
    // A/B only where a version has two variants.
    expect(r.ab.map((a) => [a.version, a.control, a.treatment])).toEqual([
      [1, 'A', 'B'],
      [3, 'A', 'B'],
    ]);
    // All variants combined. v1 runs from a1's session_started to a2's intro view (+1 s), v3 from c1's start to c2's team_size view (+2 s).
    const versions = r.versions.map((v) => ({
      version: v.version,
      experimentId: v.experimentId,
      variants: v.variants,
      seen: [v.firstSeen, v.lastSeen],
      kpi: [v.kpi.started, v.kpi.reachedResult, v.kpi.ctaClicked],
    }));
    expect(versions).toEqual([
      {
        version: 1,
        experimentId: experiment(1),
        variants: ['A', 'B'],
        seen: ['2026-09-01T10:00:00.000Z', '2026-09-02T10:00:01.000Z'],
        kpi: [2, 1, 1],
      },
      {
        version: 2,
        experimentId: experiment(2),
        variants: ['A'],
        seen: ['2026-09-10T10:00:00.000Z', b1.events.at(-1)!.server_ts],
        kpi: [1, 1, 0],
      },
      {
        version: 3,
        experimentId: experiment(3),
        variants: ['A', 'B'],
        seen: ['2026-09-20T10:00:00.000Z', '2026-09-21T10:00:02.000Z'],
        kpi: [2, 1, 1],
      },
    ]);
  });

  it('reports KPIs without a step funnel for a version whose config is missing', () => {
    const r = run(session('m1', { version: 9 }).walk(['intro']).events);
    expect(groupOf(r, 9, 'A')).toMatchObject({ experimentId: 'experiment-v9', steps: [], kpi: { started: 1 } });
  });
});

describe('A/B comparison', () => {
  /** `n` sessions of a variant: the first `results` see a result, the first `clicks` of them click the CTA. */
  const cohort = (variant: string, n: number, results: number, clicks: number) =>
    Array.from({ length: n }, (_, i) => {
      const s = session(`${variant}-${String(i).padStart(3, '0')}`, { variant });
      if (i < results) s.result('balanced');
      if (i < clicks) s.cta('balanced');
      return s;
    });

  it('tests the primary metric with the reference numbers', () => {
    // CTA conversion A 30/100, B 45/100: +15 p.p., z ≈ 2.191, p ≈ 0.0285, ≈160 sessions per variant.
    const r = run(eventsOf(...cohort('A', 100, 60, 30), ...cohort('B', 100, 70, 45)));
    const ab = r.ab[0]!;
    expect(ab).toMatchObject({
      version: 1,
      experimentId: CONFIGS[1]!.experiment.id,
      control: 'A',
      treatment: 'B',
      requiredSessionsPerVariant: 160,
    });
    expect(ab.primary).toMatchObject({ metric: 'ctaConversion', significant: true });
    expect(ab.primary.control.value).toBe(0.3);
    expect(ab.primary.treatment.value).toBe(0.45);
    expect(ab.primary.absDiff).toBeCloseTo(0.15, 10);
    expect(ab.primary.relativeLift).toBeCloseTo(0.5, 10);
    expect(ab.primary.pValue).toBeCloseTo(0.0285, 3);
    expect(ab.primary.diffCiLow).toBeCloseTo(0.0174, 3);
    expect(ab.primary.diffCiHigh).toBeCloseTo(0.2826, 3);
    // Result rate 60% vs 70%: pooled SE = √(0.65 · 0.35 · 0.02) = 0.06745, z = 1.4825, p ≈ 0.138.
    const [resultRate, ctr] = ab.secondary;
    expect(resultRate).toMatchObject({ metric: 'resultRate', significant: false });
    expect(resultRate!.pValue).toBeCloseTo(0.138, 3);
    // CTR 30/60 vs 45/70.
    expect(ctr!.metric).toBe('ctr');
    expect(ctr!.control.value).toBe(0.5);
    expect(ctr!.treatment.value).toBeCloseTo(45 / 70, 10);
  });

  it('targets +5 p.p. for the sample size when no difference is observed', () => {
    // 10% vs 10%: (1.96 + 0.8416)² · (0.1 · 0.9 + 0.15 · 0.85) / 0.05² = 682.9 → 683
    const r = run(eventsOf(...cohort('A', 50, 5, 5), ...cohort('B', 50, 5, 5)));
    expect(r.ab[0]).toMatchObject({
      requiredSessionsPerVariant: 683,
      primary: { absDiff: 0, relativeLift: 0, pValue: 1, significant: false },
    });
  });

  it('checks the random split against the 50/50 weights, ignoring forced variants', () => {
    // 50 vs 50 is exactly the expected split; 70 vs 30: χ² = 2 · 20² / 50 = 16, p ≈ 6.3e-5.
    const even = run(eventsOf(...cohort('A', 50, 0, 0), ...cohort('B', 50, 0, 0))).ab[0]!;
    expect(even.srm).toEqual({
      variants: [
        { variant: 'A', sessions: 50, expectedShare: 0.5 },
        { variant: 'B', sessions: 50, expectedShare: 0.5 },
      ],
      pValue: 1,
      mismatch: false,
    });
    const skewed = run(eventsOf(...cohort('A', 70, 0, 0), ...cohort('B', 30, 0, 0))).ab[0]!;
    expect(skewed.srm.mismatch).toBe(true);
    expect(skewed.srm.pValue).toBeCloseTo(6.33e-5, 6);
    // Forced B sessions do not follow the weights: with overrides included the comparison grows, the split check does not.
    const forced = Array.from({ length: 40 }, (_, i) => session(`f-${i}`, { variant: 'B', assignment: 'override' }));
    const withForced = run(eventsOf(...cohort('A', 50, 0, 0), ...cohort('B', 50, 0, 0), ...forced), { includeOverrides: true }).ab[0]!;
    expect(withForced.primary.treatment.denominator).toBe(90);
    expect(withForced.srm).toEqual(even.srm);
  });

  it('skips the split check while a variant expects fewer than 5 sessions', () => {
    const r = run(eventsOf(...cohort('A', 4, 0, 0), ...cohort('B', 5, 0, 0))).ab[0]!;
    expect(r.srm).toMatchObject({ pValue: null, mismatch: false });
  });

  describe('time to the required sample', () => {
    /** `n` sessions per variant, all started `daysAgo` days before NOW, with 10% vs 30% CTA conversion. */
    const experiment = (n: number, daysAgo: number) => {
      const start = new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString();
      return ['A', 'B'].flatMap((variant) =>
        Array.from({ length: n }, (_, i) => {
          const s = session(`${variant}-${i}`, { variant, start });
          if (i < n * (variant === 'A' ? 0.1 : 0.3)) s.result('balanced').cta('balanced');
          return s;
        }),
      );
    };

    it('estimates the days left at the average rate since the first session', () => {
      // 10% vs 30% needs (1.96 + 0.8416)² · (0.09 + 0.21) / 0.2² = 58.9 → 59 per variant.
      // 20 per variant in 2 days is 10 per variant per day: 39 more take 3.9 days.
      const ab = run(eventsOf(...experiment(20, 2)), {}, 1).ab[0]!;
      expect(ab.requiredSessionsPerVariant).toBe(59);
      expect(ab.eta.status).toBe('collecting');
      expect(ab.eta.sessionsPerDay).toBeCloseTo(20, 6);
      expect(ab.eta.daysLeft).toBeCloseTo(3.9, 6);
    });

    it('averages the rate over at least a day, so a burst of sessions is not extrapolated', () => {
      // 20 per variant in the last hour count as 20 per variant per day: 39 more take 1.95 days, not two hours.
      const ab = run(eventsOf(...experiment(20, 1 / 24)), {}, 1).ab[0]!;
      expect(ab.eta.sessionsPerDay).toBeCloseTo(40, 6);
      expect(ab.eta.daysLeft).toBeCloseTo(1.95, 6);
    });

    it('reports a reached sample, and no estimate for a version that no longer gets sessions', () => {
      expect(run(eventsOf(...experiment(60, 2)), {}, 1).ab[0]!.eta).toMatchObject({ status: 'reached', daysLeft: 0 });
      expect(run(eventsOf(...experiment(20, 2)), {}, 2).ab[0]!.eta).toMatchObject({ status: 'stopped', daysLeft: null });
    });
  });
});

describe('report', () => {
  it('returns an empty report for no events', () => {
    expect(run([])).toEqual({
      generatedAt: NOW,
      filters: { funnelId: FUNNEL_ID, version: null, campaign: null, includeOverrides: false },
      available: { versions: [], campaigns: [] },
      totals: { events: 0, sessions: 0, overrideSessions: 0, previewSessions: 0 },
      versions: [],
      groups: [],
      ab: [],
    });
  });

  it('stamps the current time when no clock is given', () => {
    const before = Date.now();
    const { generatedAt } = aggregate({
      events: [],
      configs: CONFIGS,
      filters: { funnelId: FUNNEL_ID, version: null, campaign: null, includeOverrides: false },
      activeVersion: null,
    });
    expect(Date.parse(generatedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe('result step drop-off', () => {
  it('counts leaving while the result loads as a drop-off at the result step, so the funnel adds up', () => {
    // s1 sees the result, s2 opens the result step but leaves before it renders, s3 leaves at timezone_span.
    const events = eventsOf(
      session('s1').walk(remote).result('balanced'),
      session('s2').walk(remote),
      session('s3').walk(pathTo(1, 'A', 'timezone_span')),
    );
    const g = groupOf(run(events), 1, 'A');
    expect(stepOf(g, 'result').dropoff).toBe(1);
    expect(stepOf(g, 'timezone_span').dropoff).toBe(1);
    const dropoffs = g.steps.reduce((sum, s) => sum + s.dropoff, 0);
    expect(dropoffs + g.kpi.reachedResult).toBe(stepOf(g, 'intro').reached);
  });
});
