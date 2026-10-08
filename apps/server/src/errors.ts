import type { ApiError, ApiErrorCode } from '@funnel/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/** Thrown by services and routes. The error handler turns it into an `ApiError` body. */
export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }

  toBody(): ApiError {
    return this.details === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, details: this.details };
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiHttpError(400, 'bad_request', message, details);
export const notFound = (message: string) => new ApiHttpError(404, 'not_found', message);

/** `safeParse` that fails with 400 `bad_request` and the zod issues in `details`. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw badRequest(
    `Invalid ${what}`,
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}

/** Known errors keep their status and code. Anything unexpected becomes a 500 without internals. */
export function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiHttpError) return reply.status(error.statusCode).send(error.toBody());

  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Fastify's own client errors: malformed JSON, unsupported media type, body too large.
    const code: ApiErrorCode = status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'bad_request';
    const message = error instanceof Error ? error.message : 'Bad request';
    return reply.status(status).send({ error: code, message } satisfies ApiError);
  }

  request.log.error({ err: error }, 'request failed');
  return reply.status(500).send({ error: 'internal', message: 'Internal server error' } satisfies ApiError);
}
