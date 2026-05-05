/**
 * @pcc/connectors-sharepoint
 *
 * Thin TS client for the Python connectors-runtime sidecar's sharepoint
 * source. Wraps POST /sources with kind="sharepoint", and the same
 * pipeline run/status endpoints as the other shells.
 *
 * NOTE: in v0.1 the runtime returns 501 (`vendor_sdk_not_wired`) on
 * sharepoint source creation — vendor SDK pin lands in Wave 4.
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

export interface SharepointSourceConfig {
  /** Site URL, e.g. https://acme.sharepoint.com/sites/finance */
  site_url: string;
  /** OAuth access token for Microsoft Graph (orchestrator handles refresh). */
  access_token: string;
  /** Optional list of document libraries to load. */
  libraries?: string[];
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

/** Create a sharepoint source on the runtime. POST /sources with kind="sharepoint". */
export async function createSharepointSource(
  config: SharepointSourceConfig,
): Promise<CreateSourceResult> {
  return fetchJson<CreateSourceResult>("/sources", {
    method: "POST",
    body: { kind: "sharepoint", config },
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
