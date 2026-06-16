/**
 * Tests for executeToolCall + interpolatePath.
 *
 * The path interpolation is where parity with the gateway's onboard-chat
 * lives — same regex, same encoding behavior. Auth header passthrough is
 * the other parity-critical bit.
 */
import { describe, it, expect, vi } from "vitest";
import { executeToolCall, interpolatePath } from "../lib/tool-execute.js";
import type { AgentPackageTool } from "../lib/agent-package.js";

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: "OK",
      text: async () => JSON.stringify(body),
    }) as unknown as Response,
  );
}

describe("interpolatePath", () => {
  it("substitutes a single {param}", () => {
    const { path, pathParams } = interpolatePath("/api/jobs/{jobId}", { jobId: "job-123" });
    expect(path).toBe("/api/jobs/job-123");
    expect(pathParams.has("jobId")).toBe(true);
  });

  it("substitutes multiple params", () => {
    const { path, pathParams } = interpolatePath(
      "/api/kernels/{kernelId}/devices/{deviceId}",
      { kernelId: "k-1", deviceId: "d-2" },
    );
    expect(path).toBe("/api/kernels/k-1/devices/d-2");
    expect(pathParams.size).toBe(2);
  });

  it("URI-encodes special characters", () => {
    const { path } = interpolatePath("/api/items/{id}", { id: "with spaces & symbols" });
    expect(path).toContain("with%20spaces%20%26%20symbols");
  });

  it("leaves placeholders empty when the input is missing", () => {
    const { path } = interpolatePath("/api/items/{id}", {});
    expect(path).toBe("/api/items/");
  });
});

describe("executeToolCall", () => {
  const POST_TOOL: AgentPackageTool = {
    name: "create_kernel",
    description: "Register a kernel",
    input_schema: { type: "object" },
    endpoint: { method: "POST", path: "/api/kernels" },
  };
  const GET_TOOL_WITH_PARAM: AgentPackageTool = {
    name: "get_job",
    description: "Get a job",
    input_schema: { type: "object" },
    endpoint: { method: "GET", path: "/api/jobs/{jobId}" },
  };
  const GET_TOOL_NO_PARAM: AgentPackageTool = {
    name: "list_caps",
    description: "List capability types",
    input_schema: { type: "object" },
    endpoint: { method: "GET", path: "/api/capabilities/types" },
  };

  it("POST sends a JSON body with the non-path inputs", async () => {
    const fetchFn = makeFetch(200, { ok: true });
    const res = await executeToolCall({
      tool: POST_TOOL,
      input: { name: "Test", maxAssuranceTier: 2 },
      gatewayUrl: "https://capability.network",
      fetchFn,
    });
    expect(res.status).toBe(200);
    const call = (fetchFn as any).mock.calls[0];
    expect(call[0]).toBe("https://capability.network/api/kernels");
    const init = call[1];
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("Test");
    expect(body.maxAssuranceTier).toBe(2);
  });

  it("GET interpolates the path and puts extras into query string", async () => {
    const fetchFn = makeFetch(200, { job: { id: "abc" } });
    await executeToolCall({
      tool: GET_TOOL_WITH_PARAM,
      input: { jobId: "abc", verbose: true },
      gatewayUrl: "https://capability.network",
      fetchFn,
    });
    const calledUrl = (fetchFn as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/jobs/abc");
    expect(calledUrl).toContain("verbose=true");
  });

  it("attaches Authorization: Bearer when pccApiKey is provided", async () => {
    const fetchFn = makeFetch(200, { ok: true });
    await executeToolCall({
      tool: GET_TOOL_NO_PARAM,
      input: {},
      gatewayUrl: "https://capability.network",
      pccApiKey: "pcc_live_abc",
      fetchFn,
    });
    const init = (fetchFn as any).mock.calls[0][1];
    expect(init.headers.authorization).toBe("Bearer pcc_live_abc");
  });

  it("omits Authorization header when no key is given", async () => {
    const fetchFn = makeFetch(200, { ok: true });
    await executeToolCall({
      tool: GET_TOOL_NO_PARAM,
      input: {},
      gatewayUrl: "https://capability.network",
      fetchFn,
    });
    const init = (fetchFn as any).mock.calls[0][1];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("returns 404 + tool_has_no_endpoint when endpoint is missing", async () => {
    const fetchFn = makeFetch(200, {});
    const res = await executeToolCall({
      tool: { name: "broken", input_schema: {} },
      input: {},
      gatewayUrl: "https://capability.network",
      fetchFn,
    });
    expect(res.status).toBe(404);
    expect((res.result as any).error).toBe("tool_has_no_endpoint");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("wraps network errors in a 500 result", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const res = await executeToolCall({
      tool: POST_TOOL,
      input: { name: "x" },
      gatewayUrl: "https://nowhere.example",
      fetchFn,
    });
    expect(res.status).toBe(500);
    expect((res.result as any).error).toBe("network_error");
  });

  it("parses non-JSON bodies as text", async () => {
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "plain text body",
      }) as unknown as Response,
    );
    const res = await executeToolCall({
      tool: GET_TOOL_NO_PARAM,
      input: {},
      gatewayUrl: "https://capability.network",
      fetchFn,
    });
    expect(res.result).toBe("plain text body");
  });
});
