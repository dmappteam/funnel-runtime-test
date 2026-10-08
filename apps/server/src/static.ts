import { relative, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Serves the built web app. Unknown non-API paths fall back to index.html in the 404 handler (app.ts). */
export async function registerWebApp(app: FastifyInstance, dir: string): Promise<void> {
  const root = resolve(dir);
  await app.register(fastifyStatic, {
    root,
    // Set per file below: hashed bundles under /assets/ never change, everything else is revalidated.
    cacheControl: false,
    setHeaders(reply, filePath) {
      const isAsset = relative(root, filePath).split(sep)[0] === 'assets';
      reply.header('cache-control', isAsset ? IMMUTABLE : 'no-cache');
    },
  });
}

export function sendIndexHtml(reply: FastifyReply): FastifyReply {
  return reply.sendFile('index.html');
}
