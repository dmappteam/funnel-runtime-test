import type { FastifyInstance } from 'fastify';
import type { Db } from './db';

export interface AppOptions {
  db: Db;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Uniform random number in [0, 1) for variant assignment, injectable for tests. */
  random?: () => number;
  /** Basic auth for /admin, /dashboard, /api/admin/* and /api/analytics. Disabled when undefined. */
  adminAuth?: { user: string; password: string };
  /** Directory of the built web app (apps/web/dist). When set, the server serves it with SPA fallback. */
  webDistDir?: string;
  /** Funnel served at `/` and used when an API call omits the funnel id. */
  defaultFunnelId?: string;
  logger?: boolean;
}

/** Builds the Fastify app without listening, so tests can use `app.inject()`. Implemented by the server track. */
export async function buildApp(_options: AppOptions): Promise<FastifyInstance> {
  throw new Error('buildApp() is not implemented yet');
}
