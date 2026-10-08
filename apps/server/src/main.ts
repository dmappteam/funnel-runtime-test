// Entry point: reads env, opens the DB, seeds the first version, purges expired answers hourly and listens.
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDb } from './db';
import { readEnv } from './env';
import { purgeExpiredState } from './services/sessions';
import { seedFromFile } from './services/versions';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
// The same relative path works for src/main.ts under tsx and for dist/main.js built by build.mjs.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const env = readEnv(process.env, REPO_ROOT);
  const db = openDb(env.databasePath);
  const seed = seedFromFile(db, env.seedConfig);
  const app = await buildApp({
    db,
    adminAuth: env.adminAuth,
    webDistDir: env.webDistDir,
    defaultFunnelId: env.defaultFunnelId ?? seed.funnelId,
    logger: true,
  });

  const journalMode = db.pragma('journal_mode', { simple: true });
  if (journalMode !== 'wal') app.log.warn({ journalMode }, 'SQLite WAL is not available, using the default rollback journal');
  for (const warning of env.warnings) app.log.warn(warning);
  app.log.info(seed, seed.seeded ? 'seed config stored and published' : 'seed skipped, the funnel already has versions');

  const purge = () => {
    try {
      const purged = purgeExpiredState(db, new Date());
      if (purged > 0) app.log.info({ purged }, 'removed answers of expired sessions');
    } catch (err) {
      app.log.error({ err }, 'purging expired sessions failed');
    }
  };
  purge();
  const purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(purgeTimer);
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    app.close().then(
      () => {
        db.close();
        process.exit(0);
      },
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ port: env.port, host: env.host });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
