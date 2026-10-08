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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The host the browser addressed. A reverse proxy passes it in `X-Forwarded-Host`, the first entry when proxies are chained. */
function requestHost(request: FastifyRequest): string | undefined {
  const forwarded = request.headers['x-forwarded-host'];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.headers.host;
  return host?.split(',', 1)[0]?.trim();
}

function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(origin);
    // Parsed with the Origin's scheme, so letter case and a default port in the host do not matter.
    return url.host === new URL(`${url.protocol}//${host}`).host;
  } catch {
    // `Origin: null` (sandboxed frames, cross-origin redirects) or a malformed header.
    return false;
  }
}

/** `Sec-Fetch-Site` when the browser sends it, else `Origin`. A request with neither does not come from a browser. */
function isCrossOrigin(request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined) return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.origin;
  return origin !== undefined && !originMatchesHost(origin, requestHost(request));
}

/**
 * Browsers attach cached Basic auth credentials to requests started by other sites, so a foreign page could make
 * an admin's browser publish or roll back a version. Browsers mark such requests with `Sec-Fetch-Site`, which page
 * scripts cannot set. Browsers without Fetch Metadata (older Safari, plain HTTP origins) still send `Origin` with
 * a POST, even from an HTML form. Non-browser clients (curl, the generator) send neither and still need the credentials.
 */
export function crossSiteGuard() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method) || !isProtectedRequest(request) || !isCrossOrigin(request)) return;
    reply
      .status(403)
      .send({ error: 'forbidden', message: 'Cross-site requests to internal endpoints are not allowed' } satisfies ApiError);
    return reply;
  };
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
