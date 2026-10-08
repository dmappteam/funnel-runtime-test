import { PublishRequestSchema } from '@funnel/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseInput } from '../errors';
import type { VersionService } from '../services/versions';
import { FunnelParamsSchema, VersionParamsSchema } from './params';

export interface AdminRouteOptions {
  versions: VersionService;
}

const funnelIdOf = (request: FastifyRequest) => parseInput(FunnelParamsSchema, request.params, 'funnel id').funnelId;

export async function adminRoutes(app: FastifyInstance, { versions }: AdminRouteOptions): Promise<void> {
  const base = '/api/admin/funnels/:funnelId';

  app.get(base, async (request) => versions.overview(funnelIdOf(request)));

  app.get(`${base}/versions/:version`, async (request) => {
    const { funnelId, version } = parseInput(VersionParamsSchema, request.params, 'version');
    return versions.versionConfig(funnelId, version);
  });

  app.post(`${base}/validate`, async (request) => versions.validate(funnelIdOf(request), request.body));

  app.post(`${base}/versions`, async (request, reply) => {
    const response = versions.createVersion(funnelIdOf(request), request.body);
    return reply.status(response.created ? 201 : 200).send(response);
  });

  app.post(`${base}/publish`, async (request) => {
    const funnelId = funnelIdOf(request);
    const { version } = parseInput(PublishRequestSchema, request.body, 'request body');
    return versions.publish(funnelId, version);
  });

  app.post(`${base}/rollback`, async (request) => versions.rollback(funnelIdOf(request)));
}
