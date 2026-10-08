import type { ClientEvent, EventBatchResponse, EventStatus } from '@funnel/contracts';

interface Tracked {
  event: ClientEvent;
  /** `false` for the deliberately broken events. */
  valid: boolean;
  /** Sends that got a status back. */
  sends: number;
  statuses: EventStatus[];
  /** An attempt before the first status got no answer, so the server may already have stored the event. */
  uncertain: boolean;
}

export interface IngestionTotals {
  uniqueValid: number;
  /** Extra sends of valid events (re-sent batches). The server must answer `duplicate`. */
  resentValid: number;
  invalidEvents: number;
  invalidSends: number;
  /** Valid events whose first answered send followed an unanswered attempt. */
  uncertain: number;
}

export interface IngestionCheck {
  name: string;
  expected: string;
  actual: number;
  ok: boolean;
}

/** Every event the generator sent and every status the server returned, for the exactly-once checks. */
export class IngestionLog {
  private readonly tracked = new Map<string, Tracked>();
  readonly batches = { sent: 0, resent: 0, shuffled: 0, heldBack: 0, retried: 0 };
  readonly responses: Record<EventStatus, number> = { accepted: 0, duplicate: 0, rejected: 0 };
  readonly rejectedByReason: Record<string, number> = {};
  /** First few unexpected statuses, for diagnostics. */
  readonly anomalies: string[] = [];

  add(event: ClientEvent, valid: boolean): void {
    this.tracked.set(event.event_id, { event, valid, sends: 0, statuses: [], uncertain: false });
  }

  isValid(eventId: string): boolean {
    return this.tracked.get(eventId)?.valid ?? false;
  }

  statusesOf(eventId: string): EventStatus[] {
    return this.tracked.get(eventId)?.statuses ?? [];
  }

  record(events: readonly ClientEvent[], response: EventBatchResponse, attempts: number): void {
    this.batches.sent++;
    if (attempts > 1) this.batches.retried++;
    const byIndex = new Map(response.results.map((r) => [r.index, r]));
    events.forEach((event, index) => {
      const tracked = this.tracked.get(event.event_id);
      const result = byIndex.get(index);
      if (!tracked) return;
      if (attempts > 1 && tracked.statuses.length === 0) tracked.uncertain = true;
      if (!result) {
        this.note(`no status for ${event.name} ${event.event_id}`);
        return;
      }
      tracked.sends++;
      tracked.statuses.push(result.status);
      this.responses[result.status]++;
      if (result.status === 'rejected') {
        const reason = result.reason ?? 'unknown';
        this.rejectedByReason[reason] = (this.rejectedByReason[reason] ?? 0) + 1;
      }
      if (!expected(tracked, result.status)) {
        const why = result.reason ? ` ${result.reason}${result.message ? `: ${result.message}` : ''}` : '';
        this.note(`${tracked.valid ? 'valid' : 'invalid'} ${event.name} on ${event.step_id ?? '-'} → ${result.status}${why}`);
      }
    });
  }

  totals(): IngestionTotals {
    const all = [...this.tracked.values()];
    const valid = all.filter((t) => t.valid);
    const invalid = all.filter((t) => !t.valid);
    return {
      uniqueValid: valid.length,
      resentValid: valid.reduce((sum, t) => sum + Math.max(0, t.sends - 1), 0),
      invalidEvents: invalid.length,
      invalidSends: invalid.reduce((sum, t) => sum + t.sends, 0),
      uncertain: valid.filter((t) => t.uncertain).length,
    };
  }

  /** accepted = unique valid events, duplicate = re-sends of them, rejected = sends of the broken ones. */
  checks(): IngestionCheck[] {
    const t = this.totals();
    const { accepted, duplicate, rejected } = this.responses;
    const range = (n: number) => (t.uncertain > 0 ? `${n - t.uncertain}..${n}` : String(n));
    const within = (actual: number, n: number) => actual <= n && actual >= n - t.uncertain;
    return [
      { name: 'accepted = unique valid events', expected: range(t.uniqueValid), actual: accepted, ok: within(accepted, t.uniqueValid) },
      {
        name: 'duplicate = re-sent valid events',
        expected: t.uncertain > 0 ? `${t.resentValid}..${t.resentValid + t.uncertain}` : String(t.resentValid),
        actual: duplicate,
        ok: duplicate >= t.resentValid && duplicate <= t.resentValid + t.uncertain,
      },
      { name: 'rejected = invalid event sends', expected: String(t.invalidSends), actual: rejected, ok: rejected === t.invalidSends },
      { name: 'unexpected statuses', expected: '0', actual: this.anomalyCount, ok: this.anomalyCount === 0 },
    ];
  }

  private anomalyCount = 0;

  private note(message: string): void {
    this.anomalyCount++;
    if (this.anomalies.length < 10) this.anomalies.push(message);
  }
}

/** First answered send of a valid event is accepted (or duplicate after a lost attempt), later ones are duplicates. */
function expected(tracked: Tracked, status: EventStatus): boolean {
  if (!tracked.valid) return status === 'rejected';
  const first = tracked.statuses.length === 1;
  if (status === 'accepted') return first;
  return status === 'duplicate' && (!first || tracked.uncertain);
}
