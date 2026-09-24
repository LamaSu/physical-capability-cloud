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
