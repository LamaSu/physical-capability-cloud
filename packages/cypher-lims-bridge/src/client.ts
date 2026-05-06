/**
 * @pcc/cypher-lims-bridge — CypherClient
 *
 * Thin HTTP wrapper around the Cypher Bio API. Uses native `fetch` (Node 20+)
 * to keep the package zero-dependency. Auth is `X-API-Key`, NOT Bearer.
 *
 * See `~/.cache/cypherbio/CYPHER-API-NOTES.md` for the full endpoint map.
 */

import type {
  CypherApiResponse,
  CypherFederationService,
  CypherLimsMeasurementBatch,
  CypherLimsRecordWorkPayload,
  CypherLimsRequest,
  CypherLimsStep,
  CypherLimsWorkflow,
  CypherPaginationParams,
} from './types.js';

const DEFAULT_BASE_URL = 'https://cypherbio.ai/backend';

export interface CypherClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Inject a custom fetch implementation for tests / non-browser runtimes. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Default: 60_000. */
  timeoutMs?: number;
}

export class CypherApiError extends Error {
  public readonly status: number | null;
  public readonly path: string;
  public readonly body: unknown;

  constructor(message: string, opts: { status: number | null; path: string; body?: unknown }) {
    super(message);
    this.name = 'CypherApiError';
    this.status = opts.status;
    this.path = opts.path;
    this.body = opts.body;
  }
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /**
   * If true, this is a public endpoint (`/api/protocols/public`,
   * `/api/federation/services/public`) — do NOT send the API key.
   */
  noAuth?: boolean;
}

export class CypherClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CypherClientOptions) {
    if (!opts.apiKey) {
      throw new Error('CypherClient: apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Build a URL with optional query string. */
  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async request<T>(path: string, opts: RequestOptions): Promise<CypherApiResponse<T>> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (!opts.noAuth) {
      headers['X-API-Key'] = this.apiKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CypherApiError(`cypher_unreachable: ${msg}`, { status: null, path });
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new CypherApiError(
        `cypher_api_error ${response.status} ${path}`,
        { status: response.status, path, body: parsed },
      );
    }

    return { ok: true, status: response.status, data: parsed as T };
  }

  // -------------------------------------------------------------------------
  // /api/me — exists for forward-compat with admin keys; LIMS keys get 403.
  // -------------------------------------------------------------------------
  async getMe(): Promise<CypherApiResponse<{ message?: string; [k: string]: unknown }>> {
    return this.request('/api/me', { method: 'GET' });
  }

  // -------------------------------------------------------------------------
  // LIMS — requests
  // -------------------------------------------------------------------------
  async listLimsRequests(
    params: CypherPaginationParams = {},
  ): Promise<CypherApiResponse<CypherLimsRequest[]>> {
    return this.request('/api/lims/requests', {
      method: 'GET',
      query: { limit: params.limit, offset: params.offset, workType: params.workType },
    });
  }

  async getLimsRequest(requestNumber: string): Promise<CypherApiResponse<CypherLimsRequest>> {
    return this.request(`/api/lims/requests/${encodeURIComponent(requestNumber)}`, {
      method: 'GET',
    });
  }

  // -------------------------------------------------------------------------
  // LIMS — workflows
  // -------------------------------------------------------------------------
  async listLimsWorkflows(
    params: Pick<CypherPaginationParams, 'limit' | 'offset'> = {},
  ): Promise<CypherApiResponse<CypherLimsWorkflow[]>> {
    return this.request('/api/lims/workflows', {
      method: 'GET',
      query: { limit: params.limit, offset: params.offset },
    });
  }

  async createLimsWorkflow(
    body: Partial<CypherLimsWorkflow>,
  ): Promise<CypherApiResponse<CypherLimsWorkflow>> {
    return this.request('/api/lims/workflows', { method: 'POST', body });
  }

  // -------------------------------------------------------------------------
  // LIMS — steps
  // -------------------------------------------------------------------------
  async listLimsSteps(
    params: Pick<CypherPaginationParams, 'limit' | 'offset'> = {},
  ): Promise<CypherApiResponse<CypherLimsStep[]>> {
    return this.request('/api/lims/steps', {
      method: 'GET',
      query: { limit: params.limit, offset: params.offset },
    });
  }

  /**
   * Advance a workflow step. Body shape varies by workType — Cypher accepts
   * `{ name, requestId?, workflowId?, ...stepData }` with arbitrary additional
   * fields. We pass through whatever the caller supplies.
   */
  async advanceStep(
    body: { name: string; requestId?: string; workflowId?: string; [key: string]: unknown },
  ): Promise<CypherApiResponse<CypherLimsStep>> {
    return this.request('/api/lims/steps', { method: 'POST', body });
  }

  // -------------------------------------------------------------------------
  // LIMS — measurements
  // -------------------------------------------------------------------------
  /**
   * Preview a measurement batch. Cypher requires one of `file`, `fileId`, or
   * `dataPoints` in the body — preview returns parsed rows + validation errors
   * before the caller commits.
   */
  async postMeasurementBatchPreview(
    body: CypherLimsMeasurementBatch,
  ): Promise<CypherApiResponse<unknown>> {
    return this.request('/api/lims/measurements/batches/preview', { method: 'POST', body });
  }

  /**
   * Commit a measurement batch from CSV. Use after `postMeasurementBatchPreview`
   * confirms the parse is clean.
   */
  async postMeasurementsFromCsv(
    body: CypherLimsMeasurementBatch,
  ): Promise<CypherApiResponse<unknown>> {
    return this.request('/api/lims/measurements/batches/from-csv', { method: 'POST', body });
  }

  // -------------------------------------------------------------------------
  // LIMS — record-work (operator clock-in / step completion)
  // -------------------------------------------------------------------------
  async recordWork(
    body: CypherLimsRecordWorkPayload,
  ): Promise<CypherApiResponse<unknown>> {
    return this.request('/api/lims/record-work', { method: 'POST', body });
  }

  // -------------------------------------------------------------------------
  // Federation catalog (public — no auth)
  // -------------------------------------------------------------------------
  async browseFederationCatalogPublic(): Promise<CypherApiResponse<CypherFederationService[]>> {
    return this.request('/api/federation/services/public', {
      method: 'GET',
      noAuth: true,
    });
  }

  // -------------------------------------------------------------------------
  // Public protocols (no auth)
  // -------------------------------------------------------------------------
  async getProtocolsPublic(): Promise<CypherApiResponse<unknown[]>> {
    return this.request('/api/protocols/public', { method: 'GET', noAuth: true });
  }
}
