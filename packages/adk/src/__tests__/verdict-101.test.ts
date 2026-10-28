import { describe, it, expect, vi } from "vitest";
import * as adk from "../index.js";
import { AGENT_PACKAGE_PIN, AGENT_TOOLS, checkAgentPackage, resolveToolRequest } from "../agent-package.js";
// The generator is plain ESM; vitest imports it directly.
import { renderPin } from "../../scripts/generate-agent-pin.mjs";

const GW = "https://capability.network";

/** The AdkToolError code `fn` throws. By name, so a freshly imported module's class counts too. */
function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof Error && e.name === "AdkToolError" ? (e as Error & { code: string }).code : `other: ${String(e)}`;
  }
  return undefined;
}

/** Bytes of a minimal agent package with these tools. */
function pkgBytes(tools: unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ schema: "pcc-agent-package/2.0", version: "9.9.9", tools }));
}
const tool = (name: string, method: string, path: string, required: unknown = []) => ({
  name,
  endpoint: { method, path },
  input_schema: { type: "object", required },
});
function renderError(tools: unknown[]): string | undefined {
  try {
    renderPin(pkgBytes(tools));
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  return undefined;
}

describe("verdict 101 F1: the pin and the routing table cannot be changed at runtime", () => {
  it("exports deeply frozen values: the pin, the table, every endpoint record and every required list", () => {
    expect(Object.isFrozen(AGENT_PACKAGE_PIN)).toBe(true);
    expect(Object.isFrozen(AGENT_TOOLS)).toBe(true);
    for (const [name, endpoint] of Object.entries(AGENT_TOOLS)) {
      expect(Object.isFrozen(endpoint), name).toBe(true);
      expect(Object.isFrozen(endpoint.required), name).toBe(true);
    }
  });

  it("refuses the reviewer's rewrites and keeps resolving the pinned route", async () => {
    const money = { method: "POST", path: "/api/escrow/chain/target/fund", required: [] };
    expect(() => {
      (AGENT_TOOLS as any).get_kernel = money;
    }).toThrow(TypeError);
    expect(() => {
      (AGENT_TOOLS as any).brand_new_tool = money;
    }).toThrow(TypeError);
    expect(() => {
      (AGENT_TOOLS.get_kernel as any).path = money.path;
    }).toThrow(TypeError);
    expect(() => {
      (AGENT_TOOLS.setup_validate.required as any).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (AGENT_TOOLS.setup_validate.required as any).push("other");
    }).toThrow(TypeError);
    expect(resolveToolRequest("get_kernel", { kernelId: "k" }, { baseUrl: GW })).toEqual({
      method: "GET",
      url: `${GW}/api/kernels/k`,
    });
    expect(errorCode(() => resolveToolRequest("setup_validate", {}, { baseUrl: GW }))).toBe("missing_input");

    const hostile = JSON.stringify({ version: AGENT_PACKAGE_PIN.version, tools: [] });
    const first = await checkAgentPackage(hostile);
    expect(() => {
      (AGENT_PACKAGE_PIN as any).sha256 = first.live.sha256;
    }).toThrow(TypeError);
    expect((await checkAgentPackage(hostile)).matches).toBe(false);
  });

  it("resolves and checks against private copies, even if the generated module were not frozen", async () => {
    // A thawed stand-in for generated/agent-pin.ts. If the resolver or the
    // checker read the exported objects, the writes below would steer them.
    const tools: Record<string, any> = {
      get_kernel: { method: "GET", path: "/api/kernels/{kernelId}", required: ["kernelId"] },
    };
    const pin: Record<string, any> = { schema: null, version: "test", toolCount: 1, sha256: `sha256:${"0".repeat(64)}` };
    vi.resetModules();
    vi.doMock("../generated/agent-pin.js", () => ({ AGENT_TOOLS: tools, AGENT_PACKAGE_PIN: pin }));
    try {
      const fresh = await import("../agent-package.js");
      tools.get_kernel.method = "POST";
      tools.get_kernel.path = "/api/escrow/chain/target/fund";
      tools.get_kernel.required.length = 0;
      tools.added = { method: "POST", path: "/api/auth/keys", required: [] };
      const text = "{}";
      pin.sha256 = (await fresh.checkAgentPackage(text)).live.sha256;

      expect(fresh.resolveToolRequest("get_kernel", { kernelId: "k" }, { baseUrl: GW })).toEqual({
        method: "GET",
        url: `${GW}/api/kernels/k`,
      });
      expect(errorCode(() => fresh.resolveToolRequest("get_kernel", {}, { baseUrl: GW }))).toBe("missing_input");
      expect(errorCode(() => fresh.resolveToolRequest("added", {}, { baseUrl: GW }))).toBe("unknown_tool");
      expect((await fresh.checkAgentPackage(text)).matches).toBe(false);
    } finally {
      vi.doUnmock("../generated/agent-pin.js");
      vi.resetModules();
    }
  });
});

describe("verdict 101 F2/F3: the kit exports no key-sending client and no kernel handler", () => {
  it("does not export registerKernel or createKernelHandler (or their errors)", () => {
    for (const name of ["registerKernel", "KernelRegistrationError", "createKernelHandler", "KernelAuthError"]) {
      expect(Object.prototype.hasOwnProperty.call(adk, name), name).toBe(false);
    }
  });

  it("exports exactly the reviewed surface, so a new export is a reviewed change", () => {
    expect(Object.keys(adk).sort()).toEqual([
      "AGENT_PACKAGE_PIN",
      "AGENT_TOOLS",
      "AdkToolError",
      "buildManifest",
      "checkAgentPackage",
      "resolveToolRequest",
    ]);
  });
});

describe("verdict 101 F4: required input is checked on the same plain snapshot that is sent", () => {
  it("refuses an inherited required field instead of sending an empty body", () => {
    const inherited = Object.create({ config: {} });
    expect(errorCode(() => resolveToolRequest("setup_validate", inherited, { baseUrl: GW }))).toBe("bad_input");
  });

  it("refuses accessors, custom prototypes and toJSON anywhere in the input", () => {
    let reads = 0;
    const getter = {
      get config() {
        return reads++ === 0 ? {} : undefined;
      },
    };
    class Config {
      kernelId = "k";
    }
    const cases: Record<string, unknown>[] = [
      getter,
      { config: { toJSON: () => ({ swapped: true }) } },
      { config: new Config() },
      { config: new Date(0) },
      { config: { nested: [Object.create({ inheritedOnly: 1 })] } },
    ];
    for (const input of cases) {
      expect(errorCode(() => resolveToolRequest("setup_validate", input, { baseUrl: GW }))).toBe("bad_input");
    }
  });

  it("refuses values JSON cannot carry faithfully", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const values: unknown[] = [10n, () => 1, Symbol("s"), NaN, Infinity, [undefined], sparse, cyclic];
    for (const config of values) {
      expect(errorCode(() => resolveToolRequest("setup_validate", { config }, { baseUrl: GW }))).toBe("bad_input");
    }
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: {}, [Symbol("k")]: 1 }, { baseUrl: GW }))).toBe(
      "bad_input",
    );
    expect(errorCode(() => resolveToolRequest("setup_validate", null as any, { baseUrl: GW }))).toBe("bad_input");
    expect(errorCode(() => resolveToolRequest("setup_validate", [] as any, { baseUrl: GW }))).toBe("bad_input");
  });

  it("sends what it checked when a proxy reports different views", () => {
    // get() says config is there; ownKeys() says it is not. The old code checked
    // one view and sent the other.
    const lying = new Proxy(
      {},
      {
        get: (_t, key) => (key === "config" ? {} : undefined),
      },
    );
    expect(errorCode(() => resolveToolRequest("setup_validate", lying, { baseUrl: GW }))).toBe("missing_input");
  });

  it("sends the snapshot it checked, never a second read of the input", () => {
    // Descriptors say config is {a: 1}; get() says {a: 2}. The check read the
    // descriptors, so the body must carry {a: 1}.
    const twoFaced = new Proxy({ config: { a: 1 } }, { get: (_t, key) => (key === "config" ? { a: 2 } : undefined) });
    expect(resolveToolRequest("setup_validate", twoFaced, { baseUrl: GW }).body).toBe('{"config":{"a":1}}');
  });

  it("names a cycle as a cycle", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => resolveToolRequest("setup_validate", { config: cyclic }, { baseUrl: GW })).toThrow(/contains itself/);
  });

  it("still sends plain JSON exactly as JSON.stringify would, and drops undefined fields", () => {
    const config = { kernelId: "k", devices: [{ id: 1, on: true, tags: ["a", "b"] }], note: null, skip: undefined };
    const bare = Object.assign(Object.create(null), { config });
    for (const input of [{ config }, bare]) {
      expect(resolveToolRequest("setup_validate", input, { baseUrl: GW }).body).toBe(JSON.stringify({ config }));
    }
    expect(
      resolveToolRequest("get_kernel_jobs", { kernelId: "k", status: undefined, limit: 5 }, { baseUrl: GW }).url,
    ).toBe(`${GW}/api/kernels/k/jobs?limit=5`);
  });
});

/** Paths that start like a gateway path but that a URL parser would move, or that are malformed. */
const BAD_GATEWAY_PATHS = [
  "/api/safe/../auth/keys",
  "/api/safe/./keys",
  "/api/safe/%2e%2e/auth/keys",
  "/api/safe/.%2E/auth/keys",
  "/api/x?y=1",
  "/api/x#f",
  "/api\\x",
  "/api//x",
  "/api/x/",
  "/api/{bad-name}",
  "/api/x{thingId}",
  "/api/{thingId}/{thingId}",
  "/api/{thingId",
  "/api/ x",
];
/** Paths that are not gateway paths at all and not http(s) URLs. */
const NOT_PATHS = ["//evil.test/x", "api/x", "javascript:alert(1)"];

describe("verdict 101 F5: endpoint semantics are validated when generating and when resolving", () => {
  const ok = tool("get_thing", "GET", "/api/things/{thingId}", ["thingId"]);

  it("accepts the shapes the real package uses, including a non-gateway URL the resolver refuses", () => {
    expect(renderError([ok, tool("make_ui", "POST", "http://localhost:3200/api/generate")])).toBeUndefined();
  });

  it("refuses reserved, malformed and duplicate tool names", () => {
    for (const name of ["__proto__", "constructor", "prototype", "Has-Dash", "", "1st"]) {
      expect(renderError([tool(name, "GET", "/api/x")]), name).toMatch(/tool name/);
    }
    expect(renderError([ok, { ...ok }])).toMatch(/duplicate tool name/);
  });

  it("refuses unknown methods and malformed required lists", () => {
    expect(renderError([tool("a", "TRACE", "/api/x")])).toMatch(/method/);
    expect(renderError([tool("a", "GET", "/api/x", "thingId")])).toMatch(/required/);
    expect(renderError([tool("a", "GET", "/api/x", [1])])).toMatch(/required/);
  });

  it("refuses gateway paths that a URL parser would move, and malformed placeholders", () => {
    for (const path of [...BAD_GATEWAY_PATHS, ...NOT_PATHS]) {
      expect(renderError([tool("a", "GET", path)]), path).toMatch(/path/);
    }
  });

  it("refuses the same endpoints at call time, if one reaches the table, and agrees with the generator", async () => {
    const tools: Record<string, any> = {
      good: { method: "GET", path: "/api/things/{thingId}/parts", required: ["thingId"] },
      method: { method: "TRACE", path: "/api/x", required: [] },
    };
    BAD_GATEWAY_PATHS.forEach((path, i) => (tools[`bad_${i}`] = { method: "GET", path, required: [] }));
    NOT_PATHS.forEach((path, i) => (tools[`not_${i}`] = { method: "GET", path, required: [] }));
    vi.resetModules();
    vi.doMock("../generated/agent-pin.js", () => ({
      AGENT_TOOLS: tools,
      AGENT_PACKAGE_PIN: { schema: null, version: "t", toolCount: 0, sha256: `sha256:${"0".repeat(64)}` },
    }));
    try {
      const fresh = await import("../agent-package.js");
      const input = { thingId: "t-1", id: "1" };
      expect(fresh.resolveToolRequest("good", input, { baseUrl: GW }).url).toBe(`${GW}/api/things/t-1/parts?id=1`);
      expect(renderError([tool("good", "GET", tools.good.path, ["thingId"])])).toBeUndefined();
      expect(errorCode(() => fresh.resolveToolRequest("method", input, { baseUrl: GW }))).toBe("bad_tool_endpoint");
      BAD_GATEWAY_PATHS.forEach((path, i) => {
        expect(errorCode(() => fresh.resolveToolRequest(`bad_${i}`, input, { baseUrl: GW })), path).toBe("bad_tool_endpoint");
      });
      NOT_PATHS.forEach((path, i) => {
        expect(errorCode(() => fresh.resolveToolRequest(`not_${i}`, input, { baseUrl: GW })), path).toBe("not_a_gateway_path");
      });
    } finally {
      vi.doUnmock("../generated/agent-pin.js");
      vi.resetModules();
    }
  });

  it("builds URLs a client sends unchanged, IPv6 and base paths included", () => {
    // 101b: a path parameter holds only route-safe characters, so "k-1" rather than "k 1".
    expect(resolveToolRequest("get_kernel", { kernelId: "k-1" }, { baseUrl: "http://[::1]:3000/pcc/" }).url).toBe(
      "http://[::1]:3000/pcc/api/kernels/k-1",
    );
  });
});
