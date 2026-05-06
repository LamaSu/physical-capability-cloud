/**
 * FederationPeer — typed HTTP client for Cypher Bio's federation
 * endpoints.
 *
 * Endpoint map (from `~/.cache/cypherbio/CYPHER-API-NOTES.md`):
 *
 * - POST   /api/federation/instances/register
 * - POST   /api/federation/disconnect
 * - GET    /api/federation/status
 * - GET    /api/federation/services/browse
 * - POST   /api/federation/services
 * - DELETE /api/federation/services/:id/publish
 *
 * Auth: `X-API-Key: <key>`. The federation registry is admin-scoped,
 * so a `cyp_lims_*` key returns `403 Insufficient scope`. The peer
 * surfaces that as a typed `FederationAuthError` so callers (e.g.
 * `scripts/register-with-cypher.ts`) can degrade gracefully.
 */

import type {
  CypherCredentials,
  CypherFederationService,
  FederationManifest,
  FederationStatus,
} from "./types.js";

const DEFAULT_BASE_URL = "https://cypherbio.ai/backend";

export interface FederationPeerOptions {
  /** Cypher API key with federation scope. */
  apiKey: string;
  /** Cypher backend base URL. Defaults to the public production base. */
  baseUrl?: string;
  /** Inject a custom `fetch` implementation (useful in tests). */
  fetchImpl?: typeof fetch;
}

/** Generic Cypher API error. */
export class FederationApiError extends Error {
  public readonly status: number | null;
  public readonly body: unknown;
  constructor(message: string, status: number | null, body?: unknown) {
    super(message);
    this.name = "FederationApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Specialized 401/403 error — the API key was rejected.
 *
 * Most Cypher operators today only have a `cyp_lims_*` key, and
 * federation requires admin scope; this error type lets the
 * register CLI print a helpful message instead of a stack trace.
 */
export class FederationAuthError extends FederationApiError {
  constructor(message: string, status: number, body?: unknown) {
    super(message, status, body);
    this.name = "FederationAuthError";
  }
}

interface FetchOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export class FederationPeer {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FederationPeerOptions) {
    if (!opts.apiKey) {
      throw new Error("FederationPeer: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Register PCC as a federation instance. */
  async register(manifest: FederationManifest): Promise<CypherCredentials> {
    const data = await this.request<{ credentials: CypherCredentials; instance: unknown }>({
      method: "POST",
      path: "/api/federation/instances/register",
      body: manifest,
    });
    return data.credentials;
  }

  /** Disconnect a federation instance (typically PCC's own instance). */
  async disconnect(instanceId: string): Promise<void> {
    await this.request<unknown>({
      method: "POST",
      path: "/api/federation/disconnect",
      body: { instanceId },
    });
  }

  /** Federation health snapshot. */
  async status(): Promise<FederationStatus> {
    return this.request<FederationStatus>({
      method: "GET",
      path: "/api/federation/status",
    });
  }

  /** Auth-required browse of the federation catalog. */
  async browseServices(): Promise<CypherFederationService[]> {
    const resp = await this.request<{ services?: CypherFederationService[] } | CypherFederationService[]>({
      method: "GET",
      path: "/api/federation/services/browse",
    });
    if (Array.isArray(resp)) return resp;
    return resp.services ?? [];
  }

  /** Publish (advertise) a single service for this instance. */
  async publishService(svc: CypherFederationService): Promise<void> {
    await this.request<unknown>({
      method: "POST",
      path: "/api/federation/services",
      body: svc,
    });
  }

  /** Unpublish a previously-advertised service. */
  async unpublishService(serviceId: string): Promise<void> {
    if (!serviceId) {
      throw new Error("FederationPeer.unpublishService: serviceId is required");
    }
    await this.request<unknown>({
      method: "DELETE",
      path: `/api/federation/services/${encodeURIComponent(serviceId)}/publish`,
    });
  }

  // ── internals ────────────────────────────────────────────────────

  private async request<T>(opts: FetchOptions): Promise<T> {
    let url = `${this.baseUrl}${opts.path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s.length > 0) url += `?${s}`;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: opts.method,
        headers: {
          "X-API-Key": this.apiKey,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new FederationApiError(`cypher_unreachable: ${msg}`, null);
    }

    let parsed: unknown = null;
    const ctype = resp.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      try {
        parsed = await resp.json();
      } catch {
        parsed = null;
      }
    } else {
      try {
        parsed = await resp.text();
      } catch {
        parsed = null;
      }
    }

    if (!resp.ok) {
      const detailMsg = extractErrorMessage(parsed) ?? resp.statusText ?? "request_failed";
      const fullMsg = `cypher ${opts.method} ${opts.path} -> ${resp.status}: ${detailMsg}`;
      if (resp.status === 401 || resp.status === 403) {
        throw new FederationAuthError(fullMsg, resp.status, parsed);
      }
      throw new FederationApiError(fullMsg, resp.status, parsed);
    }

    return parsed as T;
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") return body;
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") return b.message;
    if (typeof b.error === "string") return b.error;
    if (typeof b.detail === "string") return b.detail;
    if (b.detail && typeof b.detail === "object") {
      const d = b.detail as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
      if (typeof d.error === "string") return d.error;
    }
  }
  return null;
}
