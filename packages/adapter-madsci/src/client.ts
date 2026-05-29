/**
 * Thin HTTP client for MADSci Workcell Manager (default port 8005).
 *
 * The MADSci framework exposes a REST surface but the literal route table
 * is not in the public README as of the adapter's reference fetch (May 2026).
 * Routes here track the observed conventions in MADSci_Examples and the
 * RestNode base class. If upstream paths shift, this file is the single
 * point of update.
 */

import type { MadsciNode, MadsciWorkflow } from "./types.js";

export interface MadsciClientOptions {
  /** Base URL of the Workcell Manager (e.g. http://localhost:8005). */
  baseUrl: string;
  /** Optional fetch override (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Bearer token, if a future Auth Manager is wired up. */
  token?: string;
}

export class MadsciClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token?: string;

  constructor(opts: MadsciClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.token = opts.token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;

    const res = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`MADSci ${path} ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  /** GET /nodes — list registered nodes in the lab. */
  async listNodes(): Promise<MadsciNode[]> {
    return this.request<MadsciNode[]>("/nodes");
  }

  /** GET /workflows — list known workflow definitions. */
  async listWorkflows(): Promise<{ name: string; description?: string }[]> {
    return this.request("/workflows");
  }

  /** POST /workflows/run — submit a workflow for execution. */
  async runWorkflow(workflow: MadsciWorkflow): Promise<{ run_id: string }> {
    return this.request("/workflows/run", {
      method: "POST",
      body: JSON.stringify(workflow),
    });
  }

  /** GET /workflows/runs/:id — poll run status. */
  async getRun(runId: string): Promise<{
    run_id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    current_step?: string;
    error?: string;
  }> {
    return this.request(`/workflows/runs/${encodeURIComponent(runId)}`);
  }
}
