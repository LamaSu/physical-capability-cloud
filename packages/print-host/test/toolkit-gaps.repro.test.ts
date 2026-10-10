import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIppPrintKernel,
  EvidenceEmitter,
  makeKernelEd25519Signer,
  runPrintJob,
  type IppPrintKernel,
  type PrintJobOptions,
  type PrintJobResult,
} from "@pcc/kernel";
import { verifyBundleSignature } from "@pcc/kernel-sdk";
import {
  sessionKeyDelegationPreimage,
  type EvidenceBundle,
  type SessionAction,
} from "@pcc/spec";
import { FakeMachineAdapter } from "../src/index.js";

const gap = (name: string, fn: () => Promise<void>) =>
  process.env.PRINT_HOST_SHOW_GAPS === "1" ? it(name, fn) : it.fails(name, fn);

const timeoutMs = 300;
const cleanups: Array<() => Promise<void>> = [];

function testIds(testId: string) {
  return {
    kernelId: `n144-print-host-${testId}`,
    deviceId: `n144-printer-${testId}`,
  };
}

function harness(testId: string) {
  const { kernelId, deviceId } = testIds(testId);
  const adapter = new FakeMachineAdapter(deviceId, kernelId);
  const signer = makeKernelEd25519Signer();
  const emitter = new EvidenceEmitter(kernelId, signer.signFn);
  cleanups.push(() => adapter.dispose());
  return { adapter, signer, emitter };
}

function job(jobId: string): Omit<PrintJobOptions, "adapter" | "emitter"> {
  return { jobId, stepId: `${jobId}-print`, jobName: `${jobId}.pdf`, totalPages: 1, timeoutMs };
}

function bundleSigningKey(bundle: EvidenceBundle, devicePublicKeyHex: string): Buffer {
  const key = bundle.sessionKeyAuthorization?.publicKey ?? devicePublicKeyHex;
  return Buffer.from(key.replace(/^0x/, ""), "hex");
}

async function completingPrint(
  setup: ReturnType<typeof harness>,
  options: Omit<PrintJobOptions, "adapter" | "emitter">,
  ippJobId: number,
) {
  setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
  const started = setup.adapter.started();
  const pending = runPrintJob({ ...options, adapter: setup.adapter, emitter: setup.emitter });
  await started;
  setup.adapter.emit("execution_started", { ippJobId, jobName: options.jobName });
  setup.adapter.emit("execution_progress", { ippJobId, totalPages: 1, progress: 100 });
  setup.adapter.emit("execution_completed", { ippJobId, totalPages: 1 });
  return pending;
}

async function drainPrintJob(pending: Promise<PrintJobResult>): Promise<PrintJobResult> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  // Timeout handling can include separate evidence quiesce/settle waits.
  for (let elapsedMs = 0; !settled && elapsedMs < 120_000; elapsedMs += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  if (!settled) throw new Error("runPrintJob did not settle within 120 seconds of fake time");
  return pending;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("N144 print-host toolkit gap repros", () => {
  it("the scripted adapter completes a print through runPrintJob", async () => {
    const setup = harness("harness-check");
    const result = await completingPrint(setup, job("harness-check"), 100);
    expect(result.success).toBe(true);
    expect(result.bundle).toBeDefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "execution_started", "execution_progress", "execution_completed",
    ]);
    expect(result.completion?.printerJobId).toBe(100);
    expect(setup.adapter.commands).toEqual([
      { type: "start", payload: { jobName: "harness-check.pdf", totalPages: 1 } },
    ]);
    expect(await setup.adapter.getStatus()).toBe("idle");
    await setup.adapter.quiesceEvidence();
  });

  gap("GAP-1 real mode never simulates", async () => {
    vi.useFakeTimers();
    let kernel: IppPrintKernel;
    try {
      kernel = createIppPrintKernel({
        ...testIds("gap-1"), mockMode: false, uri: "ipp://127.0.0.1:9/ipp/print",
      });
    } catch (error) {
      // Explicit real-mode unavailability may be refused at construction.
      expect(error).toBeInstanceOf(Error);
      return;
    }
    cleanups.push(() => kernel.dispose());
    // Contain the constructor's optional IPP import, without waiting for a warning.
    await vi.dynamicImportSettled();
    const pending = kernel.print({
      ...job("real-required"),
      documentData: Buffer.from("N144 test document"),
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    const simulatedEvents = result.events.filter(
      (event) => event.source.simulated === true || event.payload.mock === true,
    );
    expect(
      !result.success || simulatedEvents.length === 0,
      "mockMode:false must refuse the print or record no simulated/mock events: a reported downgrade still yields simulated evidence, which cannot settle",
    ).toBe(true);
  });

  it("GAP-2 a print's evidence holds only its own job's events (N106)", async () => {
    const setup = harness("gap-2");
    const first = job("print-A");
    const resultA = await completingPrint(setup, first, 101);
    expect(resultA.success).toBe(true);
    const resultB = await completingPrint(setup, job("print-B"), 102);
    expect(resultB.success).toBe(true);
    const foreignEvents = setup.emitter.getEvents(first.jobId, first.stepId!).filter(
      (event) => event.payload.ippJobId === 102,
    );
    expect(foreignEvents, "print A must contain none of print B's events").toEqual([]);
  });

  it("GAP-3 a reported failure returns a SIGNED execution_failed bundle", async () => {
    const setup = harness("gap-3");
    setup.adapter.scriptStart({ outcome: "success", jobId: 103 });
    const started = setup.adapter.started();
    const pending = runPrintJob({ ...job("reported-failure"), ...setup });
    await started;
    setup.adapter.emit("execution_started", { ippJobId: 103 });
    setup.adapter.emit("execution_failed", { ippJobId: 103, state: "canceled" });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.bundle, "a device-reported failure must return a signed bundle").toBeDefined();
    const bundle = result.bundle!;
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
  });

  it("GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle", async () => {
    vi.useFakeTimers();
    const setup = harness("gap-4");
    setup.adapter.scriptStart({ outcome: "success", jobId: 104 });
    const started = setup.adapter.started();
    const pending = runPrintJob({ ...job("timed-out"), ...setup });
    await started;
    setup.adapter.emit("execution_started", { ippJobId: 104 });
    const result = await drainPrintJob(pending);
    expect(result.success).toBe(false);
    expect(
      setup.adapter.cancels, "a timed-out device job must be canceled with cancelJob(104)",
    ).toEqual([104]);
    expect(
      setup.adapter.commands.some((command) => command.type === "stop"),
      "never 'stop': it ends polling before the canceled state",
    ).toBe(false);
    expect(result.bundle, "a timeout must return a signed failure bundle").toBeDefined();
    const bundle = result.bundle!;
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
  });

  it("GAP-5 an abort input cancels the device job and returns a SIGNED execution_failed bundle", async () => {
    vi.useFakeTimers();
    const setup = harness("gap-5");
    const controller = new AbortController();
    // Requested host input: pcc-adk chooses the abort input's API shape.
    const options = {
      ...job("aborted"), timeoutMs: 10_000, signal: controller.signal,
    } as Omit<PrintJobOptions, "adapter" | "emitter">;
    setup.adapter.scriptStart({ outcome: "success", jobId: 105 });
    const started = setup.adapter.started();
    let result: PrintJobResult | undefined;
    const pending = runPrintJob({ ...options, ...setup }).then((value) => {
      result = value;
      return value;
    });
    try {
      await started;
      setup.adapter.emit("execution_started", { ippJobId: 105 });
      controller.abort();
      for (let elapsedMs = 0; !result && elapsedMs < 9_000; elapsedMs += 100) {
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(
        setup.adapter.cancels, "an aborted device job must be canceled with cancelJob(105)",
      ).toEqual([105]);
      expect(
        setup.adapter.commands.some((command) => command.type === "stop"),
        "never 'stop': it ends polling before the canceled state",
      ).toBe(false);
      expect(result, "an aborted print must settle before its 10_000 ms timeout").toBeDefined();
      expect(result!.durationMs).toBeLessThan(10_000);
      expect(result!.success).toBe(false);
      expect(result!.bundle, "an abort must return a signed failure bundle").toBeDefined();
      const bundle = result!.bundle!;
      expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
      expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
      expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
    } finally {
      // Drain timeout and evidence waits even when the toolkit ignores the signal.
      await drainPrintJob(pending);
    }
  });

  it("GAP-6 the unit fields reach every event", async () => {
    const setup = harness("gap-6");
    const unit = {
      settlementUnitId: `0x${"a".repeat(64)}`,
      challengeNonce: `0x${"b".repeat(64)}`,
    };
    // Requested host inputs: the current PrintJobOptions does not expose these yet.
    const options = { ...job("unit-bound"), ...unit } as Omit<PrintJobOptions, "adapter" | "emitter">;
    const result = await completingPrint(setup, options, 106);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(3);
    for (const event of setup.emitter.getEvents(options.jobId, options.stepId!)) {
      expect(event.payload, `${event.type} must commit settlementUnitId and challengeNonce`)
        .toMatchObject(unit);
    }
  });

  gap("GAP-7 a success bundle is signed by a delegated session key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    const setup = harness("gap-7"); // The host supplies its device signer to EvidenceEmitter.
    const operator = "0x" + "11".repeat(20);
    const parentAgentId = `eip155:84532:${operator}`;
    const expiresAt = Math.floor(Date.now() / 1_000) + 3 * 24 * 60 * 60;
    // Requested API, currently absent: principal identity and a transit-length expiry.
    const options = {
      ...job("delegated"), parentAgentId, sessionKeyExpiresAt: expiresAt,
    } as Omit<PrintJobOptions, "adapter" | "emitter">;
    const result = await completingPrint(setup, options, 107);
    expect(result.success).toBe(true);
    expect(result.bundle).toBeDefined();
    const authorization = result.bundle!.sessionKeyAuthorization;
    expect(authorization, "success must carry device-authorized sessionKeyAuthorization").toBeDefined();
    expect(authorization!.parentAgentId).toBe(parentAgentId);
    expect(authorization!.expiresAt).toBe(expiresAt);
    expect(authorization!.expiresAt - authorization!.issuedAt).toBeGreaterThan(24 * 60 * 60);
    expect(authorization!.scope.contractIds).toContain(options.jobId);
    expect(authorization!.scope.allowedActions).toContain("evidence_submit");
    expect(authorization!.scope.maxSignatures).toBeGreaterThanOrEqual(result.events.length);
    const sessionPublicKey = Buffer.from(authorization!.publicKey.replace(/^0x/, ""), "hex");
    expect(sessionPublicKey).toHaveLength(32);
    expect(sessionPublicKey.equals(Buffer.from(setup.signer.publicKeyHex, "hex"))).toBe(false);
    const preimage = sessionKeyDelegationPreimage({
      ...authorization!,
      parentAgentId: authorization!.parentAgentId as Parameters<typeof sessionKeyDelegationPreimage>[0]["parentAgentId"],
      publicKey: sessionPublicKey,
      scope: {
        ...authorization!.scope,
        allowedActions: authorization!.scope.allowedActions as SessionAction[],
      },
    });
    const devicePublicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(setup.signer.publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    const parentSignature = Buffer.from(authorization!.parentSignature.replace(/^0x/, ""), "hex");
    expect(verify(null, preimage, devicePublicKey, parentSignature)).toBe(true);
    expect(verifyBundleSignature(result.bundle!, sessionPublicKey)).toBe(true);
  });

  it("GAP-8 a busy refusal is reported as busy and emits no failure (N127)", async () => {
    const setup = harness("gap-8");
    setup.adapter.scriptStart({ outcome: "busy" });
    const result = await runPrintJob({ ...job("busy-refusal"), ...setup });
    expect(result.success).toBe(false);
    expect(result.events.filter((event) => event.type === "execution_failed")).toEqual([]);
    expect(setup.emitter.getEvents("busy-refusal", "busy-refusal-print")).toEqual([]);
    // Requested structured result field; no parsing of error/message text.
    const busy = (result as PrintJobResult & { busy?: unknown }).busy;
    expect(busy, "a busy start refusal must expose a structured busy marker").toBeTruthy();
  });
});
