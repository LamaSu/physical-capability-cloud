import { describe, expect, it } from "vitest";
import { readOrchestratorResponse, workflowStepSegments } from "../orchestrator-logic.js";

describe("workflowStepSegments", () => {
  it("uses completion to fill every segment and explain why", () => {
    const segments = workflowStepSegments("completed", 3);

    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.state).toBe("done");
      expect(segment.width).toBe("100%");
      expect(segment.className).toContain("bg-green-400");
      expect(segment.note).toBe("done (workflow completed)");
    }
  });

  it("leaves every pending step unstarted with its reason", () => {
    const segments = workflowStepSegments("pending", 2);

    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment.state).toBe("not_started");
      expect(segment.width).toBe("0%");
      expect(segment.className).not.toContain("bg-green-400");
      expect(segment.className).not.toContain("animate-pulse");
      expect(segment.note).toBe("not started (workflow pending)");
    }
  });

  it.each(["running", "failed", "cancelled", "a-future-status"])(
    "does not infer individual step progress from %s",
    (status) => {
      const segments = workflowStepSegments(status, 4);

      expect(segments).toHaveLength(4);
      for (const segment of segments) {
        expect(segment.state).toBe("unknown");
        expect(segment.width).toBe("0%");
        expect(segment.className).not.toContain("bg-green-400");
        expect(segment.className).not.toContain("animate-pulse");
        expect(segment.note).toBe("per-step progress is not reported");
      }
    },
  );

  it.each([0, -2])("has no segments for a step count of %s", (stepCount) => {
    expect(workflowStepSegments("completed", stepCount)).toEqual([]);
  });

  it("uses only whole steps when the count has a fractional part", () => {
    expect(workflowStepSegments("completed", 2.7)).toHaveLength(2);
  });
});

function jsonResponse(body: unknown, status = 200, statusText = "") {
  return new Response(JSON.stringify(body), { status, statusText });
}

describe("readOrchestratorResponse", () => {
  it("retains a successful response body", async () => {
    const body = { graphs: [{ id: "transfer-1" }] };

    await expect(readOrchestratorResponse<typeof body>(jsonResponse(body))).resolves.toEqual({
      kind: "ok",
      data: body,
    });
  });

  it.each([null, ["a", "b"], "text", 12, false])(
    "accepts valid JSON without imposing a response schema: %j",
    async (body) => {
      await expect(readOrchestratorResponse(jsonResponse(body, 201))).resolves.toEqual({
        kind: "ok",
        data: body,
      });
    },
  );

  it("preserves the unavailable response's explanation and routes", async () => {
    const message = "The gateway does not record transfer graphs.";
    const see = ["GET /api/kernels", "GET /api/kernels/:kernelId/devices"];

    await expect(
      readOrchestratorResponse(jsonResponse({ error: "not_available", message, see }, 501)),
    ).resolves.toEqual({ kind: "not_available", status: 501, message, see });
  });

  it.each([undefined, "", 42])("supplies an explanation when the 501 message is %j", async (message) => {
    await expect(
      readOrchestratorResponse(jsonResponse({ error: "not_available", message }, 501)),
    ).resolves.toEqual({
      kind: "not_available",
      status: 501,
      message: "This gateway does not make this data available.",
      see: [],
    });
  });

  it("keeps only string routes from an unavailable response", async () => {
    const result = await readOrchestratorResponse(
      jsonResponse({ error: "not_available", see: ["/api/kernels", null, 9, {}, "/api/devices"] }, 501),
    );

    expect(result).toMatchObject({ kind: "not_available", see: ["/api/kernels", "/api/devices"] });
  });

  it("uses no routes when see is not an array", async () => {
    const result = await readOrchestratorResponse(
      jsonResponse({ error: "not_available", see: "/api/kernels" }, 501),
    );

    expect(result).toMatchObject({ kind: "not_available", see: [] });
  });

  it("reports an ordinary 501 as an error", async () => {
    await expect(
      readOrchestratorResponse(jsonResponse({ error: "unsupported_operation" }, 501, "Not Implemented")),
    ).resolves.toEqual({ kind: "error", status: 501, message: "unsupported_operation" });
  });

  it("requires HTTP 501 to classify not_available", async () => {
    await expect(
      readOrchestratorResponse(jsonResponse({ error: "not_available" }, 503, "Service Unavailable")),
    ).resolves.toEqual({ kind: "error", status: 503, message: "not_available" });
  });

  it("uses the body's message ahead of error and statusText", async () => {
    await expect(
      readOrchestratorResponse(jsonResponse({ message: "Claims are offline", error: "backend_down" }, 500, "Failure")),
    ).resolves.toEqual({ kind: "error", status: 500, message: "Claims are offline" });
  });

  it("uses error when message is empty or not a string", async () => {
    for (const message of ["", 23]) {
      await expect(
        readOrchestratorResponse(jsonResponse({ message, error: "backend_down" }, 500, "Failure")),
      ).resolves.toEqual({ kind: "error", status: 500, message: "backend_down" });
    }
  });

  it("uses statusText when the body has no usable message or error", async () => {
    await expect(
      readOrchestratorResponse(jsonResponse({ message: false, error: {} }, 502, "Bad Gateway")),
    ).resolves.toEqual({ kind: "error", status: 502, message: "Bad Gateway" });
  });

  it("falls back to the HTTP status when no error text is supplied", async () => {
    await expect(readOrchestratorResponse(jsonResponse(null, 503))).resolves.toEqual({
      kind: "error",
      status: 503,
      message: "HTTP 503",
    });
  });

  it("resolves a non-JSON error body to an error classification", async () => {
    await expect(
      readOrchestratorResponse(new Response("<html>upstream failed</html>", { status: 500, statusText: "Server Error" })),
    ).resolves.toEqual({ kind: "error", status: 500, message: "Server Error" });
  });

  it("handles a non-JSON error body even when statusText is absent", async () => {
    await expect(readOrchestratorResponse(new Response("broken", { status: 500 }))).resolves.toEqual({
      kind: "error",
      status: 500,
      message: "HTTP 500",
    });
  });

  it("identifies invalid JSON on a successful HTTP response", async () => {
    await expect(readOrchestratorResponse(new Response("{broken", { status: 200 }))).resolves.toEqual({
      kind: "error",
      status: 200,
      message: "Response body was not valid JSON",
    });
  });
});
