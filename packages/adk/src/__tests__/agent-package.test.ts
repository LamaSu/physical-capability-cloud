import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENT_PACKAGE_PIN,
  AGENT_TOOLS,
  AdkToolError,
  checkAgentPackage,
  resolveToolRequest,
} from "../agent-package.js";
// The generator is plain ESM; vitest imports it directly.
import { renderPin, SOURCE, TARGET } from "../../scripts/generate-agent-pin.mjs";

const GW = "https://capability.network";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AdkToolError ? e.code : `not-AdkToolError: ${String(e)}`;
  }
  return undefined;
}

async function withPinnedTools(
  tools: Record<string, { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; required: string[] }>,
  check: (fresh: typeof import("../agent-package.js")) => void | Promise<void>,
): Promise<void> {
  vi.resetModules();
  vi.doMock("../generated/agent-pin.js", () => ({
    AGENT_TOOLS: tools,
    AGENT_PACKAGE_PIN: {
      schema: null,
      version: "fixture",
      toolCount: Object.keys(tools).length,
      sha256: `sha256:${"0".repeat(64)}`,
    },
  }));
  try {
    await check(await import("../agent-package.js"));
  } finally {
    vi.doUnmock("../generated/agent-pin.js");
    vi.resetModules();
  }
}

describe("the pinned agent package", () => {
  it("is generated from the package the dashboard serves, byte for byte", () => {
    expect(readFileSync(TARGET, "utf8")).toBe(renderPin(readFileSync(SOURCE)));
  });

  it("pins every tool once", () => {
    expect(Object.keys(AGENT_TOOLS)).toHaveLength(AGENT_PACKAGE_PIN.toolCount);
    expect(AGENT_PACKAGE_PIN.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("matches the live bytes, and notices any change", async () => {
    const text = readFileSync(SOURCE, "utf8");
    const same = await checkAgentPackage(text);
    expect(same.matches).toBe(true);
    expect(same.live.version).toBe(AGENT_PACKAGE_PIN.version);
    expect(same.live.toolCount).toBe(AGENT_PACKAGE_PIN.toolCount);

    const changed = await checkAgentPackage(text.replace('"tools"', '"tools" ').trimEnd() + "\n ");
    expect(changed.matches).toBe(false);

    const garbage = await checkAgentPackage("<html>not json</html>");
    expect(garbage).toMatchObject({ matches: false, live: { version: null, toolCount: null } });
  });
});

describe("resolveToolRequest", () => {
  it("sends a POST tool's input as a JSON body", () => {
    expect(resolveToolRequest("setup_validate", { config: { kernelId: "k" } }, { baseUrl: GW })).toEqual({
      method: "POST",
      url: "https://capability.network/api/setup/validate",
      body: '{"config":{"kernelId":"k"}}',
    });
  });

  it("fills path parameters and sends the rest of a GET as a sorted query", () => {
    expect(resolveToolRequest("get_kernel_jobs", { kernelId: "kernel-1", status: "queued", limit: 5 }, { baseUrl: `${GW}/` })).toEqual({
      method: "GET",
      url: "https://capability.network/api/kernels/kernel-1/jobs?limit=5&status=queued",
    });
  });

  it("refuses a path parameter that could change the route", () => {
    // 101b: refused outright, not encoded, so no intermediary that decodes the path can change the route.
    expect(errorCode(() => resolveToolRequest("get_kernel", { kernelId: "a/b?c#d" }, { baseUrl: GW }))).toBe("bad_path_param");
    for (const kernelId of ["..", ".", ""]) {
      expect(errorCode(() => resolveToolRequest("get_kernel_jobs", { kernelId }, { baseUrl: GW }))).toBe("bad_path_param");
    }
  });

  it("refuses a tool whose endpoint is not a gateway path (the localhost class, N50)", () => {
    return withPinnedTools(
      {
        local_ui: { method: "POST", path: "http://localhost:3200/api/generate", required: [] },
        remote_ui: { method: "GET", path: "https://tools.example.test/api/generate", required: [] },
      },
      (fresh) => {
        for (const name of ["local_ui", "remote_ui"]) {
          let failure: unknown;
          try {
            fresh.resolveToolRequest(name, {}, { baseUrl: GW });
          } catch (e) {
            failure = e;
          }
          expect(failure, name).toBeInstanceOf(fresh.AdkToolError);
          expect((failure as InstanceType<typeof fresh.AdkToolError>).code, name).toBe("not_a_gateway_path");
        }
      },
    );
  });

  it("refuses unknown tools and missing required input", () => {
    expect(errorCode(() => resolveToolRequest("no_such_tool", {}, { baseUrl: GW }))).toBe("unknown_tool");
    expect(errorCode(() => resolveToolRequest("setup_validate", {}, { baseUrl: GW }))).toBe("missing_input");
    expect(errorCode(() => resolveToolRequest("get_kernel", {}, { baseUrl: GW }))).toBe("missing_input");
  });

  it("treats names inherited from Object as unknown tools", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(errorCode(() => resolveToolRequest(name, {}, { baseUrl: GW }))).toBe("unknown_tool");
    }
  });

  it("accepts only a plain http(s) gateway base URL", () => {
    for (const baseUrl of ["javascript:alert(1)", "ftp://gw", "not a url", "https://u:p@gw", "https://gw/?x=1"]) {
      expect(errorCode(() => resolveToolRequest("get_depin_stats", {}, { baseUrl }))).toBe("bad_base_url");
    }
    expect(resolveToolRequest("get_depin_stats", {}, { baseUrl: "http://localhost:3000/pcc/" }).url).toBe(
      "http://localhost:3000/pcc/api/rewards",
    );
  });

  it("never attaches credentials", () => {
    const req = resolveToolRequest("setup_validate", { config: {} }, { baseUrl: GW });
    expect(Object.keys(req).sort()).toEqual(["body", "method", "url"]);
  });
});
