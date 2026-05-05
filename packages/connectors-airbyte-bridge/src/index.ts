/**
 * @pcc/connectors-airbyte-bridge
 *
 * Escape hatch for enterprises that already run Airbyte. Triggers an
 * existing Airbyte connection's job and polls its status. Does NOT
 * provision sources or destinations — that's Airbyte's own UI/API to
 * own; this bridge is the thin glue that lets a PCC orchestrator say
 * "kick that connection now".
 *
 * Reads `AIRBYTE_API_URL` and `AIRBYTE_API_KEY` from env at call time.
 * The orchestrator only loads this package when both are set, so a
 * fresh install with no Airbyte deployment never sees this code path.
 *
 * Endpoints (Airbyte API v1):
 *   POST /v1/jobs         body: {connectionId, jobType: "sync"|"reset"}
 *   GET  /v1/jobs/{jobId}
 *
 * The actual Airbyte API base path varies by deployment (open-source
 * Airbyte typically lives at /api/v1, Airbyte Cloud at /v1). Set
 * `AIRBYTE_API_URL` to the full base including the version segment, e.g.
 *   AIRBYTE_API_URL=https://airbyte.acme.com/api/v1
 */

const ENV_API_URL = "AIRBYTE_API_URL";
const ENV_API_KEY = "AIRBYTE_API_KEY";

function airbyteUrl(): string {
  const url = process.env[ENV_API_URL];
  if (!url) {
    throw new AirbyteError(
      `airbyte_not_configured: env ${ENV_API_URL} is not set; this bridge is opt-in.`,
      null,
    );
  }
  return url.replace(/\/$/, "");
}

function airbyteAuthHeader(): string {
  const key = process.env[ENV_API_KEY];
  if (!key) {
    throw new AirbyteError(
      `airbyte_not_configured: env ${ENV_API_KEY} is not set; this bridge is opt-in.`,
      null,
    );
  }
  return `Bearer ${key}`;
}

/** Error thrown by this bridge. status is the HTTP status when the call
 * reached Airbyte, or `null` for configuration / network errors. */
export class AirbyteError extends Error {
  public readonly status: number | null;
  public readonly detail: unknown;
  constructor(message: string, status: number | null, detail?: unknown) {
    super(message);
    this.name = "AirbyteError";
    this.status = status;
    this.detail = detail;
  }
}

interface FetchJsonOptions {
  method: "GET" | "POST";
  body?: unknown;
}

async function fetchJson<T>(path: string, opts: FetchJsonOptions): Promise<T> {
  const url = `${airbyteUrl()}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: airbyteAuthHeader(),
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AirbyteError(`airbyte_unreachable: ${msg}`, null);
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }

  if (!resp.ok) {
    throw new AirbyteError(`airbyte returned ${resp.status}`, resp.status, parsed);
  }
  return parsed as T;
}

// ── Public types ──────────────────────────────────────────────────────────

export interface AirbyteJobInfo {
  jobId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | string;
  jobType: "sync" | "reset" | string;
  connectionId?: string;
  startTime?: string;
  endTime?: string;
  bytesSynced?: number;
  rowsSynced?: number;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Trigger a job on an existing Airbyte connection.
 *
 * @param connectionId — the connection's UUID in the Airbyte deployment.
 * @param opts.jobType — "sync" (default) or "reset".
 */
export async function triggerAirbyteJob(
  connectionId: string,
  opts: { jobType?: "sync" | "reset" } = {},
): Promise<AirbyteJobInfo> {
  return fetchJson<AirbyteJobInfo>("/jobs", {
    method: "POST",
    body: { connectionId, jobType: opts.jobType ?? "sync" },
  });
}

/**
 * Snapshot a job's status. Poll this on an interval (the orchestrator
 * holds the polling loop; this function is single-shot on purpose).
 */
export async function getAirbyteJobStatus(jobId: string): Promise<AirbyteJobInfo> {
  return fetchJson<AirbyteJobInfo>(`/jobs/${encodeURIComponent(jobId)}`, { method: "GET" });
}
