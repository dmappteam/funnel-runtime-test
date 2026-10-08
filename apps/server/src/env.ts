import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Credentials } from './auth';

export interface ServerEnv {
  port: number;
  host: string;
  databasePath: string;
  seedConfig: string;
  adminAuth: Credentials | undefined;
  webDistDir: string | undefined;
  /** When unset, main.ts uses the funnel of the seed config. */
  defaultFunnelId: string | undefined;
  /** Logged by main.ts once the logger exists. */
  warnings: string[];
}

/** Reads the server settings from environment variables. Relative paths resolve against the working directory. */
export function readEnv(env: NodeJS.ProcessEnv, repoRoot: string): ServerEnv {
  const warnings: string[] = [];

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got "${env.PORT}"`);
  }

  const adminAuth = env.ADMIN_PASSWORD ? { user: env.ADMIN_USER || 'admin', password: env.ADMIN_PASSWORD } : undefined;
  if (!adminAuth) warnings.push('ADMIN_PASSWORD is not set: /admin, /dashboard and their APIs are public');

  let webDistDir: string | undefined = resolve(env.WEB_DIST || join(repoRoot, 'apps/web/dist'));
  if (!existsSync(webDistDir)) {
    if (env.WEB_DIST) warnings.push(`WEB_DIST ${webDistDir} does not exist, the web app is not served`);
    webDistDir = undefined;
  }

  const databasePath = env.DATABASE_PATH || join(repoRoot, 'data/funnel.db');
  return {
    port,
    host: env.HOST || '0.0.0.0',
    databasePath: databasePath === ':memory:' ? databasePath : resolve(databasePath),
    seedConfig: resolve(env.SEED_CONFIG || join(repoRoot, 'configs/funnel-v1.json')),
    adminAuth,
    webDistDir,
    defaultFunnelId: env.DEFAULT_FUNNEL_ID || undefined,
    warnings,
  };
}
