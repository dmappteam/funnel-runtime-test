import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only list. A new event type, step type or config field needs no migration:
 * configs are stored as JSON, event names are free text and event properties are JSON.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      -- Immutable funnel versions, stored exactly as uploaded.
      CREATE TABLE funnel_versions (
        funnel_id     TEXT    NOT NULL,
        version       INTEGER NOT NULL,
        config_json   TEXT    NOT NULL,
        checksum      TEXT    NOT NULL,
        experiment_id TEXT    NOT NULL,
        release_note  TEXT,
        created_at    TEXT    NOT NULL,
        PRIMARY KEY (funnel_id, version)
      );

      -- Append-only publication log. Replaying it (publish = push, rollback = pop) gives the active version.
      CREATE TABLE funnel_releases (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        funnel_id    TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        action       TEXT    NOT NULL CHECK (action IN ('publish', 'rollback')),
        from_version INTEGER,
        created_at   TEXT    NOT NULL,
        FOREIGN KEY (funnel_id, version) REFERENCES funnel_versions (funnel_id, version)
      );

      -- Operational state. Version and variant are fixed at creation.
      CREATE TABLE sessions (
        session_id     TEXT    PRIMARY KEY,
        funnel_id      TEXT    NOT NULL,
        funnel_version INTEGER NOT NULL,
        experiment_id  TEXT    NOT NULL,
        variant        TEXT    NOT NULL,
        assignment     TEXT    NOT NULL CHECK (assignment IN ('random', 'override')),
        utm_source     TEXT,
        utm_medium     TEXT,
        utm_campaign   TEXT,
        utm_content    TEXT,
        utm_term       TEXT,
        state_json     TEXT    NOT NULL,
        state_rev      INTEGER NOT NULL DEFAULT 0,
        result_id      TEXT,
        created_at     TEXT    NOT NULL,
        last_seen_at   TEXT    NOT NULL,
        expires_at     TEXT    NOT NULL,
        completed_at   TEXT,
        FOREIGN KEY (funnel_id, funnel_version) REFERENCES funnel_versions (funnel_id, version)
      );
      CREATE INDEX idx_sessions_version ON sessions (funnel_id, funnel_version);

      -- Analytics source of truth. event_id is the idempotency key.
      -- Group attributes are copied from the session at ingestion, so rows stay self-contained.
      CREATE TABLE events (
        event_id        TEXT    PRIMARY KEY,
        session_id      TEXT    NOT NULL,
        name            TEXT    NOT NULL,
        step_id         TEXT,
        funnel_id       TEXT    NOT NULL,
        funnel_version  INTEGER NOT NULL,
        experiment_id   TEXT    NOT NULL,
        variant         TEXT    NOT NULL,
        assignment      TEXT    NOT NULL,
        utm_source      TEXT,
        utm_medium      TEXT,
        utm_campaign    TEXT,
        client_ts       TEXT,
        server_ts       TEXT    NOT NULL,
        properties_json TEXT    NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_events_group ON events (funnel_id, funnel_version, variant);
      CREATE INDEX idx_events_session ON events (session_id);
      CREATE INDEX idx_events_campaign ON events (funnel_id, utm_campaign);

      -- Dead letters: events that failed validation, kept for debugging and data-quality stats.
      CREATE TABLE rejected_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     TEXT,
        session_id   TEXT,
        reason       TEXT NOT NULL,
        message      TEXT,
        payload_json TEXT NOT NULL,
        received_at  TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'rejected_events_event_id',
    // Ingestion looks up the event id to log a re-sent invalid event once per reason.
    // Earlier builds logged every re-send, so existing duplicates are removed first (the first row per event and reason stays).
    sql: `
      DELETE FROM rejected_events
      WHERE event_id IS NOT NULL
        AND id NOT IN (SELECT MIN(id) FROM rejected_events WHERE event_id IS NOT NULL GROUP BY event_id, reason);
      CREATE INDEX idx_rejected_events_event_id ON rejected_events (event_id);
    `,
  },
];

/** Applies pending migrations in order. Returns the versions applied by this call. */
export function migrate(db: Database.Database): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]);
  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      m.version,
      m.name,
      new Date().toISOString(),
    );
  });
  const newlyApplied: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    apply(m);
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}
