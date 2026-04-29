/**
 * @pcc/connectors-salesforce
 *
 * Thin TS client for the Python connectors-runtime sidecar's salesforce
 * source. Wraps POST /sources with kind="salesforce", and the same
 * pipeline run/status endpoints as the other shells.
 *
 * NOTE: in v0.1 the runtime returns 501 (`vendor_sdk_not_wired`) on
 * salesforce source creation — the vendor SDK pin lands in Wave 4. The
 * shell ships now so the orchestrator-sdk has a stable import surface.
 */

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8766";

function runtimeUrl(): string {
  return process.env.CONNECTORS_RUNTIME_URL || DEFAULT_RUNTIME_URL;
}

export class ConnectorError extends Error {
  public readonly status: number | null;
  public readonly detail: unknown;
  constructor(message: string, status: number | null, detail?: unknown) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
    this.detail = detail;
  }
}

interface FetchJsonOptions {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
}

async function fetchJson<T>(path: string, opts: FetchJsonOptions): Promise<T> {
  const url = `${runtimeUrl()}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: opts.method,
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConnectorError(`runtime_unreachable: ${msg}`, null);
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }

  if (!resp.ok) {
    throw new ConnectorError(
      `connectors-runtime returned ${resp.status}`,
      resp.status,
      parsed,
    );
  }
  return parsed as T;
}

export interface SalesforceSourceConfig {
  /** Salesforce instance URL, e.g. https://acme.my.salesforce.com */
  instance_url: string;
  /** OAuth access token (the orchestrator handles refresh). */
  access_token: string;
  /** Optional list of SObject names to load. */
  objects?: string[];
}

export interface CreateSourceResult {
  source_id: string;
  kind: string;
  config_summary: Record<string, unknown>;
  ready: boolean;
}

export interface RunPipelineResult {
  pipeline_id: string;
  run_id: string;
  status: "running";
}

export interface PipelineStatus {
  pipeline_id: string;
  name: string;
  status: "created" | "running" | "completed" | "failed";
  last_run_id: string | null;
  last_completed_at: number | null;
  rows_loaded: number | null;
  error: string | null;
}

/** Create a salesforce source on the runtime. POST /sources with kind="salesforce". */
export async function createSalesforceSource(
  config: SalesforceSourceConfig,
): Promise<CreateSourceResult> {
  return fetchJson<CreateSourceResult>("/sources", {
    method: "POST",
    body: { kind: "salesforce", config },
  });
}

/** Trigger a pipeline run. POST /pipelines/{id}/run. */
export async function runPipeline(
  pipelineId: string,
  opts: { full_refresh?: boolean; table_name?: string } = {},
): Promise<RunPipelineResult> {
  return fetchJson<RunPipelineResult>(`/pipelines/${pipelineId}/run`, {
    method: "POST",
    body: opts,
  });
}

/** Snapshot pipeline status. GET /pipelines/{id}/status. */
export async function getPipelineStatus(pipelineId: string): Promise<PipelineStatus> {
  return fetchJson<PipelineStatus>(`/pipelines/${pipelineId}/status`, { method: "GET" });
}
