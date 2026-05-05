/**
 * @pcc/connectors-postgres
 *
 * Thin TS client for the Python connectors-runtime sidecar's postgres
 * source. Every function is a plain `fetch()` wrapper; the brain stays
 * in TS and the runtime keeps Python out of our dependency tree.
 *
 * Default runtime URL is `http://127.0.0.1:8766` — the loopback bind
 * matches the systemd unit's default. Override per-call or via the
 * `CONNECTORS_RUNTIME_URL` env var.
 */

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8766";

function runtimeUrl(): string {
  // Read at call time so tests can mutate process.env between cases.
  return process.env.CONNECTORS_RUNTIME_URL || DEFAULT_RUNTIME_URL;
}

/** Error thrown when the runtime is unreachable, returns non-2xx, or the
 * response can't be parsed. Carries the HTTP status (or `null` for
 * network errors) so callers can branch on it without re-parsing. */
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

// ── Public types ──────────────────────────────────────────────────────────

export interface PostgresSourceConfig {
  /** Postgres connection string. */
  credentials: string;
  /** Optional schema name (defaults to dlt's behaviour — public). */
  schema?: string;
  /** Optional restriction to specific tables; otherwise dlt loads all. */
  table_names?: string[];
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

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Create a postgres source on the runtime. Calls
 * `POST /sources` with `{kind: "postgres", config}`.
 */
export async function createPostgresSource(
  config: PostgresSourceConfig,
): Promise<CreateSourceResult> {
  return fetchJson<CreateSourceResult>("/sources", {
    method: "POST",
    body: { kind: "postgres", config },
  });
}

/**
 * Trigger a pipeline run. Calls `POST /pipelines/{id}/run`.
 *
 * The runtime returns immediately with a `run_id`; status updates land on
 * `getPipelineStatus(pipeline_id)`.
 */
export async function runPipeline(
  pipelineId: string,
  opts: { full_refresh?: boolean; table_name?: string } = {},
): Promise<RunPipelineResult> {
  return fetchJson<RunPipelineResult>(`/pipelines/${pipelineId}/run`, {
    method: "POST",
    body: opts,
  });
}

/**
 * Snapshot pipeline status. Calls `GET /pipelines/{id}/status`.
 */
export async function getPipelineStatus(pipelineId: string): Promise<PipelineStatus> {
  return fetchJson<PipelineStatus>(`/pipelines/${pipelineId}/status`, { method: "GET" });
}
