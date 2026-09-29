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
import { readOrchestratorResponse, stepSegmentNote, workflowStepSegments } from "../orchestrator-logic.js";

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

describe("readOrchestratorResponse", () => {
  // N34: outside demo mode the gateway now answers orchestrator routes with
  // HTTP 501 { error: "not_available", message, see } once it stops
  // recording this data. Treating that body as data (the old behaviour)
  // showed "0 Transfer Graphs" — fabricated authoritative state (PX-3).

  it("classifies a 501 not_available, keeping its message and see routes", async () => {
    const res = new Response(
      JSON.stringify({
        error: "not_available",
        message: "orchestrator graphs are not recorded by this gateway",
        see: ["GET /api/kernels", "GET /api/kernels/:kernelId/devices"],
      }),
      { status: 501 },
    );

    const result = await readOrchestratorResponse(res);

    expect(result).toEqual({
      state: "not_available",
      message: "orchestrator graphs are not recorded by this gateway",
      see: ["GET /api/kernels", "GET /api/kernels/:kernelId/devices"],
    });
  });

  it("treats a 501 whose body is not not_available as a plain error", async () => {
    const res = new Response(JSON.stringify({ error: "some_other_error" }), {
      status: 501,
      statusText: "Not Implemented",
    });

    const result = await readOrchestratorResponse(res);

    expect(result.state).toBe("error");
    if (result.state === "error") {
      expect(result.status).toBe(501);
    }
  });

  it("never throws on a non-JSON error body", async () => {
    const res = new Response("<html>gateway error</html>", { status: 500 });

    const result = await readOrchestratorResponse(res);

    expect(result.state).toBe("error");
    if (result.state === "error") {
      expect(result.status).toBe(500);
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("flags demo data from the x-pcc-demo response header", async () => {
    const res = new Response(JSON.stringify({ graphs: [] }), {
      status: 200,
      headers: { "x-pcc-demo": "true" },
    });

    const result = await readOrchestratorResponse(res);

    expect(result.state).toBe("ok");
    if (result.state === "ok") {
      expect(result.demo).toBe(true);
    }
  });

  it("flags demo data from a demo: true body field", async () => {
    const res = new Response(JSON.stringify({ graphs: [], demo: true }), { status: 200 });

    const result = await readOrchestratorResponse(res);

    expect(result.state).toBe("ok");
    if (result.state === "ok") {
      expect(result.demo).toBe(true);
    }
  });

  it("is not demo data for a plain 200, and keeps the data intact", async () => {
    const res = new Response(JSON.stringify({ graphs: [{ id: "g1" }] }), { status: 200 });

    const result = await readOrchestratorResponse<{ graphs: Array<{ id: string }> }>(res);

    expect(result.state).toBe("ok");
    if (result.state === "ok") {
      expect(result.demo).toBe(false);
      expect(result.data.graphs).toEqual([{ id: "g1" }]);
    }
  });

  it("reports an error instead of throwing on invalid JSON in an ok response", async () => {
    const res = new Response("not json", { status: 200 });

    const result = await readOrchestratorResponse(res);

    expect(result.state).toBe("error");
    if (result.state === "error") {
      expect(result.status).toBe(200);
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe("OrchestratorPage source", () => {
  const source = read("OrchestratorPage.tsx");

  it("no longer hard-codes step progress", () => {
    expect(source).not.toContain('"60%"');
    expect(source).not.toMatch(/i === 1 \? "bg-amber-400/);
    expect(source).toContain("workflowStepSegments(wf.status, wf.steps.length)");
  });

  it("classifies every orchestrator fetch instead of trusting the raw body", () => {
    const calls = source.match(/readOrchestratorResponse/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toContain(".then((r) => r.json())");
  });

  it("says when the gateway doesn't have the data, instead of showing an empty lab", () => {
    expect(source).toContain("not available on this gateway");
  });

  it("falls KPI tiles back to an em dash instead of a fabricated zero", () => {
    expect(source).toContain("—");
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
