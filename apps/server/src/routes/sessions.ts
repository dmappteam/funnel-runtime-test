import { CreateSessionRequestSchema, ResultRequestSchema, SaveStateRequestSchema } from '@funnel/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../errors';
import type { SessionService } from '../services/sessions';
import { FunnelIdSchema, SessionParamsSchema } from './params';

const OpenQuerySchema = z.object({ funnelId: FunnelIdSchema.optional() });

export interface SessionRouteOptions {
  sessions: SessionService;
  defaultFunnelId?: string;
}

export async function sessionRoutes(app: FastifyInstance, { sessions, defaultFunnelId }: SessionRouteOptions): Promise<void> {
  app.put('/api/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = parseInput(SessionParamsSchema, request.params, 'session id');
    const funnelId = parseInput(OpenQuerySchema, request.query, 'query').funnelId ?? defaultFunnelId;
    const body = parseInput(CreateSessionRequestSchema, request.body ?? {}, 'request body');
    const response = sessions.open(sessionId, funnelId, body);
    return reply.status(response.created ? 201 : 200).send(response);
  });

  app.get('/api/sessions/:sessionId', async (request) => {
    const { sessionId } = parseInput(SessionParamsSchema, request.params, 'session id');
    return sessions.get(sessionId);
  });

  app.put('/api/sessions/:sessionId/state', async (request) => {
    const { sessionId } = parseInput(SessionParamsSchema, request.params, 'session id');
    return sessions.saveState(sessionId, parseInput(SaveStateRequestSchema, request.body, 'request body'));
  });

  app.post('/api/sessions/:sessionId/result', async (request) => {
    const { sessionId } = parseInput(SessionParamsSchema, request.params, 'session id');
    return sessions.submitResult(sessionId, parseInput(ResultRequestSchema, request.body, 'request body'));
  });
}
