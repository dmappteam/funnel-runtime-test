import type { StepMetrics } from '@funnel/contracts';
import type { StepLayout } from './layout';
import { reachedResult, type SessionSummary } from './sessions';
import { ratio } from './util';

/** Positions of the steps a session reached. Steps outside the variant's sequence are ignored. */
function reachedPositions(s: SessionSummary, layout: StepLayout): Set<number> {
  const out = new Set<number>();
  for (const id of s.steps) {
    const position = layout.positions.get(id);
    if (position !== undefined) out.add(position);
  }
  if (layout.resultPosition !== null && reachedResult(s)) out.add(layout.resultPosition);
  return out;
}

/**
 * Step funnel of one version × variant. A session advanced past a step when its furthest reached step lies
 * later in the sequence, so back navigation and repeated views change nothing, and a step followed by a
 * conditional step is not penalised by sessions that skip the conditional one.
 */
export function stepMetrics(sessions: readonly SessionSummary[], layout: StepLayout | null): StepMetrics[] {
  if (!layout) return [];
  const size = layout.steps.length;
  const reached = new Array<number>(size).fill(0);
  const advanced = new Array<number>(size).fill(0);
  const dropoff = new Array<number>(size).fill(0);

  for (const s of sessions) {
    const positions = reachedPositions(s, layout);
    if (positions.size === 0) continue;
    const furthest = Math.max(...positions);
    for (const p of positions) {
      reached[p]++;
      if (furthest > p) advanced[p]++;
    }
    // Leaving while the result was loading is a drop-off at the result step, so drop-offs plus
    // sessions with a result always add up to the sessions that reached the first step.
    if (!reachedResult(s)) dropoff[furthest]++;
  }

  const started = sessions.length;
  return layout.steps.map((step, i) => ({
    stepId: step.id,
    position: i,
    type: step.type,
    conditional: step.conditional,
    reached: reached[i],
    advanced: advanced[i],
    conversion: ratio(advanced[i], reached[i]),
    dropoff: dropoff[i],
    dropoffRate: ratio(dropoff[i], reached[i]),
    reachedFromStart: ratio(reached[i], started),
  }));
}
