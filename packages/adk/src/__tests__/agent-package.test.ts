import { describe, it, expect } from "vitest";
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

  it("encodes path parameters so a value cannot change the route", () => {
    const req = resolveToolRequest("get_kernel", { kernelId: "a/b?c#d" }, { baseUrl: GW });
    expect(req.url).toBe("https://capability.network/api/kernels/a%2Fb%3Fc%23d");
    for (const kernelId of ["..", ".", ""]) {
      expect(errorCode(() => resolveToolRequest("get_kernel_jobs", { kernelId }, { baseUrl: GW }))).toBe("bad_path_param");
    }
  });

  it("refuses a tool whose endpoint is not a gateway path (the localhost class, N50)", () => {
    expect(AGENT_TOOLS.pcc_generate_ui.path).toMatch(/^http:\/\/localhost/);
    expect(errorCode(() => resolveToolRequest("pcc_generate_ui", { template: "x" }, { baseUrl: GW }))).toBe(
      "not_a_gateway_path",
    );
  });

  it("refuses unknown tools and missing required input", () => {
    expect(errorCode(() => resolveToolRequest("no_such_tool", {}, { baseUrl: GW }))).toBe("unknown_tool");
    expect(errorCode(() => resolveToolRequest("setup_validate", {}, { baseUrl: GW }))).toBe("missing_input");
    expect(errorCode(() => resolveToolRequest("get_kernel", {}, { baseUrl: GW }))).toBe("missing_input");
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
