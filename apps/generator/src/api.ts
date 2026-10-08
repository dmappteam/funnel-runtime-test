import type {
  AnalyticsResponse,
  ApiError,
  CreateSessionRequest,
  CreateVersionResponse,
  EventBatchResponse,
  FunnelAdminResponse,
  PublishResponse,
  ResultRequest,
  ResultResponse,
  RollbackResponse,
  SaveStateRequest,
  SaveStateResponse,
  SessionResponse,
  SessionState,
} from '@funnel/contracts';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from './transport';

export const FUNNEL_ID = 'workstyle-planner';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
    what: string,
  ) {
    const code = body?.error ? ` ${body.error}` : '';
    const message = body?.message ? ` (${body.message})` : '';
    super(`${what}: HTTP ${status}${code}${message}`);
  }
}

/** No HTTP answer even after retries: the run cannot continue. */
export class UnreachableError extends Error {}

export interface AdminCredentials {
  user: string;
  password: string;
}

export interface ApiClientOptions {
  admin?: AdminCredentials;
  /** Retries after a network error or a 5xx, with exponential backoff. */
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Shown in the unreachable message. */
  baseUrl?: string;
}

export interface Sent<T> {
  status: number;
  body: T;
  /** More than 1 means earlier attempts got no usable answer, so the server may have processed them. */
  attempts: number;
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Typed client of the Funnel Runtime HTTP API. Retries reuse the exact request, payload included. */
export class ApiClient {
  readonly stats = { requests: 0, retries: 0 };

  constructor(
    private readonly transport: Transport,
    private readonly options: ApiClientOptions = {},
  ) {}

  get hasAdmin(): boolean {
    return this.options.admin !== undefined;
  }

  /** One attempt without retries: any HTTP answer means the server is up. */
  async ping(): Promise<void> {
    try {
      await this.transport.send({ method: 'GET', path: '/api/sessions/00000000-0000-4000-8000-000000000000' });
    } catch (err) {
      if (err instanceof NetworkError) throw this.unreachable(err);
      throw err;
    }
  }

  async createSession(sessionId: string, body: CreateSessionRequest): Promise<SessionResponse> {
    return (await this.request<SessionResponse>('PUT', `/api/sessions/${sessionId}`, body, 'PUT /api/sessions/:id')).body;
  }

  async getSession(sessionId: string): Promise<SessionResponse> {
    return (await this.request<SessionResponse>('GET', `/api/sessions/${sessionId}`, undefined, 'GET /api/sessions/:id')).body;
  }

  async saveState(sessionId: string, body: SaveStateRequest): Promise<SaveStateResponse> {
    const what = 'PUT /api/sessions/:id/state';
    return (await this.request<SaveStateResponse>('PUT', `/api/sessions/${sessionId}/state`, body, what)).body;
  }

  async submitResult(sessionId: string, body: ResultRequest): Promise<ResultResponse> {
    const what = 'POST /api/sessions/:id/result';
    return (await this.request<ResultResponse>('POST', `/api/sessions/${sessionId}/result`, body, what)).body;
  }

  /** `payload` is the serialized `{ events }` body, so a deliberate re-send is byte-identical. */
  sendEvents(payload: string): Promise<Sent<EventBatchResponse>> {
    return this.request<EventBatchResponse>('POST', '/api/events', payload, 'POST /api/events');
  }

  async getFunnel(funnelId: string): Promise<FunnelAdminResponse> {
    const what = 'GET /api/admin/funnels/:id';
    return (await this.request<FunnelAdminResponse>('GET', `/api/admin/funnels/${funnelId}`, undefined, what, true)).body;
  }

  /** `rawConfig` is the config file as is. 201 created, 200 identical config already stored. */
  createVersion(funnelId: string, rawConfig: string): Promise<Sent<CreateVersionResponse>> {
    const what = 'POST /api/admin/funnels/:id/versions';
    return this.request<CreateVersionResponse>('POST', `/api/admin/funnels/${funnelId}/versions`, rawConfig, what, true);
  }

  async publish(funnelId: string, version: number): Promise<PublishResponse> {
    const what = 'POST /api/admin/funnels/:id/publish';
    return (await this.request<PublishResponse>('POST', `/api/admin/funnels/${funnelId}/publish`, { version }, what, true)).body;
  }

  async rollback(funnelId: string): Promise<RollbackResponse> {
    const what = 'POST /api/admin/funnels/:id/rollback';
    return (await this.request<RollbackResponse>('POST', `/api/admin/funnels/${funnelId}/rollback`, {}, what, true)).body;
  }

  async analytics(funnelId: string, version: number): Promise<AnalyticsResponse> {
    const query = new URLSearchParams({ funnelId, version: String(version), includeOverrides: 'false' });
    return (await this.request<AnalyticsResponse>('GET', `/api/analytics?${query}`, undefined, 'GET /api/analytics', true)).body;
  }

  private async request<T>(
    method: HttpRequest['method'],
    path: string,
    body: unknown,
    what: string,
    admin = false,
  ): Promise<Sent<T>> {
    const request: HttpRequest = {
      method,
      path,
      headers: admin ? this.authHeader() : undefined,
      body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
    };
    const { response, attempts } = await this.withRetries(request);
    if (response.status >= 200 && response.status < 300) return { status: response.status, body: response.body as T, attempts };
    throw new HttpError(response.status, asApiError(response.body), what);
  }

  private authHeader(): Record<string, string> {
    const admin = this.options.admin;
    if (!admin) throw new Error('Admin credentials are required: --admin-user/--admin-password or ADMIN_USER/ADMIN_PASSWORD');
    return { authorization: `Basic ${Buffer.from(`${admin.user}:${admin.password}`).toString('base64')}` };
  }

  private async withRetries(request: HttpRequest): Promise<{ response: HttpResponse; attempts: number }> {
    const retries = this.options.retries ?? 4;
    const backoffMs = this.options.backoffMs ?? 250;
    const sleep = this.options.sleep ?? delay;
    for (let attempt = 1; ; attempt++) {
      this.stats.requests++;
      try {
        const response = await this.transport.send(request);
        if (response.status < 500 || attempt > retries) return { response, attempts: attempt };
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
        if (attempt > retries) throw this.unreachable(err);
      }
      this.stats.retries++;
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }

  private unreachable(err: NetworkError): UnreachableError {
    const url = this.options.baseUrl ?? 'the server';
    return new UnreachableError(
      `Cannot reach ${url}: ${err.message}. Start the server (npm run dev) or pass --url.`,
    );
  }
}

function asApiError(body: unknown): ApiError | null {
  return typeof body === 'object' && body !== null && 'error' in body ? (body as ApiError) : null;
}

/** Server state carried by a 409 `rev_conflict`, `null` for any other error. */
export function revConflictState(err: unknown): SessionState | null {
  if (!(err instanceof HttpError) || err.status !== 409 || err.body?.error !== 'rev_conflict') return null;
  const details = err.body.details as { state?: SessionState } | undefined;
  return details?.state ?? null;
}
