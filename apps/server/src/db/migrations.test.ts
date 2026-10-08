import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from './migrations';

describe('migrations', () => {
  it('migration 2 removes rejected-event duplicates logged by earlier builds', () => {
    const db = new Database(':memory:');
    // A database created by a build that only knew migration 1.
    migrate(db);
    db.exec('DROP INDEX idx_rejected_events_event_id; DELETE FROM schema_migrations WHERE version = 2;');
    const insert = db.prepare(
      `INSERT INTO rejected_events (event_id, session_id, reason, message, payload_json, received_at)
       VALUES (?, NULL, ?, '', '{}', '2026-10-08T12:00:00.000Z')`,
    );
    insert.run('evt-1', 'event_not_allowed');
    insert.run('evt-1', 'event_not_allowed');
    insert.run('evt-1', 'invalid_properties');
    insert.run(null, 'invalid_payload');
    insert.run(null, 'invalid_payload');

    expect(migrate(db)).toEqual([2]);
    const rows = db.prepare('SELECT event_id, reason FROM rejected_events ORDER BY id').all();
    expect(rows).toEqual([
      { event_id: 'evt-1', reason: 'event_not_allowed' },
      { event_id: 'evt-1', reason: 'invalid_properties' },
      { event_id: null, reason: 'invalid_payload' },
      { event_id: null, reason: 'invalid_payload' },
    ]);
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it('migration 3 keeps existing sessions and allows preview and demo sessions', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 2));
    db.exec(`INSERT INTO funnel_versions VALUES ('f', 1, '{}', 'sum', 'exp', NULL, '2026-10-01T00:00:00.000Z')`);
    const insert = (id: string, assignment: string) =>
      db.exec(`INSERT INTO sessions (session_id, funnel_id, funnel_version, experiment_id, variant, assignment,
                 state_json, state_rev, result_id, created_at, last_seen_at, expires_at)
               VALUES ('${id}', 'f', 1, 'exp', 'B', '${assignment}', '{}', 3, 'balanced', 't0', 't1', 't2')`);
    insert('s1', 'override');
    expect(() => insert('s2', 'preview')).toThrow(/CHECK/);

    expect(migrate(db)).toEqual([3]);
    expect(db.prepare('SELECT session_id, variant, assignment, state_rev, result_id, expires_at, demo FROM sessions').all()).toEqual([
      { session_id: 's1', variant: 'B', assignment: 'override', state_rev: 3, result_id: 'balanced', expires_at: 't2', demo: 0 },
    ]);
    insert('s2', 'preview');
    db.exec(`UPDATE sessions SET demo = 1 WHERE session_id = 's2'`);
    expect(() => insert('s3', 'forced')).toThrow(/CHECK/);
    expect(() => db.exec(`UPDATE sessions SET demo = 2`)).toThrow(/CHECK/);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' AND sql IS NOT NULL`).pluck().all();
    expect(indexes.sort()).toEqual(['idx_sessions_demo', 'idx_sessions_version']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
