import { AnalyticsQuerySchema } from '@funnel/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db';
import { badRequest, parseInput } from '../errors';
import { buildAnalytics } from '../services/analytics';
import type { VersionService } from '../services/versions';

export interface AnalyticsRouteOptions {
  db: Db;
  versions: VersionService;
  now: () => Date;
  defaultFunnelId?: string;
}

export async function analyticsRoutes(app: FastifyInstance, options: AnalyticsRouteOptions): Promise<void> {
  const { db, versions, now, defaultFunnelId } = options;

  app.get('/api/analytics', async (request) => {
    const query = parseInput(AnalyticsQuerySchema, request.query, 'query');
    const funnelId = query.funnelId ?? defaultFunnelId;
    if (!funnelId) throw badRequest('funnelId is required');
    const filters = {
      funnelId,
      version: query.version ?? null,
      campaign: query.campaign ?? null,
      includeOverrides: query.includeOverrides,
    };
    return buildAnalytics(db, versions, filters, now());
  });
}
