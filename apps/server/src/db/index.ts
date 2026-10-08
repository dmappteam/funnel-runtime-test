import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations';

export type Db = Database.Database;

/** Opens (or creates) the database and applies pending migrations. Use ':memory:' in tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    // Some shared-hosting file systems cannot use WAL. The rollback journal still works; main.ts logs the mode in use.
  }
  const wal = db.pragma('journal_mode', { simple: true }) === 'wal';
  db.pragma(`synchronous = ${wal ? 'NORMAL' : 'FULL'}`);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
