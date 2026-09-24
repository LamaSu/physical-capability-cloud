/**
 * PX-3 (no fabricated authoritative state) for two lab pages.
 *
 * - OrchestratorPage drew step 1 as done (100%) and step 2 as in progress (60%,
 *   pulsing) for every workflow, whatever its real state. Steps carry no status,
 *   so progress now comes from the workflow status alone.
 * - ProtocolBuilderPage's "Save Draft" and "Publish" buttons had no handler.
 *   The draft is local and the protocol library has no server store, so the page
 *   says so and Publish is disabled.
 *
 * The dashboard has no React Testing Library, so the page checks read the source
 * as text, as OnboardLandingPage.test.tsx does.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stepSegmentNote, workflowStepSegments } from "../orchestrator-logic.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(resolve(here, "..", name), "utf-8");

describe("workflowStepSegments", () => {
  it("fills every segment only when the workflow completed", () => {
    expect(workflowStepSegments("completed", 3)).toEqual(["done", "done", "done"]);
  });

  it("shows nothing started for a pending workflow", () => {
    expect(workflowStepSegments("pending", 2)).toEqual(["not-started", "not-started"]);
  });

  it("never marks a step done while the workflow is running, failed or cancelled", () => {
    for (const status of ["running", "failed", "cancelled", "something-new"]) {
      const segments = workflowStepSegments(status, 4);
      expect(segments).toEqual(["unknown", "unknown", "unknown", "unknown"]);
      expect(segments).not.toContain("done");
    }
  });

  it("handles zero or odd step counts", () => {
    expect(workflowStepSegments("running", 0)).toEqual([]);
    expect(workflowStepSegments("completed", -2)).toEqual([]);
    expect(workflowStepSegments("completed", 2.7)).toHaveLength(2);
  });

  it("explains unknown progress instead of hiding it", () => {
    expect(stepSegmentNote("unknown")).toBe("per-step progress is not reported");
  });
});

describe("OrchestratorPage source", () => {
  const source = read("OrchestratorPage.tsx");

  it("no longer hard-codes step progress", () => {
    expect(source).not.toContain('"60%"');
    expect(source).not.toMatch(/i === 1 \? "bg-amber-400/);
    expect(source).toContain("workflowStepSegments(wf.status, wf.steps.length)");
  });
});

describe("ProtocolBuilderPage source", () => {
  const source = read("ProtocolBuilderPage.tsx");

  it("has no dead Save Draft button and labels the draft as local", () => {
    expect(source).not.toContain("Save Draft");
    expect(source).toContain("Local draft, not saved");
  });

  it("disables Publish and says why", () => {
    expect(source).toMatch(/<button\s+type="button"\s+disabled\s+title="Publishing is not available yet/);
    expect(source).toContain("Publish (not available yet)");
  });
});
