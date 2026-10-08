import { randomInt } from 'node:crypto';
import type { ApiError } from '@funnel/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { basicAuth, crossSiteGuard } from './auth';
import { jsonBodyParser } from './body';
import type { Db } from './db';
import { handleError } from './errors';
import { adminRoutes } from './routes/admin';
import { analyticsRoutes } from './routes/analytics';
import { eventRoutes } from './routes/events';
import { healthRoutes } from './routes/health';
import { sessionRoutes } from './routes/sessions';
import { DemoDataService, injectTransport } from './services/demo';
import { EventService } from './services/events';
import { SessionService } from './services/sessions';
import { VersionService } from './services/versions';
import { registerWebApp, sendIndexHtml } from './static';

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

const cryptoRandom = () => randomInt(2 ** 32) / 2 ** 32;

/** Builds the Fastify app without listening, so tests can use `app.inject()`. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db, adminAuth, webDistDir, defaultFunnelId } = options;
  const now = options.now ?? (() => new Date());
  const versions = new VersionService(db, now);
  const sessions = new SessionService(db, versions, now, options.random ?? cryptoRandom);
  const events = new EventService(db, sessions, now);

  const app = Fastify({ logger: options.logger ?? false });
  const demo = new DemoDataService(db, versions, injectTransport(app));
  // Registered before the routes, so every route plugin inherits them.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, jsonBodyParser(app));
  app.setErrorHandler(handleError);
  if (adminAuth) app.addHook('onRequest', basicAuth(adminAuth));
  app.addHook('onRequest', crossSiteGuard());

  await app.register(healthRoutes);
  await app.register(sessionRoutes, { sessions, defaultFunnelId });
  await app.register(eventRoutes, { events });
  await app.register(adminRoutes, { versions, sessions, demo });
  await app.register(analyticsRoutes, { db, versions, now, defaultFunnelId });
  if (webDistDir) await registerWebApp(app, webDistDir);

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '';
    const isApi = path === '/api' || path.startsWith('/api/');
    if (webDistDir && !isApi && (request.method === 'GET' || request.method === 'HEAD')) return sendIndexHtml(reply);
    return reply.status(404).send({ error: 'not_found', message: `Route ${request.method} ${path} not found` } satisfies ApiError);
  });

  return app;
}
