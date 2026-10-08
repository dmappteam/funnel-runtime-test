import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnv } from './env';

const repo = mkdtempSync(join(tmpdir(), 'funnel-repo-'));

describe('readEnv', () => {
  it('uses repository defaults and warns that auth is off', () => {
    expect(readEnv({}, repo)).toEqual({
      port: 3000,
      host: '0.0.0.0',
      databasePath: join(repo, 'data/funnel.db'),
      seedConfig: join(repo, 'configs/funnel-v1.json'),
      adminAuth: undefined,
      webDistDir: undefined,
      defaultFunnelId: undefined,
      warnings: ['ADMIN_PASSWORD is not set: /admin, /dashboard and their APIs are public'],
    });
  });

  it('reads explicit settings', () => {
    const webDist = mkdtempSync(join(tmpdir(), 'funnel-dist-'));
    const env = readEnv(
      {
        PORT: '8080',
        HOST: '127.0.0.1',
        DATABASE_PATH: '/var/db/funnel.db',
        SEED_CONFIG: '/srv/seed.json',
        ADMIN_USER: 'ops',
        ADMIN_PASSWORD: 'pw',
        WEB_DIST: webDist,
        DEFAULT_FUNNEL_ID: 'other-funnel',
      },
      repo,
    );
    expect(env).toEqual({
      port: 8080,
      host: '127.0.0.1',
      databasePath: '/var/db/funnel.db',
      seedConfig: '/srv/seed.json',
      adminAuth: { user: 'ops', password: 'pw' },
      webDistDir: webDist,
      defaultFunnelId: 'other-funnel',
      warnings: [],
    });
  });

  it('warns about a missing WEB_DIST and rejects a bad PORT', () => {
    expect(readEnv({ ADMIN_PASSWORD: 'pw', WEB_DIST: '/nonexistent/dist' }, repo)).toMatchObject({
      adminAuth: { user: 'admin', password: 'pw' },
      webDistDir: undefined,
      warnings: ['WEB_DIST /nonexistent/dist does not exist, the web app is not served'],
    });
    expect(() => readEnv({ PORT: 'http' }, repo)).toThrow(/PORT/);
  });
});
