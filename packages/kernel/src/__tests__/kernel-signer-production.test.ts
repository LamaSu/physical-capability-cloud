import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import { signingPreimage, type EvidenceBundle } from "@pcc/spec";
import nacl from "tweetnacl";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import { EvidenceEmitter, EvidenceSignerRequiredError } from "../evidence-emitter.js";
import type { EvidenceStorageService } from "../evidence-storage.js";
import { JobRunner } from "../job-runner.js";
import { createIppPrintKernel, makeKernelEd25519Signer, runPrintJob } from "../printer-job.js";
import { isStepLeased } from "../step-lease.js";
import { FakeDevice } from "../testing/fake-device.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

const requiredMessage = "kernel_signer_required: in production this kernel runs no job and signs no bundle with the test-only key. Build its EvidenceEmitter with a real signing function.";
const job = { jobId: "signer-job", stepId: "signer-step", gcodeHash: `sha256:${"ab".repeat(32)}` as const, assuranceTier: 0 as const };

function completingDevice(): FakeDevice {
  const device = new FakeDevice("signer-device", "k", { declaredCommands: ["load_gcode", "start", "stop", "status"] });
  device.scriptStart({ outcome: "accept", deviceJobId: "device-job" });
  const execute = device.execute.bind(device);
  vi.spyOn(device, "execute").mockImplementation(async (command) => {
    const result = await execute(command);
    if (command.type === "start" && result.success) device.complete();
    return result;
  });
  return device;
}

function verifySignature(bundle: EvidenceBundle, publicKeyHex: string): void {
  expect(bundle).not.toHaveProperty("_testSigned");
  expect(bundle.kernelSignature.algorithm).toBe("ed25519");
  expect(nacl.sign.detached.verify(
    signingPreimage(bundle.bundleHash),
    Buffer.from(bundle.kernelSignature.value, "hex"),
    Buffer.from(publicKeyHex, "hex"),
  )).toBe(true);
}

beforeEach(() => {
  vi.mocked(Sentry.startSpan).mockImplementation((_opts, fn) => fn({} as never));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("N267 production signer admission", () => {
  it("J1 refuses JobRunner before commands, sessions, steps or phases", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const emitter = new EvidenceEmitter("k");
    const device = new FakeDevice("signer-device", "k", { declaredCommands: ["load_gcode", "start", "stop", "status"] });
    const quiesce = vi.spyOn(device, "quiesceEvidence");
    const listen = vi.spyOn(device, "onEvidence");
    const register = vi.spyOn(emitter, "registerStep");
    const onPhase = vi.fn();
    try {
      const result = await new JobRunner(device, [], null, emitter).run({ ...job, onPhase });
      expect(result).toEqual({ success: false, error: requiredMessage, durationMs: expect.any(Number) });
      expect(result).not.toHaveProperty("busy");
      expect(device.commands).toEqual([]);
      expect(quiesce).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(onPhase).not.toHaveBeenCalled();
      expect(emitter.getEvents(job.jobId, job.stepId)).toEqual([]);
      expect(isStepLeased(emitter, job.jobId, job.stepId)).toBe(false);
    } finally {
      await device.dispose();
    }
  });

  it("production JobRunner refuses the test signer before conflicting input hashes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const emitter = new EvidenceEmitter("k");
    const device = new FakeDevice("signer-device", "k", { declaredCommands: ["load_gcode", "start", "stop", "status"] });
    try {
      await expect(new JobRunner(device, [], null, emitter).run({ ...job, inputHash: job.gcodeHash })).resolves.toEqual({
        success: false, error: requiredMessage, durationMs: expect.any(Number),
      });
    } finally {
      await device.dispose();
    }
  });

  it("J2 refuses runPrintJob before start or step registration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    const adapter = new IppAdapter("signer-printer", { uri: "ipp://localhost:631/ipp/print", kernelId: "k", mockMode: true });
    const emitter = new EvidenceEmitter("k");
    const execute = vi.spyOn(adapter, "execute");
    const register = vi.spyOn(emitter, "registerStep");
    try {
      const printing = runPrintJob({ adapter, emitter, jobId: job.jobId, stepId: job.stepId, jobName: "test.pdf", totalPages: 1 });
      await vi.advanceTimersByTimeAsync(500 + 1 * 1200 + 500);
      const result = await printing;
      expect(result).toEqual({ success: false, events: [], error: requiredMessage, durationMs: expect.any(Number) });
      expect(result).not.toHaveProperty("busy");
      expect(result).not.toHaveProperty("bundle");
      expect(execute).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(emitter.getEvents(job.jobId, job.stepId)).toEqual([]);
      expect(isStepLeased(emitter, job.jobId, job.stepId)).toBe(false);
    } finally {
      await adapter.dispose();
    }
  });

  it("J3 finalize backstop refuses before signing, archival or listeners", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const emitter = new EvidenceEmitter("k");
    const listener = vi.fn();
    const archiveBundle = vi.fn().mockResolvedValue({ cid: "bundle-cid", metadataCid: "metadata-cid" });
    const storage = { isReady: vi.fn().mockReturnValue(true), archiveBundle };
    emitter.setStorageService(storage as unknown as EvidenceStorageService);
    emitter.onBundle(listener);
    emitter.registerStep(job.jobId, job.stepId, 0);
    await emitter.addEvent(job.jobId, job.stepId, {
      type: "execution_completed", timestamp: new Date().toISOString(),
      source: { deviceId: "signer-device", deviceType: "controller", kernelId: "k" }, payload: {},
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(emitter.finalizeBundle(job.jobId, job.stepId)).rejects.toMatchObject({
      name: "EvidenceSignerRequiredError", code: "kernel_signer_required", message: requiredMessage,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(archiveBundle).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("production finalizeBundle refuses the test signer before looking up an unregistered step", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const emitter = new EvidenceEmitter("k");
    await expect(emitter.finalizeBundle(job.jobId, job.stepId)).rejects.toBeInstanceOf(EvidenceSignerRequiredError);
  });

  it("J5 construction and the barrel import stay safe in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KERNEL_CONFIG", "");
    vi.stubEnv("KERNEL_CONFIG_FILE", "");
    expect(() => new EvidenceEmitter("k")).not.toThrow();
    await expect(import("../index.js")).resolves.toHaveProperty("EvidenceEmitter");
  }, 30_000);

  it.each([undefined, "test", "development", "staging", "Production"])("J6 test signer runs with NODE_ENV=%s", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv ?? "");
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    if (nodeEnv === undefined) expect("NODE_ENV" in process.env).toBe(false);
    const device = completingDevice();
    const emitter = new EvidenceEmitter("k");
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    try {
      const result = await new JobRunner(device, [], null, emitter).run(job);
      expect(result.success).toBe(true);
      expect(device.commands.map((command) => command.type)).toEqual(["load_gcode", "start"]);
      expect(bundles).toHaveLength(1);
      expect(bundles[0]).toHaveProperty("_testSigned", true);
      expect(bundles[0].kernelSignature.signer).toBe("0x0000000000000000000000000000000000000000");
    } finally {
      await device.dispose();
    }
  });

  it("J7(a) production JobRunner with a real signer succeeds and verifies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const signer = makeKernelEd25519Signer();
    const emitter = new EvidenceEmitter("k", signer.signFn);
    const device = completingDevice();
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    try {
      const result = await new JobRunner(device, [], null, emitter).run(job);
      expect(result.success).toBe(true);
      expect(device.commands.map((command) => command.type)).toEqual(["load_gcode", "start"]);
      expect(bundles).toHaveLength(1);
      verifySignature(bundles[0], signer.publicKeyHex);
    } finally {
      await device.dispose();
    }
  });

  it("J7(b) production createIppPrintKernel with a real signer prints and verifies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    const signer = makeKernelEd25519Signer();
    const kernel = createIppPrintKernel({ kernelId: "k", deviceId: "signer-printer", mockMode: true, signer });
    try {
      const printing = kernel.print({ jobId: job.jobId, jobName: "test.pdf", totalPages: 1 });
      await vi.advanceTimersByTimeAsync(500 + 1 * 1200 + 500);
      const result = await printing;
      expect(result.success).toBe(true);
      expect(result.bundle).toBeDefined();
      verifySignature(result.bundle!, signer.publicKeyHex);
    } finally {
      await kernel.dispose();
    }
  });

  it("J9 only buildServer constructs a single-argument EvidenceEmitter in kernel source", () => {
    vi.stubEnv("NODE_ENV", "test");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return ["__tests__", "testing"].includes(entry.name) ? [] : sources(filename);
      return entry.name.endsWith(".ts") ? [filename] : [];
    });
    const found: { file: string; scope: string }[] = [];
    for (const filename of sources(root)) {
      const source = readFileSync(filename, "utf8");
      const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "EvidenceEmitter" && node.arguments?.length === 1) {
          let scope: ts.Node | undefined = node.parent;
          while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
          found.push({ file: path.relative(root, filename), scope: scope && ts.isFunctionDeclaration(scope) ? scope.name?.text ?? "anonymous" : scope ? ts.SyntaxKind[scope.kind] : "module" });
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(found).toEqual([{ file: "server.ts", scope: "buildServer" }]);
  });
});
