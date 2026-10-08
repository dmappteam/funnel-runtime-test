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
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2]);
  });
});
