import { EventBatchRequestSchema } from '@funnel/contracts';
import type { FastifyInstance } from 'fastify';
import { jsonBodyParser } from '../body';
import { parseInput } from '../errors';
import type { EventService } from '../services/events';

export interface EventRouteOptions {
  events: EventService;
}

export async function eventRoutes(app: FastifyInstance, { events }: EventRouteOptions): Promise<void> {
  // navigator.sendBeacon posts JSON as text/plain. This plugin is encapsulated, so other routes keep rejecting it.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, jsonBodyParser(app));

  app.post('/api/events', async (request) => {
    const batch = parseInput(EventBatchRequestSchema, request.body, 'event batch');
    return events.ingest(batch.events);
  });
}
