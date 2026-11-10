/** Q14: every shipped machine adapter stays on the legacy command path. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { compileTierLadder, type CSD, type TierLadderV1 } from "@pcc/spec";
import { createMachineAdapter, listRegisteredMachineAdapters } from "../adapter-factory.js";
import type { MachineAdapter, MachineCommand } from "../adapters/types.js";
import { HamiltonAdapter } from "../adapters/hamilton-adapter.js";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { MockFDMAdapter } from "../adapters/mock-fdm.js";
import { OctoPrintAdapter } from "../adapters/octoprint-adapter.js";
import { OPCUAAdapter } from "../adapters/opcua-adapter.js";
import { OpentronsMachineAdapter } from "../opentrons/adapter.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner, type JobConfig } from "../job-runner.js";
import type { DeviceConfig } from "../kernel-config.js";
import { FakeDevice } from "../testing/fake-device.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

const SHIPPED = [
  ["hamilton", HamiltonAdapter],
  ["ipp", IppAdapter],
  ["mock", MockFDMAdapter],
  ["octoprint", OctoPrintAdapter],
  ["opcua", OPCUAAdapter],
  ["opentrons", OpentronsMachineAdapter],
] as const;

let sequence = 0;
function build(adapterType: DeviceConfig["adapterType"]): MachineAdapter {
  return createMachineAdapter({
    id: `neutral-shipped-${adapterType}-${++sequence}`,
    type: "machine",
    adapterType,
    config: { mockMode: true },
  });
}

const fixtureCsd = {
  url: "pcc://capabilities/test-liquid-transfer/v1",
  evidence: {
    tier0: {
      description: "Kernel-signed input and completion",
      required: ["method_loaded", "execution_completed"],
      primitives: [{ id: "receipt.kernel_signed", bind: "execution_completed" }],
    },
    tier1: {
      description: "Instrument result",
      required: ["method_loaded", "execution_completed", "instrument_result"],
      primitives: [{ id: "receipt.kernel_signed", bind: "execution_completed" }],
    },
    tier2: {
      description: "Calibrated instrument result",
      required: ["method_loaded", "execution_completed", "instrument_result", "calibration_record"],
      primitives: [{ id: "receipt.kernel_signed", bind: "execution_completed" }],
    },
  },
} as unknown as CSD;

let ladder: TierLadderV1;
beforeAll(async () => {
  vi.useRealTimers();
  ladder = await compileTierLadder(fixtureCsd);
  expect(ladder.tiers.map((tier) => tier.tier)).toStrictEqual([0, 1, 2]);
});

describe("neutral commands: shipped adapters remain legacy", () => {
  it("H1 pins the exact registered machine adapters and refuses generic-http", () => {
    expect(listRegisteredMachineAdapters().sort()).toStrictEqual([
      "generic-http", "hamilton", "ipp", "mock", "octoprint", "opcua", "opentrons",
    ]);
    expect(() => build("generic-http")).toThrow();
  });

  it.each(SHIPPED)("H2 %s declares no accepts and receives only legacy load_gcode", async (adapterType, constructor) => {
    const adapter = build(adapterType);
    try {
      expect(adapter.constructor).toBe(constructor);
      expect("accepts" in adapter).toBe(false);
      const execute = vi.spyOn(adapter, "execute").mockResolvedValue({ success: false, message: "stopped by the test" });
      const inputData = new Uint8Array([1, 3, 5, 7]);
      const inputHash = `sha256:${createHash("sha256").update(inputData).digest("hex")}`;
      const jobId = `job-${adapter.id}`;
      const config = {
        jobId, stepId: "step", inputHash, inputData, tierLadder: ladder, assuranceTier: 2,
      } as unknown as JobConfig;
      const emitter = new EvidenceEmitter(`kernel-${adapter.id}`);
      const result = await new JobRunner(adapter, [], null, emitter).run(config);
      expect(result.success).toBe(false);
      expect(execute.mock.calls.map(([command]) => command)).toStrictEqual([
        { type: "load_gcode", payload: { gcodeHash: inputHash, jobId } },
      ]);
    } finally {
      await adapter.dispose();
    }
  });

  it.each(SHIPPED)("H3 direct prepare on %s emits no evidence and names no staged device job", async (adapterType) => {
    const adapter = build(adapterType);
    try {
      const evidence = vi.fn();
      adapter.onEvidence(evidence);
      // Some legacy default branches return success:true for unknown commands.
      // The prepare ack's exact echoes and deviceJobId make that harmless.
      const result = await adapter.execute({
        type: "prepare",
        payload: { jobId: `job-${adapter.id}`, inputHash: `sha256:${"ab".repeat(32)}` },
      } as unknown as MachineCommand);
      await adapter.quiesceEvidence();
      expect(evidence).not.toHaveBeenCalled();
      expect(result.data?.deviceJobId).toBeUndefined();
    } finally {
      await adapter.dispose();
    }
  });

  it("H4 pins every MachineAdapter class across all source directories", async () => {
    const src = fileURLToPath(new URL("../", import.meta.url));
    const scanned = readdirSync(src, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => path.endsWith(".ts") && !path.split("/").includes("__tests__"));
    expect(scanned).toContain("adapters/mock-fdm.ts");
    expect(scanned).toContain("opentrons/adapter.ts");
    const classes = new Set<string>();
    const fakeDeviceFiles: string[] = [];
    for (const path of scanned) {
      const source = readFileSync(join(src, path), "utf8");
      const declarations = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)[^{]*\bimplements\b[^{]*\bMachineAdapter\b/gm;
      for (const match of source.matchAll(declarations)) {
        // The one exemption: FakeDevice ships only through @pcc/kernel/testing, never the factory. H4b holds it to H2 and H3.
        if (match[1] === FakeDevice.name) fakeDeviceFiles.push(path);
        else classes.add(match[1]!);
      }
    }
    expect(fakeDeviceFiles).toStrictEqual(["testing/fake-device.ts"]);
    expect([...classes].sort()).toStrictEqual(SHIPPED.map(([, constructor]) => constructor.name).sort());
    const adapters = SHIPPED.map(([type]) => build(type));
    try {
      // Each scanned class is the actual constructor of an H2 factory adapter.
      expect(adapters.map((adapter) => adapter.constructor.name).sort()).toStrictEqual([...classes].sort());
      expect(adapters.map((adapter) => adapter.constructor)).toStrictEqual(SHIPPED.map(([, constructor]) => constructor));
    } finally {
      await Promise.all(adapters.map((adapter) => adapter.dispose()));
    }
  });

  it("H4b FakeDevice declares no accepts, refuses prepare and receives only legacy load_gcode", async () => {
    expect(() => new FakeDevice("neutral-shipped-fake-prepare", "kernel-neutral-shipped", { declaredCommands: ["prepare"] }))
      .toThrow("invalid declaredCommands");
    // Every command FakeDevice can declare, so no configuration reaches the neutral path.
    const device = new FakeDevice("neutral-shipped-fake-device", "kernel-neutral-shipped", {
      declaredCommands: ["load_gcode", "start", "pause", "resume", "stop", "status"],
    });
    try {
      expect("accepts" in device).toBe(false);
      const evidence = vi.fn();
      device.onEvidence(evidence);
      // As in H3: a direct prepare emits no evidence and names no staged device job.
      expect(await device.execute({
        type: "prepare",
        payload: { jobId: `job-${device.id}`, inputHash: `sha256:${"ab".repeat(32)}` },
      })).toStrictEqual({ success: false, message: "undeclared command: prepare" });
      await device.quiesceEvidence();
      expect(evidence).not.toHaveBeenCalled();
      // As in H2: JobRunner sends only the legacy load_gcode.
      const execute = vi.spyOn(device, "execute").mockResolvedValue({ success: false, message: "stopped by the test" });
      const inputData = new Uint8Array([1, 3, 5, 7]);
      const inputHash = `sha256:${createHash("sha256").update(inputData).digest("hex")}`;
      const jobId = `job-${device.id}`;
      const config = {
        jobId, stepId: "step", inputHash, inputData, tierLadder: ladder, assuranceTier: 2,
      } as unknown as JobConfig;
      const result = await new JobRunner(device, [], null, new EvidenceEmitter(`kernel-${device.id}`)).run(config);
      expect(result.success).toBe(false);
      expect(execute.mock.calls.map(([command]) => command)).toStrictEqual([
        { type: "load_gcode", payload: { gcodeHash: inputHash, jobId } },
      ]);
    } finally {
      await device.dispose();
    }
  });
});
