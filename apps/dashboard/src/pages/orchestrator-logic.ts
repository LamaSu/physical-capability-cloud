/**
 * Pure helpers for OrchestratorPage.
 *
 * An instrument step carries no status of its own (InstrumentStep in
 * packages/spec/src/types/orchestrator.ts). Per-step progress can therefore only
 * come from the workflow's status. Anything finer would be invented, and a
 * production surface never shows invented progress (product row PX-3).
 */

export type StepSegment = "done" | "not-started" | "unknown";

/** One segment per step, derived from the workflow status alone. */
export function workflowStepSegments(status: string, stepCount: number): StepSegment[] {
  const fill: StepSegment =
    status === "completed" ? "done" : status === "pending" ? "not-started" : "unknown";
  return Array.from({ length: Math.max(0, Math.floor(stepCount)) }, () => fill);
}

/** Hover text for a segment; says so when per-step progress is not reported. */
export function stepSegmentNote(segment: StepSegment): string {
  switch (segment) {
    case "done":
      return "done (workflow completed)";
    case "not-started":
      return "not started (workflow pending)";
    default:
      return "per-step progress is not reported";
  }
}

/**
 * Classifies a `/api/orchestrator/*` response (board N34, PX-3).
 *
 * Outside demo mode the gateway answers every orchestrator route with HTTP
 * 501 `{ error: "not_available", message, see }` once it stops recording
 * this data. Parsing that body as data — the old behaviour — showed "0
 * Transfer Graphs" and so on: an empty lab, when the truth is "this gateway
 * doesn't record this". That is fabricated authoritative state. Callers
 * must render "not available" and "empty" differently, so this stays a
 * three-way result instead of collapsing to data-or-null.
 */
export type OrchestratorRead<T> =
  | { state: "ok"; data: T; demo: boolean }
  | { state: "not_available"; message: string; see: string[] }
  | { state: "error"; status: number; message: string };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" ? (value as JsonRecord) : undefined;
}

function stringField(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function boolField(record: JsonRecord | undefined, key: string): boolean {
  return record?.[key] === true;
}

/** Reads and classifies a fetch Response. Never throws on a non-JSON body. */
export async function readOrchestratorResponse<T>(
  res: Pick<Response, "ok" | "status" | "statusText" | "headers" | "json">,
): Promise<OrchestratorRead<T>> {
  let body: unknown;
  let bodyParsed = true;
  try {
    body = await res.json();
  } catch {
    bodyParsed = false;
  }
  const record = asRecord(body);

  if (!res.ok) {
    if (res.status === 501 && record?.error === "not_available") {
      const message = stringField(record, "message") || "This gateway does not make this data available.";
      const seeRaw = record?.see;
      const see = Array.isArray(seeRaw) ? seeRaw.filter((s): s is string => typeof s === "string") : [];
      return { state: "not_available", message, see };
    }
    const message =
      stringField(record, "message") || stringField(record, "error") || res.statusText || `HTTP ${res.status}`;
    return { state: "error", status: res.status, message };
  }

  if (!bodyParsed) {
    return { state: "error", status: res.status, message: "Response body was not valid JSON" };
  }

  const demo = res.headers.get("x-pcc-demo") === "true" || boolField(record, "demo") || boolField(record, "mock");
  return { state: "ok", data: body as T, demo };
}
