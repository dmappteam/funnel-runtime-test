import type { ClientEvent } from '@funnel/contracts';
import type { ApiClient } from './api';
import type { IngestionLog } from './ingestion';
import type { Rng } from './random';

export interface ChaosRates {
  minBatch: number;
  maxBatch: number;
  /** Batch sent a second time with the identical payload, as after a client timeout. */
  resend: number;
  /** Events of a batch sent in random order. */
  shuffle: number;
  /** Batch held back and sent after the next one. */
  holdBack: number;
  /** Extra broken event mixed in after a valid one; the server must reject it. */
  invalid: number;
}

export const DEFAULT_CHAOS: ChaosRates = { minBatch: 3, maxBatch: 10, resend: 0.08, shuffle: 0.05, holdBack: 0.06, invalid: 0.01 };
export const NO_CHAOS: ChaosRates = { minBatch: 3, maxBatch: 10, resend: 0, shuffle: 0, holdBack: 0, invalid: 0 };

/** An event name no version allows. */
export const UNKNOWN_EVENT_NAME = 'tooltip_opened';

/** A broken copy of `event` under a new id: either an unknown event name or a whitelisted property of the wrong type. */
export function corruptEvent(event: ClientEvent, eventId: string, rng: Rng): ClientEvent {
  const properties = { ...event.properties };
  const key = Object.keys(properties)[0];
  if (key === undefined || rng.chance(0.5)) return { ...event, event_id: eventId, name: UNKNOWN_EVENT_NAME };
  properties[key] = typeof properties[key] === 'number' ? 'not-a-number' : 42;
  return { ...event, event_id: eventId, properties };
}

/** One session's event queue. Sends batches in the session's order, like a browser outbox, plus the configured transport chaos. */
export class Outbox {
  private queue: ClientEvent[] = [];
  private held: ClientEvent[] | null = null;
  private size: number;

  constructor(
    private readonly api: ApiClient,
    private readonly log: IngestionLog,
    private readonly rng: Rng,
    private readonly chaos: ChaosRates,
    private readonly newId: () => string,
  ) {
    this.size = this.drawSize();
  }

  push(event: ClientEvent): void {
    this.queue.push(event);
    this.log.add(event, true);
    if (this.rng.chance(this.chaos.invalid)) {
      const broken = corruptEvent(event, this.newId(), this.rng);
      this.queue.push(broken);
      this.log.add(broken, false);
    }
  }

  /** Sends every full batch. */
  async pump(): Promise<void> {
    while (this.queue.length >= this.size) {
      await this.dispatch(this.queue.splice(0, this.size), true);
      this.size = this.drawSize();
    }
  }

  /** Sends everything, a held-back batch last (page hide or end of the visit). */
  async flush(): Promise<void> {
    await this.pump();
    if (this.queue.length > 0) await this.dispatch(this.queue.splice(0), false);
    if (this.held) await this.sendHeld();
  }

  private async dispatch(events: ClientEvent[], canHold: boolean): Promise<void> {
    let batch = events;
    if (batch.length > 1 && this.rng.chance(this.chaos.shuffle)) {
      batch = this.rng.shuffle(batch);
      this.log.batches.shuffled++;
    }
    if (canHold && !this.held && this.rng.chance(this.chaos.holdBack)) {
      this.held = batch;
      this.log.batches.heldBack++;
      return;
    }
    await this.send(batch);
    if (this.held) await this.sendHeld();
  }

  private async sendHeld(): Promise<void> {
    const held = this.held!;
    this.held = null;
    await this.send(held);
  }

  private async send(events: ClientEvent[]): Promise<void> {
    const payload = JSON.stringify({ events });
    const first = await this.api.sendEvents(payload);
    this.log.record(events, first.body, first.attempts);
    if (this.rng.chance(this.chaos.resend)) {
      const again = await this.api.sendEvents(payload);
      this.log.record(events, again.body, again.attempts);
      this.log.batches.resent++;
    }
  }

  private drawSize(): number {
    return this.rng.int(this.chaos.minBatch, this.chaos.maxBatch);
  }
}
