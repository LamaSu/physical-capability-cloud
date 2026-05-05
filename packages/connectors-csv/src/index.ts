/**
 * @pcc/connectors-csv
 *
 * Thin TS client for the Python connectors-runtime sidecar's CSV source.
 * Wraps POST /sources with kind="csv", and the same pipeline run/status
 * endpoints as the other shells.
 *
 * Unlike salesforce/sharepoint/sap, CSV is fully wired in v0.1 — the
 * runtime uses `dlt.sources.filesystem` underneath and supports both
 * local paths and (with the appropriate filesystem backend) cloud URIs.
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

export interface CsvSourceConfig {
  /** Bucket URL or local directory path, e.g. "/data/csvs" or "s3://bucket/prefix". */
  bucket_url: string;
  /** Optional file glob, defaults to "*.csv". */
  file_glob?: string;
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

/** Create a CSV source on the runtime. POST /sources with kind="csv". */
export async function createCsvSource(
  config: CsvSourceConfig,
): Promise<CreateSourceResult> {
  return fetchJson<CreateSourceResult>("/sources", {
    method: "POST",
    body: { kind: "csv", config },
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
