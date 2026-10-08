import type { AddDemoDataResponse } from '@funnel/contracts';
import { DEMO_FUNNEL_ID, runDemoTraffic, type Transport } from '@funnel/generator';
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors';
import type { VersionService } from './versions';

/** The generator's HTTP calls served in-process by `app.inject()`: the same routes, validation and ingestion as real traffic. */
export function injectTransport(app: FastifyInstance): Transport {
  return {
    async send(request) {
      const res = await app.inject({
        method: request.method,
        url: request.path,
        headers: { ...(request.body === undefined ? {} : { 'content-type': 'application/json' }), ...request.headers },
        payload: request.body,
      });
      return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
    },
  };
}

/** Demo traffic: sessions created by the traffic generator, flagged `demo` to tell them from real ones. */
export class DemoDataService {
  constructor(
    private readonly versions: VersionService,
    private readonly transport: Transport,
  ) {}

  async add(funnelId: string, sessions: number): Promise<AddDemoDataResponse> {
    // The virtual users answer the questions of this funnel.
    if (funnelId !== DEMO_FUNNEL_ID) throw badRequest(`Demo data can only be generated for ${DEMO_FUNNEL_ID}`);
    const active = this.versions.getActiveVersion(funnelId);
    if (active === null) throw badRequest(`Funnel ${funnelId} has no active version`);
    const run = await runDemoTraffic({ transport: this.transport, sessions });
    return { version: run.version ?? active, sessions: run.sessions, completed: run.completed, events: run.events };
  }
}
