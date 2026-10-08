export interface HttpRequest {
  method: 'GET' | 'PUT' | 'POST';
  /** Path and query, e.g. `/api/analytics?version=2`. */
  path: string;
  headers?: Record<string, string>;
  /** Serialized JSON. A string, so retries and deliberate re-sends carry byte-identical payloads. */
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON, `null` for an empty or non-JSON body. */
  body: unknown;
}

/** One HTTP exchange. Throws `NetworkError` when no response arrives. */
export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export class NetworkError extends Error {}

export class FetchTransport implements Transport {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    try {
      const res = await fetch(this.baseUrl + request.path, {
        method: request.method,
        headers: { ...(request.body === undefined ? {} : { 'content-type': 'application/json' }), ...request.headers },
        body: request.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { status: res.status, body: parseJson(await res.text()) };
    } catch (err) {
      throw new NetworkError(describeFetchError(err));
    }
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `fetch failed` hides the useful part (e.g. `connect ECONNREFUSED 127.0.0.1:3000`) in `cause`. */
function describeFetchError(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof AggregateError) {
    return cause.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join('; ');
  }
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}
