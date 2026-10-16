import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../scaffolder.js";
import type { OnboardConfig } from "../types.js";

const jobId = "job-neutral-1";
const inputHash = `sha256:${"ab".repeat(32)}`;

function machineConfig(type: "liquid-handler" | "fdm" = "liquid-handler"): OnboardConfig {
  return {
    kernel: {
      kernelId: "kernel_neutral_test", name: "Neutral Lab", location: { lat: 0, lng: 0 },
      walletPrivateKeyEnvVar: "TEST_KERNEL_KEY", gatewayUrl: "http://gateway.test", httpPort: 3100,
    },
    adapters: [{
      adapterId: "dev-liquid-01", className: "LiquidAdapter", adapterType: "machine", protocol: "http",
      connectionString: "http://device.test", deviceType: "controller", firmwareVersion: "Test-1.0.0",
      endpoints: [
        { method: "GET", path: "/status", purpose: "status", description: "Status" },
        { method: "POST", path: "/stage", purpose: "load_program", description: "Stage input without actuation" },
        { method: "POST", path: "/run", purpose: "start", description: "Run staged input" },
      ],
    }],
    capabilities: [{
      type, name: "Liquid handling", materials: ["water"], assuranceTiers: [0, 1, 2],
      pricing: { currency: "USDC", baseCost: "1.00", perMinute: "0.10", minimum: "1.00" },
      adapterId: "dev-liquid-01",
    }],
  };
}

function generated(config = machineConfig()): { adapter: string; tests: string } {
  const { files } = scaffold({ config });
  const adapter = files.find((file) => file.path === "src/adapters/liquid-adapter.ts");
  const tests = files.find((file) => file.path === "src/__tests__/adapters.test.ts");
  if (!adapter || !tests) throw new Error("Expected the adapter and starter test files");
  return { adapter: adapter.content, tests: tests.content };
}

interface Event {
  type: string;
  payload: Record<string, unknown>;
}

interface AdapterLike {
  readonly accepts?: readonly string[];
  execute(command: { type: string; payload?: Record<string, unknown> }): Promise<{
    success: boolean;
    data?: Record<string, unknown>;
    message?: string;
  }>;
  getStatus(): Promise<string>;
  onEvidence(callback: (event: Event) => void): void;
  dispose(): Promise<void>;
}

const scratchDirs: string[] = [];
const adapters: AdapterLike[] = [];

/** Import the actual generated TypeScript, as the scaffolded sensor tests do. */
async function neutralAdapter(mockMode = true): Promise<{ adapter: AdapterLike; events: Event[] }> {
  const dir = mkdtempSync(join(tmpdir(), "g1b-scaffold-neutral-"));
  scratchDirs.push(dir);
  const path = join(dir, "liquid-adapter.ts");
  writeFileSync(path, generated().adapter);
  const { LiquidAdapter } = await import(path) as {
    LiquidAdapter: new (id: string, config: { baseUrl: string; mockMode: boolean }) => AdapterLike;
  };
  const adapter = new LiquidAdapter("dev-liquid-01", { baseUrl: "http://device.test", mockMode });
  adapters.push(adapter);
  const events: Event[] = [];
  adapter.onEvidence((event) => events.push(event));
  return { adapter, events };
}

const fetchStub = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
  ok: true, status: 200, json: async () => ({}), text: async () => "{}",
}) as Response);

beforeEach(() => {
  vi.useFakeTimers();
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("capability-class scaffolding", () => {
  it("S1: generates the capability's neutral class, complete accepts, and neutral starter tests", () => {
    const { adapter, tests } = generated();
    expect(adapter).toContain('readonly type = "liquid-handler" as const');
    expect(adapter).toContain('readonly accepts = ["prepare", "start", "stop", "status"] as const');
    expect(adapter).not.toMatch(/gcode/i);
    expect(adapter).not.toMatch(/fdm/i);
    expect(tests).not.toMatch(/gcode/i);
    expect(tests).not.toMatch(/fdm/i);
  });

  it("S2: mock prepare acknowledges exact input identity without evidence, fetch, or state change", async () => {
    const { adapter, events } = await neutralAdapter();
    const result = await adapter.execute({ type: "prepare", payload: { jobId, inputHash } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ jobId, inputHash, deviceJobId: expect.any(String) });
    expect(result.data?.deviceJobId).not.toBe("");
    expect(events).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(0);
    expect(await adapter.getStatus()).toBe("idle");
  });

  it.each([
    ["missing jobId", { inputHash }],
    ["empty jobId", { jobId: "", inputHash }],
    ["short hash", { jobId, inputHash: "sha256:abc" }],
    ["upper-case hex", { jobId, inputHash: `sha256:${"AB".repeat(32)}` }],
  ])("S3: refuses prepare with %s without evidence or fetch", async (_name, payload) => {
    const { adapter, events } = await neutralAdapter();
    expect((await adapter.execute({ type: "prepare", payload })).success).toBe(false);
    expect(events).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  it("S4: refuses start before prepare without evidence or fetch", async () => {
    const { adapter, events } = await neutralAdapter();
    expect((await adapter.execute({ type: "start", payload: { jobId } })).success).toBe(false);
    expect(events).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  it("S4: refuses start for another jobId without evidence or fetch", async () => {
    const { adapter, events } = await neutralAdapter();
    await adapter.execute({ type: "prepare", payload: { jobId, inputHash } });
    expect((await adapter.execute({ type: "start", payload: { jobId: "job-another" } })).success).toBe(false);
    expect(events).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  it("S4: staged mock start binds execution_started to the acknowledged device job", async () => {
    const { adapter, events } = await neutralAdapter();
    const ack = await adapter.execute({ type: "prepare", payload: { jobId, inputHash } });
    expect(ack.success).toBe(true);
    expect(typeof ack.data?.deviceJobId).toBe("string");
    expect((await adapter.execute({ type: "start", payload: { jobId } })).success).toBe(true);
    expect(events).toEqual([expect.objectContaining({
      type: "execution_started", payload: { deviceJobId: ack.data?.deviceJobId },
    })]);
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  it.each(["pause", "load_gcode"])("S5: refuses undeclared command %s without evidence or fetch", async (type) => {
    const { adapter, events } = await neutralAdapter();
    expect((await adapter.execute({ type })).success).toBe(false);
    expect(events).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  it("S6: real prepare posts only to staging and start subsequently posts to run", async () => {
    const { adapter, events } = await neutralAdapter(false);
    const ack = await adapter.execute({ type: "prepare", payload: { jobId, inputHash } });
    expect(ack.success).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [stageUrl, stageRequest] = fetchStub.mock.calls[0]!;
    expect(stageUrl).toBe("http://device.test/stage");
    expect(stageRequest?.method).toBe("POST");
    expect(JSON.parse(stageRequest?.body as string)).toEqual({ jobId, inputHash });
    expect(events).toEqual([]);
    expect((await adapter.execute({ type: "start", payload: { jobId } })).success).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[1]?.[0]).toBe("http://device.test/run");
    expect(fetchStub.mock.calls[1]?.[1]?.method).toBe("POST");
  });

  it("S7: preserves the explicit FDM class, commands, event, and starter assertion", () => {
    const { adapter, tests } = generated(machineConfig("fdm"));
    expect(adapter).toContain('readonly type = "fdm" as const');
    expect(adapter).toContain('readonly accepts = ["load_gcode", "start", "stop", "status"] as const');
    expect(adapter).toContain('case "load_gcode"');
    expect(adapter).toContain('type: "gcode_received"');
    expect(tests).toMatch(/expect\([^\n]*\.type\)\.toBe\("gcode_received"\)/);
  });

  it("S8: refuses a machine adapter with no capability class and names the adapter", () => {
    const config = machineConfig();
    config.capabilities = [];
    expect(() => scaffold({ config })).toThrow(/dev-liquid-01/);
    expect(() => scaffold({ config })).toThrow(/add exactly one capability class/i);
  });

  it("S8: refuses ambiguous machine classes and names the adapter and every class", () => {
    const config = machineConfig();
    config.capabilities.push({ ...config.capabilities[0]!, type: "hplc" });
    expect(() => scaffold({ config })).toThrow(/dev-liquid-01/);
    expect(() => scaffold({ config })).toThrow(/liquid-handler/);
    expect(() => scaffold({ config })).toThrow(/hplc/);
  });

  it("S8: multiple capabilities of the same class still determine one machine class", () => {
    const config = machineConfig();
    config.capabilities.push({ ...config.capabilities[0]!, name: "Second liquid capability" });
    expect(generated(config).adapter).toContain('readonly type = "liquid-handler" as const');
  });

  it("S8: sensor-only configurations need no capability class", () => {
    const config = machineConfig();
    config.adapters = [{ ...config.adapters[0]!, adapterType: "sensor", deviceType: "sensor" }];
    config.capabilities = [];
    expect(scaffold({ config }).files.some((file) => file.path === "src/adapters/liquid-adapter.ts")).toBe(true);
  });

  it("S9: the guide teaches the neutral contract and its machine example implements prepare", () => {
    const guide = readFileSync(new URL("../../AGENT_INSTRUCTIONS.md", import.meta.url), "utf8");
    for (const term of ["prepare", "accepts", "deviceJobId", "compileTierLadder", "method_loaded"]) {
      expect(guide).toContain(term);
    }
    expect(guide).toMatch(/adapters never emit [`]*method_loaded[`]*/i);
    const section = guide.match(/^### 2\.1\b[\s\S]*?(?=^### 2\.2\b)/m)?.[0];
    expect(section).toBeDefined();
    const code = section?.match(/```typescript\n([\s\S]*?)```/)?.[1];
    expect(code).toContain('case "prepare"');
    expect(code).not.toContain('case "load_gcode"');
  });
});
