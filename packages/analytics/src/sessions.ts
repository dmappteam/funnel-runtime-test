import type { AnalyticsEventRow, Assignment } from '@funnel/contracts';
import { compare, groupBy } from './util';

/** Everything the report needs from one session. Built from sets, maxima and minima, so arrival order never matters. */
export interface SessionSummary {
  sessionId: string;
  version: number;
  variant: string;
  experimentId: string;
  campaign: string | null;
  assignment: Assignment;
  events: number;
  eventCounts: Map<string, number>;
  /** Steps entered: any event's step_id, a step_completed's next_step_id, a back_clicked's destination_step_id. */
  steps: Set<string>;
  resultViewed: boolean;
  ctaClicked: boolean;
  backClicked: boolean;
  /** result_id of the latest result_viewed. */
  finalResultId: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** Keeps the first occurrence of every event_id. */
export function dedupeEvents(events: readonly AnalyticsEventRow[]): AnalyticsEventRow[] {
  const seen = new Set<string>();
  const out: AnalyticsEventRow[] = [];
  for (const e of events) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    out.push(e);
  }
  return out;
}

function parseTs(ts: string | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** Timestamps are parsed because client times may carry an offset, which breaks string comparison. */
export function compareTimestamps(a: string, b: string): number {
  return compare(parseTs(a) ?? -Infinity, parseTs(b) ?? -Infinity) || compare(a, b);
}

/** Client time (server time when missing or unparseable), then server time, then event_id. */
function compareEventTime(a: AnalyticsEventRow, b: AnalyticsEventRow): number {
  const time = (e: AnalyticsEventRow) => parseTs(e.client_ts) ?? parseTs(e.server_ts) ?? -Infinity;
  return compare(time(a), time(b)) || compareTimestamps(a.server_ts, b.server_ts) || compare(a.event_id, b.event_id);
}

/** The event whose group attributes a session takes: its session_started, otherwise the smallest event_id. */
function isBetterAnchor(candidate: AnalyticsEventRow, current: AnalyticsEventRow): boolean {
  const a = candidate.name === 'session_started';
  const b = current.name === 'session_started';
  return a !== b ? a : candidate.event_id < current.event_id;
}

function summarize(events: AnalyticsEventRow[]): SessionSummary {
  let anchor = events[0]!;
  let firstSeen = anchor.server_ts;
  let lastSeen = anchor.server_ts;
  let latestResult: { event: AnalyticsEventRow; resultId: string } | null = null;
  let resultViewed = false;
  let ctaClicked = false;
  let backClicked = false;
  const eventCounts = new Map<string, number>();
  const steps = new Set<string>();

  for (const e of events) {
    if (isBetterAnchor(e, anchor)) anchor = e;
    if (compareTimestamps(e.server_ts, firstSeen) < 0) firstSeen = e.server_ts;
    if (compareTimestamps(e.server_ts, lastSeen) > 0) lastSeen = e.server_ts;
    eventCounts.set(e.name, (eventCounts.get(e.name) ?? 0) + 1);
    if (e.step_id) steps.add(e.step_id);

    const props = e.properties ?? {};
    switch (e.name) {
      case 'step_completed':
        if (typeof props.next_step_id === 'string') steps.add(props.next_step_id);
        break;
      case 'back_clicked':
        backClicked = true;
        if (typeof props.destination_step_id === 'string') steps.add(props.destination_step_id);
        break;
      case 'result_viewed':
        resultViewed = true;
        if (typeof props.result_id === 'string' && (!latestResult || compareEventTime(e, latestResult.event) > 0)) {
          latestResult = { event: e, resultId: props.result_id };
        }
        break;
      case 'cta_clicked':
        ctaClicked = true;
        break;
    }
  }

  return {
    sessionId: anchor.session_id,
    version: anchor.funnel_version,
    variant: anchor.variant,
    experimentId: anchor.experiment_id,
    campaign: anchor.utm_campaign,
    assignment: anchor.assignment,
    events: events.length,
    eventCounts,
    steps,
    resultViewed,
    ctaClicked,
    backClicked,
    finalResultId: latestResult?.resultId ?? null,
    firstSeen,
    lastSeen,
  };
}

/** One summary per session, sorted by session id. Expects deduplicated events. */
export function summarizeSessions(events: readonly AnalyticsEventRow[]): SessionSummary[] {
  return [...groupBy(events, (e) => e.session_id).values()]
    .map(summarize)
    .sort((a, b) => compare(a.sessionId, b.sessionId));
}

/** A cta_clicked also proves the result was shown, even if its result_viewed was lost. */
export function reachedResult(s: SessionSummary): boolean {
  return s.resultViewed || s.ctaClicked;
}
