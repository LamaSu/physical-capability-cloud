/**
 * Tests for fetchAgentPackage — the one network call the CLI makes
 * BEFORE the LLM loop kicks in.
 */
import { describe, it, expect, vi } from "vitest";
import { fetchAgentPackage, AgentPackageError } from "../lib/agent-package.js";

function makeFetch(
  status: number,
  body: unknown,
  opts: { contentType?: string; ok?: boolean } = {},
): typeof fetch {
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return vi.fn(async () =>
    ({
      ok,
      status,
      statusText: status === 200 ? "OK" : "Server Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers({ "content-type": opts.contentType ?? "application/json" }),
    }) as unknown as Response,
  );
}

describe("fetchAgentPackage", () => {
  it("returns the parsed package on a 200", async () => {
    const fakePkg = {
      system_prompt: "You are PCC's onboarding assistant.",
      tools: [
        {
          name: "pcc_list_capabilities",
          description: "List capabilities",
          input_schema: { type: "object", properties: {} },
          endpoint: { method: "GET", path: "/api/capabilities" },
        },
      ],
    };
    const fetchFn = makeFetch(200, fakePkg);
    const pkg = await fetchAgentPackage("https://capability.network", fetchFn);
    expect(pkg.tools.length).toBe(1);
    expect(pkg.tools[0].name).toBe("pcc_list_capabilities");
    expect(pkg.system_prompt).toContain("PCC");
  });

  it("strips trailing slash from the gateway URL", async () => {
    const fakePkg = { system_prompt: "x", tools: [] };
    const fetchFn = vi.fn(async () =>
      ({ ok: true, status: 200, statusText: "OK", json: async () => fakePkg, text: async () => "" }) as Response,
    );
    await fetchAgentPackage("https://capability.network///", fetchFn);
    const calledWith = (fetchFn.mock.calls[0]?.[0] as string) ?? "";
    expect(calledWith).toBe("https://capability.network/agent-package.json");
  });

  it("throws AgentPackageError on a non-2xx response", async () => {
    const fetchFn = makeFetch(503, { error: "unavailable" }, { ok: false });
    await expect(fetchAgentPackage("https://capability.network", fetchFn)).rejects.toBeInstanceOf(
      AgentPackageError,
    );
  });

  it("throws AgentPackageError when the body lacks system_prompt", async () => {
    const fetchFn = makeFetch(200, { tools: [] });
    await expect(fetchAgentPackage("https://capability.network", fetchFn)).rejects.toBeInstanceOf(
      AgentPackageError,
    );
  });

  it("throws AgentPackageError when tools is not an array", async () => {
    const fetchFn = makeFetch(200, { system_prompt: "ok", tools: "not-an-array" });
    await expect(fetchAgentPackage("https://capability.network", fetchFn)).rejects.toBeInstanceOf(
      AgentPackageError,
    );
  });

  it("wraps a network error in AgentPackageError", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(fetchAgentPackage("http://nowhere", fetchFn)).rejects.toBeInstanceOf(
      AgentPackageError,
    );
  });
});
