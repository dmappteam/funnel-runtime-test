import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiError } from '@funnel/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface Credentials {
  user: string;
  password: string;
}

export const AUTH_CHALLENGE = 'Basic realm="Funnel internal", charset="UTF-8"';

const PROTECTED_PREFIXES = ['/admin', '/dashboard', '/api/admin', '/api/analytics'];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * The router matches percent-decoded paths, so the raw URL alone is not enough:
 * `/api/%61dmin/...` must not slip past the prefix check.
 */
function isProtectedRequest(request: FastifyRequest): boolean {
  const path = request.url.split('?', 1)[0] ?? '';
  return isProtectedPath(path) || isProtectedPath(decodePath(path)) || isProtectedPath(request.routeOptions.url ?? '');
}

/** Compares SHA-256 digests, so the comparison takes the same time whatever the input length. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function checkBasicAuth(header: string | undefined, expected: Credentials): boolean {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const userOk = safeEqual(decoded.slice(0, colon), expected.user);
  const passwordOk = safeEqual(decoded.slice(colon + 1), expected.password);
  return userOk && passwordOk;
}

/** `onRequest` hook protecting the admin and dashboard pages and their APIs. Everything else stays public. */
export function basicAuth(expected: Credentials) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isProtectedRequest(request) || checkBasicAuth(request.headers.authorization, expected)) return;
    reply
      .status(401)
      .header('www-authenticate', AUTH_CHALLENGE)
      .send({ error: 'unauthorized', message: 'Authentication required' } satisfies ApiError);
    return reply;
  };
}
