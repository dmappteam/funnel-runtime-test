import type { FastifyInstance, FastifyRequest } from 'fastify';

type Done = (err: Error | null, body?: unknown) => void;
type StringBodyParser = (request: FastifyRequest, body: string, done: Done) => void;

/** Fastify's JSON parser (with its prototype-poisoning protection) that also accepts an empty body as `undefined`. */
export function jsonBodyParser(app: FastifyInstance): StringBodyParser {
  const parse = app.getDefaultJsonParser('error', 'error') as StringBodyParser;
  return (request, body, done) => {
    if (body.trim() === '') done(null, undefined);
    else parse(request, body, done);
  };
}
