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

const kernelId = "n144-print-host";
const deviceId = "n144-printer";
const timeoutMs = 300;
const cleanups: Array<() => Promise<void>> = [];

function harness() {
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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("N144 print-host toolkit gap repros", () => {
  it("the scripted adapter completes a print through runPrintJob", async () => {
    const setup = harness();
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

  gap("GAP-1 real mode never silently simulates", async () => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(console, "warn");
    let kernel: IppPrintKernel;
    try {
      kernel = createIppPrintKernel({
        kernelId, deviceId, mockMode: false, uri: "ipp://127.0.0.1:9/ipp/print",
      });
    } catch (error) {
      // Explicit real-mode unavailability may be refused at construction.
      expect(error).toBeInstanceOf(Error);
      return;
    }
    cleanups.push(() => kernel.dispose());
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
    const reportsNotReal = result.completion?.simulated === true || kernel.adapter.source.simulated === true ||
      warnings.mock.calls.some((args) => args.some((arg) => /MOCK|simulation/i.test(String(arg))));
    expect(
      !result.success || simulatedEvents.length === 0 || reportsNotReal,
      "a real-mode refusal or downgrade must be reported",
    ).toBe(true);
    expect(
      !result.success || simulatedEvents.length === 0,
      "mockMode:false must refuse the print or record no simulated/mock events",
    ).toBe(true);
  });

  gap("GAP-2 a print's evidence holds only its own job's events (N106)", async () => {
    const setup = harness();
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

  gap("GAP-3 a reported failure returns a SIGNED execution_failed bundle", async () => {
    const setup = harness();
    setup.adapter.scriptStart({ outcome: "success", jobId: 103 });
    const started = setup.adapter.started();
    const pending = runPrintJob({ ...job("reported-failure"), ...setup });
    await started;
    setup.adapter.emit("execution_started", { ippJobId: 103 });
    setup.adapter.emit("execution_failed", { ippJobId: 103, state: "canceled" });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(result.bundle, "a device-reported failure must return a signed bundle").toBeDefined();
    const bundle = result.bundle!;
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
  });

  gap("GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle", async () => {
    vi.useFakeTimers();
    const setup = harness();
    setup.adapter.scriptStart({ outcome: "success", jobId: 104 });
    const started = setup.adapter.started();
    const pending = runPrintJob({ ...job("timed-out"), ...setup });
    await started;
    setup.adapter.emit("execution_started", { ippJobId: 104 });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    const result = await pending;
    expect(result.success).toBe(false);
    // A bare stop addresses this adapter's sole active job; explicit IDs must match it.
    const canceled = setup.adapter.commands.some((command) =>
      ["stop", "cancel"].includes(command.type) &&
      (command.payload?.ippJobId ?? command.payload?.jobId ?? 104) === 104,
    );
    expect(canceled, "a timed-out device job must receive cancel or stop").toBe(true);
    expect(result.bundle, "a timeout must return a signed failure bundle").toBeDefined();
    const bundle = result.bundle!;
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
  });

  gap("GAP-5 stopping a print yields a terminal failure event", async () => {
    vi.useFakeTimers();
    const kernel = createIppPrintKernel({ kernelId, deviceId, mockMode: true });
    const options = { ...job("stopped"), totalPages: 2, timeoutMs: 10_000 };
    let result: PrintJobResult | undefined;
    const pending = kernel.print(options).then((value) => { result = value; return value; });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(await kernel.adapter.getProgress()).toBe(50);
      expect((await kernel.adapter.execute({ type: "stop" })).success).toBe(true);
      // addEvent hashes asynchronously; allow it to store any actual terminal event.
      await vi.waitFor(() => {
        const failedEvents = kernel.emitter.getEvents(options.jobId, options.stepId!).filter(
          (event) => event.type === "execution_failed",
        );
        expect(failedEvents, "stop must record execution_failed promptly").toHaveLength(1);
        expect(result, "runPrintJob must resolve before its timeout after stop").toBeDefined();
      }, { timeout: timeoutMs, interval: 10 });
      expect(result!.success).toBe(false);
      expect(result!.durationMs).toBeLessThan(options.timeoutMs);
      expect(result!.events.some((event) => event.type === "execution_failed")).toBe(true);
    } finally {
      // Drain the current toolkit's timeout even when the prompt-failure assertion fails.
      await vi.advanceTimersByTimeAsync(options.timeoutMs);
      await pending;
      await kernel.dispose();
    }
  });

  gap("GAP-6 the unit fields reach every event", async () => {
    const setup = harness();
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
    const setup = harness(); // The host supplies its device signer to EvidenceEmitter.
    const parentAgentId = `eip155:8453:${setup.signer.signingPublicKey.slice(0, 42)}`;
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

  gap("GAP-8 a busy refusal is reported as busy and emits no failure (N127)", async () => {
    const setup = harness();
    setup.adapter.scriptStart({ outcome: "busy" });
    const result = await runPrintJob({ ...job("busy-refusal"), ...setup });
    expect(result.success).toBe(false);
    expect(result.events.filter((event) => event.type === "execution_failed")).toEqual([]);
    expect(setup.emitter.getEvents("busy-refusal", "busy-refusal-print")).toEqual([]);
    // Requested structured result field; no parsing of error/message text.
    expect((result as PrintJobResult & { busy?: boolean }).busy,
      "a busy start refusal must expose result.busy === true").toBe(true);
  });
});
