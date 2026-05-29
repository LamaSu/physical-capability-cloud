/**
 * Automata LINQ client.
 *
 * Auth: Auth0 machine-to-machine client-credentials. Per the public
 * `linq configure` docs, three values are required and only ever provided
 * by an Automata Customer Success Manager: `api_domain`, `auth0_domain`,
 * and `client_id`. `LINQ_CLIENT_SECRET` is provisioned alongside the
 * client id (env var convention from the LINQ CLI).
 *
 * Method shape mirrors the Python SDK `linq.client.Linq` verb methods
 * (snake_case). The REST layer underneath is not the supported public
 * contract; endpoint paths used here are still best-guess and may need
 * adjustment once a sandbox is in hand. The verb-name surface, however,
 * is the documented API.
 */

import {
  LinqInstrumentSchema,
  LinqLabwareSchema,
  LinqRunSchema,
  LinqWorkcellSchema,
  LinqWorkflowSchema,
  type LinqInstrument,
  type LinqLabware,
  type LinqRun,
  type LinqWorkcell,
  type LinqWorkflow,
} from "./types.js";

export interface LinqClientOptions {
  /** LINQ REST API domain (e.g. "api.linq.automata.tech"). From `linq configure`. */
  apiDomain: string;
  /** Auth0 tenant domain (e.g. "automata-tech.eu.auth0.com"). From `linq configure`. */
  auth0Domain: string;
  /** Auth0 client id — LINQ_CLIENT_ID env var. */
  clientId: string;
  /** Auth0 client secret — LINQ_CLIENT_SECRET env var. */
  clientSecret: string;
  /**
   * Auth0 audience (API identifier). If omitted, defaults to
   * `https://<apiDomain>/`. Override if Automata uses a non-derived value.
   */
  audience?: string;
  /** Optional fetch override (for tests). */
  fetchImpl?: typeof fetch;
  /** Optional clock override (for tests). Returns ms since epoch. */
  now?: () => number;
}

/**
 * Error from the LINQ stack. `stage` distinguishes whether the Auth0
 * token exchange failed (credentials wrong, Auth0 misconfigured) vs. the
 * LINQ API itself rejecting an otherwise-valid token (key revoked,
 * scope missing, role wrong).
 */
export class LinqAuthError extends Error {
  readonly stage: "token-exchange" | "api-call";
  constructor(stage: "token-exchange" | "api-call", message: string) {
    super(message);
    this.name = "LinqAuthError";
    this.stage = stage;
  }
}

interface TokenCache {
  accessToken: string;
  expiresAtMs: number;
}

interface Auth0TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class LinqClient {
  private readonly apiBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly audience: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private tokenCache: TokenCache | null = null;

  constructor(opts: LinqClientOptions) {
    this.apiBaseUrl = `https://${opts.apiDomain.replace(/\/$/, "")}`;
    this.tokenUrl = `https://${opts.auth0Domain.replace(/\/$/, "")}/oauth/token`;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.audience = opts.audience ?? `https://${opts.apiDomain}/`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Get a valid access token, refreshing via Auth0 client-credentials if
   * the cached one is missing or within 60s of expiry.
   */
  private async getAccessToken(): Promise<string> {
    const nowMs = this.now();
    if (
      this.tokenCache &&
      this.tokenCache.expiresAtMs - 60_000 > nowMs
    ) {
      return this.tokenCache.accessToken;
    }
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: this.audience,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LinqAuthError(
        "token-exchange",
        `Auth0 token exchange failed (${res.status}): ${body}`,
      );
    }
    const json = (await res.json()) as Auth0TokenResponse;
    if (!json.access_token || typeof json.expires_in !== "number") {
      throw new LinqAuthError(
        "token-exchange",
        "Auth0 token response missing access_token or expires_in",
      );
    }
    this.tokenCache = {
      accessToken: json.access_token,
      expiresAtMs: nowMs + json.expires_in * 1000,
    };
    return json.access_token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await this.fetchImpl(this.apiBaseUrl + path, {
      ...init,
      headers,
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new LinqAuthError(
        "api-call",
        `LINQ API rejected token at ${path} (${res.status}): ${body}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LINQ ${path} ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  // ── Verb methods (snake_case, mirroring linq.client.Linq) ──────────

  async get_workcells(): Promise<LinqWorkcell[]> {
    const raw = await this.request<unknown[]>("/v1/workcells");
    return raw.map((r) => LinqWorkcellSchema.parse(r));
  }

  async get_instruments(workcellId?: string): Promise<LinqInstrument[]> {
    const path =
      workcellId === undefined
        ? "/v1/instruments"
        : `/v1/workcells/${encodeURIComponent(workcellId)}/instruments`;
    const raw = await this.request<unknown[]>(path);
    return raw.map((r) => LinqInstrumentSchema.parse(r));
  }

  async get_workflows(workcellId?: string): Promise<LinqWorkflow[]> {
    const path =
      workcellId === undefined
        ? "/v1/workflows"
        : `/v1/workcells/${encodeURIComponent(workcellId)}/workflows`;
    const raw = await this.request<unknown[]>(path);
    return raw.map((r) => LinqWorkflowSchema.parse(r));
  }

  async get_workflow(workflowId: string): Promise<LinqWorkflow> {
    const raw = await this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(workflowId)}`,
    );
    return LinqWorkflowSchema.parse(raw);
  }

  async start_workflow(workflowId: string): Promise<LinqRun> {
    const raw = await this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/start`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return LinqRunSchema.parse(raw);
  }

  async get_run(runId: string): Promise<LinqRun> {
    const raw = await this.request<unknown>(
      `/v1/runs/${encodeURIComponent(runId)}`,
    );
    return LinqRunSchema.parse(raw);
  }

  /**
   * Respond to a paused-on-error run state. `response` is the operator
   * decision the LINQ scheduler is waiting for — typically
   * `{ action: "retry" | "skip" | "abort", reason?: string, ... }` per
   * the LINQ docs; shape passed through verbatim.
   */
  async respond_to_error(
    runId: string,
    response: Record<string, unknown>,
  ): Promise<LinqRun> {
    const raw = await this.request<unknown>(
      `/v1/runs/${encodeURIComponent(runId)}/error-response`,
      { method: "POST", body: JSON.stringify(response) },
    );
    return LinqRunSchema.parse(raw);
  }

  async get_labwares(workcellId?: string): Promise<LinqLabware[]> {
    const path =
      workcellId === undefined
        ? "/v1/labwares"
        : `/v1/workcells/${encodeURIComponent(workcellId)}/labwares`;
    const raw = await this.request<unknown[]>(path);
    return raw.map((r) => LinqLabwareSchema.parse(r));
  }
}
