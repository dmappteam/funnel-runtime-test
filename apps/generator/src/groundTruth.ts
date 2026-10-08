import type { ClientEvent } from '@funnel/contracts';
import type { SessionRecord } from './virtualUser';

/** Expected dashboard numbers of one version × variant, in distinct sessions. */
export interface GroupTruth {
  version: number;
  variant: string;
  started: number;
  reachedResult: number;
  ctaClicked: number;
  backClicked: number;
  /** Sessions per step, in the variant's step order. */
  reached: Record<string, number>;
  /** Final result per session. */
  results: Record<string, number>;
}

export interface GroundTruth {
  /** Sessions the server created. */
  sessions: number;
  /** QA sessions with a forced variant, excluded from `groups` like the A/B report does. */
  overrideSessions: number;
  failedSessions: number;
  groups: GroupTruth[];
}

/**
 * Computed from the simulation's own records, never with @funnel/analytics, so comparing it with
 * GET /api/analytics is an independent check.
 */
export function computeGroundTruth(records: readonly SessionRecord[]): GroundTruth {
  const groups = new Map<string, GroupTruth>();
  let sessions = 0;
  let overrideSessions = 0;
  let failedSessions = 0;

  for (const record of records) {
    if (record.version === null || record.variant === null) continue;
    sessions++;
    if (record.status === 'failed') failedSessions++;
    if (record.assignment === 'override') {
      overrideSessions++;
      continue;
    }
    const key = `${record.version}:${record.variant}`;
    let group = groups.get(key);
    if (!group) {
      group = emptyGroup(record);
      groups.set(key, group);
    }
    const has = (name: string) => record.events.some((e) => e.name === name);
    group.started++;
    if (has('result_viewed')) group.reachedResult++;
    if (has('cta_clicked')) group.ctaClicked++;
    if (has('back_clicked')) group.backClicked++;
    for (const stepId of reachedSteps(record.events)) group.reached[stepId] = (group.reached[stepId] ?? 0) + 1;
    const resultId = finalResult(record.events);
    if (resultId) group.results[resultId] = (group.results[resultId] ?? 0) + 1;
  }

  const sorted = [...groups.values()].sort((a, b) => a.version - b.version || a.variant.localeCompare(b.variant));
  return { sessions, overrideSessions, failedSessions, groups: sorted.map(dropUnreached) };
}

function emptyGroup(record: SessionRecord): GroupTruth {
  const reached = Object.fromEntries(record.sequence.map((id) => [id, 0]));
  return { version: record.version!, variant: record.variant!, started: 0, reachedResult: 0, ctaClicked: 0, backClicked: 0, reached, results: {} };
}

/** Keeps the variant's step order but lists only steps somebody reached. */
function dropUnreached(group: GroupTruth): GroupTruth {
  return { ...group, reached: Object.fromEntries(Object.entries(group.reached).filter(([, n]) => n > 0)) };
}

/** Steps a session reached: any event on the step, or a navigation event pointing at it. */
export function reachedSteps(events: readonly ClientEvent[]): Set<string> {
  const steps = new Set<string>();
  for (const event of events) {
    if (event.step_id) steps.add(event.step_id);
    const props = event.properties ?? {};
    if (event.name === 'step_completed' && typeof props.next_step_id === 'string') steps.add(props.next_step_id);
    if (event.name === 'back_clicked' && typeof props.destination_step_id === 'string') steps.add(props.destination_step_id);
  }
  return steps;
}

function finalResult(events: readonly ClientEvent[]): string | null {
  const viewed = events.filter((e) => e.name === 'result_viewed');
  const last = viewed[viewed.length - 1]?.properties?.result_id;
  return typeof last === 'string' ? last : null;
}
