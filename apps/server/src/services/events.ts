import {
  ClientEventSchema,
  EVENT_PROPERTY_SCHEMAS,
  GenericPropertySchema,
  SERVER_ONLY_EVENTS,
  type EventBatchResponse,
  type EventResult,
  type ParsedClientEvent,
  type RejectReason,
} from '@funnel/contracts';
import type { EventDef, ResolvedFunnel } from '@funnel/engine';
import type { Db } from '../db';
import { isExpired, type SessionRow, type SessionService } from './sessions';

const MAX_REJECTED_PAYLOAD = 10 * 1024;

interface SessionContext {
  row: SessionRow;
  funnel: ResolvedFunnel;
  sequence: ReadonlySet<string>;
  allowed: ReadonlyMap<string, EventDef>;
}

type Check =
  | { ok: true; event: ParsedClientEvent; stepId: string; session: SessionContext; properties: Record<string, unknown> }
  | { ok: false; reason: RejectReason; message: string };

const reject = (reason: RejectReason, message: string): Check => ({ ok: false, reason, message });

function stringField(item: unknown, key: string): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const value = (item as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function prepareStatements(db: Db) {
  return {
    insert: db.prepare<[string, string, string, string, string, number, string, string, string, string | null, string | null, string | null, string, string, string]>(
      `INSERT INTO events (event_id, session_id, name, step_id, funnel_id, funnel_version, experiment_id, variant,
         assignment, utm_source, utm_medium, utm_campaign, client_ts, server_ts, properties_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    ),
    insertRejected: db.prepare<[string | null, string | null, RejectReason, string, string, string]>(
      `INSERT INTO rejected_events (event_id, session_id, reason, message, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  };
}

/** Idempotent ingestion of client events. Every event of a batch is validated on its own. */
export class EventService {
  private readonly db: Db;
  private readonly sessions: SessionService;
  private readonly now: () => Date;
  private readonly stmt: ReturnType<typeof prepareStatements>;

  constructor(db: Db, sessions: SessionService, now: () => Date) {
    this.db = db;
    this.sessions = sessions;
    this.now = now;
    this.stmt = prepareStatements(db);
  }

  ingest(items: readonly unknown[]): EventBatchResponse {
    return this.db
      .transaction((): EventBatchResponse => {
        const now = this.now();
        const serverTs = now.toISOString();
        const contexts = new Map<string, SessionContext | null>();
        const active = new Map<string, SessionRow>();
        const response: EventBatchResponse = { accepted: 0, duplicates: 0, rejected: 0, results: [] };

        items.forEach((item, index) => {
          const check = this.check(item, contexts);
          if (!check.ok) {
            const eventId = stringField(item, 'event_id');
            const payload = JSON.stringify(item) ?? 'null';
            this.stmt.insertRejected.run(
              eventId?.slice(0, 128) ?? null,
              stringField(item, 'session_id')?.slice(0, 128) ?? null,
              check.reason,
              check.message,
              payload.slice(0, MAX_REJECTED_PAYLOAD),
              serverTs,
            );
            response.rejected += 1;
            response.results.push({ index, event_id: eventId, status: 'rejected', reason: check.reason, message: check.message });
            return;
          }

          const { event, stepId, session, properties } = check;
          // Group attributes come from the session row, never from the payload.
          const { changes } = this.stmt.insert.run(
            event.event_id,
            event.session_id,
            event.name,
            stepId,
            session.row.funnel_id,
            session.row.funnel_version,
            session.row.experiment_id,
            session.row.variant,
            session.row.assignment,
            session.row.utm_source,
            session.row.utm_medium,
            session.row.utm_campaign,
            new Date(event.client_ts).toISOString(),
            serverTs,
            JSON.stringify(properties),
          );
          const status: EventResult['status'] = changes === 1 ? 'accepted' : 'duplicate';
          if (status === 'accepted') {
            response.accepted += 1;
            if (!isExpired(session.row, now)) active.set(session.row.session_id, session.row);
          } else {
            response.duplicates += 1;
          }
          response.results.push({ index, event_id: event.event_id, status });
        });

        for (const row of active.values()) this.sessions.extend(row, now);
        return response;
      })
      .immediate();
  }

  /** The checks run in this order and the first failure is the reason. */
  private check(item: unknown, contexts: Map<string, SessionContext | null>): Check {
    const parsed = ClientEventSchema.safeParse(item);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
      return reject('invalid_payload', message.slice(0, 500));
    }
    const event = parsed.data;
    if (SERVER_ONLY_EVENTS.includes(event.name)) return reject('server_only_event', `"${event.name}" is sent by the server only`);

    const session = this.context(event.session_id, contexts);
    if (!session) return reject('unknown_session', `Session ${event.session_id} does not exist`);
    const { funnel } = session;
    const label = `${funnel.funnelId} v${funnel.version} variant ${funnel.variant}`;

    const def = session.allowed.get(event.name);
    if (!def) return reject('event_not_allowed', `"${event.name}" is not an allowed event of ${funnel.funnelId} v${funnel.version}`);
    const stepId = event.step_id;
    if (stepId === null) return reject('unknown_step', 'step_id is required');
    if (!session.sequence.has(stepId)) return reject('unknown_step', `Step "${stepId}" is not part of ${label}`);

    // Only properties declared for the event are kept. Everything else, raw answers included, is dropped silently.
    const properties: Record<string, unknown> = {};
    for (const key of def.properties) {
      if (!Object.hasOwn(event.properties, key)) continue;
      const schema = Object.hasOwn(EVENT_PROPERTY_SCHEMAS, key) ? EVENT_PROPERTY_SCHEMAS[key] : GenericPropertySchema;
      const value = schema.safeParse(event.properties[key]);
      if (!value.success) return reject('invalid_properties', `Property "${key}": ${value.error.issues[0]?.message ?? 'invalid value'}`);
      properties[key] = value.data;
    }
    for (const key of ['destination_step_id', 'next_step_id']) {
      const stepId = properties[key];
      if (typeof stepId === 'string' && !session.sequence.has(stepId)) {
        return reject('unknown_step', `Property "${key}": step "${stepId}" is not part of ${label}`);
      }
    }
    const resultId = properties.result_id;
    if (typeof resultId === 'string' && !Object.hasOwn(funnel.results, resultId)) {
      return reject('invalid_properties', `Property "result_id": "${resultId}" is not a result of ${funnel.funnelId} v${funnel.version}`);
    }
    return { ok: true, event, stepId, session, properties };
  }

  private context(sessionId: string, contexts: Map<string, SessionContext | null>): SessionContext | null {
    let context = contexts.get(sessionId);
    if (context === undefined) {
      const row = this.sessions.findRow(sessionId);
      if (row) {
        const funnel = this.sessions.funnelOf(row);
        context = {
          row,
          funnel,
          sequence: new Set(funnel.sequence),
          allowed: new Map(funnel.events.allowed.map((def) => [def.name, def])),
        };
      } else {
        context = null;
      }
      contexts.set(sessionId, context);
    }
    return context;
  }
}
