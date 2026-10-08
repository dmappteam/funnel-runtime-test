import type { GroupReport, KpiSet } from '@funnel/contracts';
import type { FunnelConfig } from '@funnel/engine';
import { reachedResult, type SessionSummary } from './sessions';
import { rate } from './stats';
import { compare, listOrder } from './util';

export function kpiSet(sessions: readonly SessionSummary[]): KpiSet {
  const started = sessions.length;
  const withResult = sessions.filter(reachedResult).length;
  const ctaClicked = sessions.filter((s) => s.ctaClicked).length;
  const backClicked = sessions.filter((s) => s.backClicked).length;
  return {
    started,
    reachedResult: withResult,
    ctaClicked,
    resultRate: rate(withResult, started),
    ctr: rate(ctaClicked, withResult),
    ctaConversion: rate(ctaClicked, started),
    backRate: rate(backClicked, started),
  };
}

/** Sessions per final result, most frequent first. */
export function resultCounts(sessions: readonly SessionSummary[]): GroupReport['results'] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (s.finalResultId !== null) counts.set(s.finalResultId, (counts.get(s.finalResultId) ?? 0) + 1);
  }
  return [...counts]
    .map(([resultId, n]) => ({ resultId, sessions: n }))
    .sort((a, b) => b.sessions - a.sessions || compare(a.resultId, b.resultId));
}

/** Every event name seen, in the order of the version's `events.allowed`; names the config does not list follow alphabetically. */
export function eventStats(sessions: readonly SessionSummary[], config: FunnelConfig | undefined): GroupReport['events'] {
  const stats = new Map<string, { sessions: number; events: number }>();
  for (const s of sessions) {
    for (const [name, count] of s.eventCounts) {
      const entry = stats.get(name) ?? { sessions: 0, events: 0 };
      entry.sessions += 1;
      entry.events += count;
      stats.set(name, entry);
    }
  }
  const byConfig = listOrder(config?.events.allowed.map((e) => e.name) ?? []);
  return [...stats].map(([name, entry]) => ({ name, ...entry })).sort((a, b) => byConfig(a.name, b.name));
}
