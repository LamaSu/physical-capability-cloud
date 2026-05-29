/**
 * Automata LINQ REST client.
 *
 * Authoritative auth scheme + endpoint paths are NOT public as of the
 * reference fetch (2026-05-27). Public docs index lists resources
 * (Workcell, Instrument, Workflow, Task, Labware) and confirms REST.
 * Sandbox / signup not exposed publicly — needs an enterprise contact.
 *
 * Paths below follow SaaS-CRUD conventions (`/v1/<resource>` plural) and
 * are flagged as such. Re-verify against the real surface once an API
 * key is available.
 */

import {
  LinqInstrumentSchema,
  LinqRunSchema,
  LinqWorkcellSchema,
  LinqWorkflowSchema,
  type LinqInstrument,
  type LinqRun,
  type LinqWorkcell,
  type LinqWorkflow,
} from "./types.js";

export interface LinqClientOptions {
  /** LINQ Cloud base URL (assumed pattern: https://api.linq.automata.tech). */
  baseUrl?: string;
  /** API key from the LINQ dashboard. */
  apiKey: string;
  /** Optional fetch override (for tests). */
  fetchImpl?: typeof fetch;
}

export class LinqAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinqAuthError";
  }
}

export class LinqClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LinqClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.linq.automata.tech").replace(
      /\/$/,
      "",
    );
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers,
    });
    if (res.status === 401 || res.status === 403) {
      throw new LinqAuthError(`LINQ auth rejected (${res.status})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LINQ ${path} ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  async listWorkcells(): Promise<LinqWorkcell[]> {
    const raw = await this.request<unknown[]>("/v1/workcells");
    return raw.map((r) => LinqWorkcellSchema.parse(r));
  }

  async listInstruments(workcellId: string): Promise<LinqInstrument[]> {
    const raw = await this.request<unknown[]>(
      `/v1/workcells/${encodeURIComponent(workcellId)}/instruments`,
    );
    return raw.map((r) => LinqInstrumentSchema.parse(r));
  }

  async listWorkflows(workcellId: string): Promise<LinqWorkflow[]> {
    const raw = await this.request<unknown[]>(
      `/v1/workcells/${encodeURIComponent(workcellId)}/workflows`,
    );
    return raw.map((r) => LinqWorkflowSchema.parse(r));
  }

  async getWorkflow(workflowId: string): Promise<LinqWorkflow> {
    const raw = await this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(workflowId)}`,
    );
    return LinqWorkflowSchema.parse(raw);
  }

  async startRun(workflowId: string): Promise<LinqRun> {
    const raw = await this.request<unknown>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/runs`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return LinqRunSchema.parse(raw);
  }

  async getRun(runId: string): Promise<LinqRun> {
    const raw = await this.request<unknown>(
      `/v1/runs/${encodeURIComponent(runId)}`,
    );
    return LinqRunSchema.parse(raw);
  }
}
