import {
  AddDemoDataRequestSchema,
  CreatePreviewRequestSchema,
  PublishRequestSchema,
  type CreatePreviewResponse,
} from '@funnel/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseInput } from '../errors';
import type { DemoDataService } from '../services/demo';
import type { SessionService } from '../services/sessions';
import type { VersionService } from '../services/versions';
import { FunnelParamsSchema, VersionParamsSchema } from './params';

export interface AdminRouteOptions {
  versions: VersionService;
  sessions: SessionService;
  demo: DemoDataService;
}

const funnelIdOf = (request: FastifyRequest) => parseInput(FunnelParamsSchema, request.params, 'funnel id').funnelId;

export async function adminRoutes(app: FastifyInstance, { versions, sessions, demo }: AdminRouteOptions): Promise<void> {
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

  app.post(`${base}/previews`, async (request, reply) => {
    const funnelId = funnelIdOf(request);
    const { version, variant } = parseInput(CreatePreviewRequestSchema, request.body, 'request body');
    const { session } = sessions.openPreview(funnelId, version, variant);
    return reply.status(201).send({ session } satisfies CreatePreviewResponse);
  });

  app.post(`${base}/demo-data`, async (request) => {
    const funnelId = funnelIdOf(request);
    const body = parseInput(AddDemoDataRequestSchema, request.body ?? {}, 'request body');
    return demo.add(funnelId, body.sessions);
  });

  app.delete(`${base}/demo-data`, async (request) => demo.remove(funnelIdOf(request)));
}
