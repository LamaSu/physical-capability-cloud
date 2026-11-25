import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import type { A2AMessage, MessageBus } from "@pcc/a2a";
import type { KernelAgent } from "@pcc/agent-kernel";
import { scaffold } from "../scaffolder.js";

type OnboardConfig = Parameters<typeof scaffold>[0]["config"];
const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const example = (): OnboardConfig => JSON.parse(readFileSync(join(packageDir, "src/examples/cnc-shop-config.json"), "utf8"));
const fdmExample = (): OnboardConfig => {
  const config = example();
  config.capabilities[0].type = "fdm";
  config.profiles![0].capabilityType = "fdm";
  return config;
};
const directories: string[] = [];
const requests: string[] = [];

function project(config: OnboardConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "pcc-agent-run-"));
  directories.push(dir);
  symlinkSync(join(packageDir, "node_modules"), join(dir, "node_modules"), "junction");
  for (const file of scaffold({ config }).files.filter(f => f.path.startsWith("src/"))) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  return dir;
}

beforeAll(() => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return Promise.resolve(new Response("{}", { status: 503 }));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

type Slot = { constructor: { name: string }; config?: { mockMode?: boolean } };
async function run(config: OnboardConfig, mode: string | undefined, { job = false } = {}) {
  const names = ["MOCK_MODE", "GATEWAY_URL", "UNBROWSE_URL", "NATS_URL", "PCC_MESSAGE_BUS_BACKEND", config.kernel.walletPrivateKeyEnvVar];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  const listeners = new Set(process.listeners("SIGINT"));
  let kernelAgent: KernelAgent | undefined;
  let slots: { machine: string; sensors: string[]; camera: string; mockMode: Array<boolean | undefined> };
  let intent: A2AMessage["intent"] | undefined;
  const logs: string[] = [];
  try {
    if (mode === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = mode;
    process.env.GATEWAY_URL = "http://gateway.test";
    for (const name of names.slice(2)) delete process.env[name];
    const dir = project(config);
    requests.length = 0;
    const spy = vi.spyOn(console, "log").mockImplementation((first) => { logs.push(String(first)); });
    let loaded: { kernelAgent: KernelAgent; bus: MessageBus };
    try {
      loaded = await import(join(dir, "src/agent.ts"));
      kernelAgent = loaded.kernelAgent;
    } finally {
      spy.mockRestore();
    }
    const { machine, sensors, camera } = kernelAgent as unknown as { machine: Slot; sensors: Slot[]; camera: Slot };
    slots = {
      machine: machine.constructor.name,
      sensors: sensors.map(sensor => sensor.constructor.name),
      camera: camera.constructor.name,
      mockMode: [machine, ...sensors, camera].map(slot => slot.config?.mockMode),
    };
    if (job) {
      kernelAgent.setPolicy({
        ...DEFAULT_OPERATOR_POLICY,
        approvalMode: "auto",
        operatingHours: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const terminal = new Promise<A2AMessage["intent"]>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("No job_completed or error message within 40 seconds")), 40000);
        loaded.bus.subscribe("agent_e2e_requester", message => {
          if (message.intent.type === "job_completed" || message.intent.type === "error") resolve(message.intent);
        });
      });
      try {
        await loaded.bus.send({
          id: "msg_e2e_1",
          conversationId: "conv_e2e_1",
          from: "agent_e2e_requester",
          to: kernelAgent.id,
          intent: {
            type: "execute_job",
            jobId: "job_e2e_1",
            stepId: "step_e2e_1",
            capabilityType: config.capabilities[0].type,
          },
          timestamp: new Date().toISOString(),
        });
        intent = await terminal;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    try {
      kernelAgent?.stop();
    } finally {
      for (const listener of process.listeners("SIGINT")) {
        if (!listeners.has(listener)) process.removeListener("SIGINT", listener);
      }
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
  return { slots, intent, logs, requests: [...requests] };
}

const noDeviceRequest = (urls: string[]) => {
  expect(urls.filter(url => !url.startsWith("http://gateway.test"))).toEqual([]);
};

describe("scaffold agent execution", () => {
  it("E1 the example completes a mock-mode job without a device request", async () => {
    const result = await run(example(), "true", { job: true });
    expect(result.intent?.type).toBe("job_completed");
    noDeviceRequest(result.requests);
  }, 60000);

  it("E1b an fdm machine completes a mock-mode job without a device request", async () => {
    const result = await run(fdmExample(), "true", { job: true });
    expect(result.intent?.type).toBe("job_completed");
    noDeviceRequest(result.requests);
  }, 60000);

  it("E2 only the exact true mode selects PCC mocks in every slot", async () => {
    for (const mode of ["true", undefined, "1", "TRUE", "false"]) {
      const { slots } = await run(example(), mode);
      expect([slots.machine, slots.sensors, slots.camera], String(mode)).toEqual(mode === "true"
        ? ["MockFDMAdapter", ["MockPowerMonitorAdapter"], "MockCameraAdapter"]
        : ["HaasVF2Adapter", ["ShopPowerMeter"], "QCCamera"]);
      if (mode !== "true") expect(slots.mockMode, String(mode)).toEqual([false, false, false]);
    }
  }, 60000);

  it("E3 a prepare-path job is refused until KernelAgent supplies its inputs", async () => {
    const result = await run(example(), undefined, { job: true });
    expect(result.intent).toMatchObject({
      type: "error",
      code: "job_failed",
      message: expect.stringContaining("inputHash must be sha256: followed by 64 lowercase hex digits"),
    });
    noDeviceRequest(result.requests);
  }, 60000);

  it("E4 the banner names the slots that run and explains prepare-path refusal", async () => {
    for (const [fixture, mode] of [
      [example, "true"], [fdmExample, "true"], [example, undefined], [example, "false"], [fdmExample, undefined],
    ] as const) {
      const { logs } = await run(fixture(), mode);
      const lines = logs.filter(line => /^  (Machine|Sensors|Camera|Mock mode):/.test(line));
      expect(lines, `${fixture.name}, ${mode}`).toEqual(mode === "true" ? [
        "  Machine: PCC mock (MOCK_MODE=true)",
        "  Sensors: PCC mock (MOCK_MODE=true)",
        "  Camera: PCC mock (MOCK_MODE=true)",
        "  Mock mode: true",
      ] : [
        "  Machine: HaasVF2Adapter (dev-haas-vf2)" + (fixture === example
          ? "; its jobs are refused until KernelAgent passes inputHash, inputData and tierLadder" : ""),
        "  Sensors: ShopPowerMeter (dev-power-meter)",
        "  Camera: QCCamera (dev-qc-camera)",
        "  Mock mode: false",
      ]);
    }
  }, 60000);

  it("E6 every MOCK_MODE read compares strictly to the text true", () => {
    for (const fixture of [example, fdmExample]) {
      let agentReads = 0;
      for (const file of scaffold({ config: fixture() }).files.filter(f => f.path.endsWith(".ts"))) {
        const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node): void {
          const read = (ts.isPropertyAccessExpression(node) && node.getText() === "process.env.MOCK_MODE")
            || (ts.isElementAccessExpression(node) && node.expression.getText() === "process.env"
              && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "MOCK_MODE");
          if (read) {
            if (file.path === "src/agent.ts") agentReads++;
            const parent = node.parent;
            expect(ts.isBinaryExpression(parent) && parent.left === node
              && parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
              && ts.isStringLiteral(parent.right) && parent.right.text === "true",
            `${fixture.name}: ${file.path}: ${node.getText()}`).toBe(true);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
      expect(agentReads, fixture.name).toBeGreaterThan(0);
    }
  }, 60000);
});
