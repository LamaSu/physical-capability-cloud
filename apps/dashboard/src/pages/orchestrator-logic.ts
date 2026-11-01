export interface WorkflowStepSegment {
  state: "done" | "not_started" | "unknown";
  width: string;
  className: string;
  note: string;
}

// Instrument steps have no status field. Only workflow completion establishes
// that a step is done; a running workflow says nothing about individual steps.
export function workflowStepSegments(status: string, stepCount: number): WorkflowStepSegment[] {
  return Array.from({ length: Math.max(0, Math.floor(stepCount)) }, () => {
    if (status === "completed") {
      return {
        state: "done",
        width: "100%",
        className: "bg-green-400",
        note: "done (workflow completed)",
      };
    }
    return {
      state: status === "pending" ? "not_started" : "unknown",
      width: "0%",
      className: "bg-white/10",
      note: status === "pending"
        ? "not started (workflow pending)"
        : "per-step progress is not reported",
    };
  });
}

export type OrchestratorRead<T> =
  | { kind: "ok"; data: T }
  | { kind: "not_available"; status: 501; message: string; see: string[] }
  | { kind: "error"; status: number; message: string };

// Consume the body once. Malformed JSON is a read result, including on an
// error response, so callers can explain the failure without losing its status.
export async function readOrchestratorResponse<T = unknown>(response: Response): Promise<OrchestratorRead<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "error",
      status: response.status,
      message: response.ok
        ? "Response body was not valid JSON"
        : response.statusText || `HTTP ${response.status}`,
    };
  }

  if (response.ok) return { kind: "ok", data: body as T };

  const fields = body !== null && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const message = typeof fields.message === "string" ? fields.message : "";
  if (response.status === 501 && fields.error === "not_available") {
    return {
      kind: "not_available",
      status: 501,
      message: message || "This gateway does not make this data available.",
      see: Array.isArray(fields.see)
        ? fields.see.filter((route): route is string => typeof route === "string")
        : [],
    };
  }

  const error = typeof fields.error === "string" ? fields.error : "";
  return {
    kind: "error",
    status: response.status,
    message: message || error || response.statusText || `HTTP ${response.status}`,
  };
}
