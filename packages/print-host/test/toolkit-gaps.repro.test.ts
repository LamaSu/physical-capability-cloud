import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  canonicalize,
  hashEvent,
  sessionKeyDelegationPreimage,
  type EvidenceBundle,
  type EvidenceEvent,
  type SessionAction,
} from "@pcc/spec";
import { FakeMachineAdapter } from "../src/index.js";

const gap = (name: string, fn: () => Promise<void>) =>
  process.env.PRINT_HOST_SHOW_GAPS === "1" ? it(name, fn) : it.fails(name, fn);

const timeoutMs = 300;
const cleanups: Array<() => Promise<void>> = [];
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const stillPending = Symbol("pending real async work");

// Requested toolkit API; local types keep this repro compilable before it exists.
interface UnitEvidenceSession {
  addPrintResult(result: PrintJobResult): void | Promise<void>;
  addEvent(event: EvidenceEvent): void | Promise<void>;
  finalize(): Promise<EvidenceBundle>;
}

interface UnitEvidenceSessionApi {
  openUnitEvidenceSession(options: {
    settlementUnitId: string;
    challengeNonce: string;
    jobId: string;
    deviceSigner: ReturnType<typeof makeKernelEd25519Signer>;
    journalDir: string;
    expiresAt: number;
  }): UnitEvidenceSession | Promise<UnitEvidenceSession>;
  resumeUnitEvidenceSession(options: {
    journalDir: string;
    settlementUnitId: string;
    deviceSigner: ReturnType<typeof makeKernelEd25519Signer>;
  }): UnitEvidenceSession | Promise<UnitEvidenceSession>;
}

function testIds(testId: string) {
  return {
    kernelId: `n144-print-host-${testId}`,
    deviceId: `n144-printer-${testId}`,
  };
}

function harness(testId: string, options?: ConstructorParameters<typeof FakeMachineAdapter>[2]) {
  const { kernelId, deviceId } = testIds(testId);
  const adapter = new FakeMachineAdapter(deviceId, kernelId, options);
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
  return drainPrintJob(pending);
}

async function awaitRealWork<T>(pending: Promise<T>, boundMs: number): Promise<T | typeof stillPending> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof stillPending>((resolve) => {
        timer = realSetTimeout(() => resolve(stillPending), boundMs);
      }),
    ]);
  } finally {
    if (timer) realClearTimeout(timer);
  }
}

async function drainPrintJob(pending: Promise<PrintJobResult>): Promise<PrintJobResult> {
  const result = await awaitRealWork(pending, 250);
  if (result !== stillPending) return result;
  // Fallback for an ignored abort or separate fake-time quiesce/settle waits.
  // Give crypto.subtle real time to finish before advancing another fake bound.
  for (let elapsedMs = 0; vi.isFakeTimers() && elapsedMs < 120_000; elapsedMs += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    const drained = await awaitRealWork(pending, 25);
    if (drained !== stillPending) return drained;
  }
  return pending;
}

async function expectPrivateJournalFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let fileCount = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) fileCount += await expectPrivateJournalFiles(path);
    else {
      expect((await stat(path)).mode & 0o777, `${entry.name} must be mode 0600`).toBe(0o600);
      fileCount++;
    }
  }
  return fileCount;
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

  it.each(["before-resolve", "after-resolve"] as const)(
    "the fake normalizes cancel ids and reports state 7 %s",
    async (cancelEventOrder) => {
      vi.useFakeTimers();
      const setup = harness(`cancel-check-${cancelEventOrder}`, { cancelEventOrder });
      const ippJobId = cancelEventOrder === "before-resolve" ? 109 : 119;
      setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
      await setup.adapter.execute({ type: "start" });
      const observations: string[] = [];
      const terminal = new Promise<void>((resolve) => setup.adapter.onEvidence((event) => {
        expect(event.type).toBe("execution_failed");
        expect(event.payload).toMatchObject({ ippJobId, state: "canceled" });
        observations.push("state-7");
        resolve();
      }));
      await setup.adapter.cancelJob(String(ippJobId + 1));
      expect(observations).toEqual([]);
      expect(await setup.adapter.getStatus()).toBe("busy");
      const canceled = setup.adapter.cancelJob(String(ippJobId)).then(() => {
        observations.push("cancel-resolved");
      });
      await Promise.all([canceled, terminal]);
      expect(observations).toEqual(cancelEventOrder === "before-resolve"
        ? ["state-7", "cancel-resolved"] : ["cancel-resolved", "state-7"]);
      await setup.adapter.cancelJob(ippJobId);
      expect(setup.adapter.cancels).toEqual([ippJobId + 1, ippJobId, ippJobId]);
      expect(await setup.adapter.getStatus()).toBe("idle");
      await setup.adapter.quiesceEvidence();
    },
  );

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
    const result = await drainPrintJob(pending);
    const simulatedEvents = result.events.filter(
      (event) => event.source.simulated === true || event.payload.mock === true,
    );
    expect(
      !result.success || simulatedEvents.length === 0,
      "mockMode:false must refuse the print or record no simulated/mock events: a reported downgrade still yields simulated evidence, which cannot settle",
    ).toBe(true);
  });

  gap("GAP-2 a print's evidence holds only its own job's events (N106)", async () => {
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

  gap("GAP-3 a reported failure returns a SIGNED execution_failed bundle", async () => {
    const setup = harness("gap-3");
    setup.adapter.scriptStart({ outcome: "success", jobId: 103 });
    const started = setup.adapter.started();
    const pending = runPrintJob({ ...job("reported-failure"), ...setup });
    await started;
    setup.adapter.emit("execution_started", { ippJobId: 103 });
    setup.adapter.emit("execution_failed", { ippJobId: 103, state: "canceled" });
    const result = await drainPrintJob(pending);
    expect(result.success).toBe(false);
    expect(result.bundle, "a device-reported failure must return a signed bundle").toBeDefined();
    const bundle = result.bundle!;
    expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
    expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
    expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
  });

  gap("GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle", async () => {
    vi.useFakeTimers();
    const setup = harness("gap-4");
    setup.adapter.scriptStart({ outcome: "success", jobId: 104 });
    const started = setup.adapter.started();
    const pending = runPrintJob({ ...job("timed-out"), ...setup });
    await started;
    setup.adapter.emit("execution_started", { ippJobId: 104 });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    const result = await drainPrintJob(pending);
    expect(result.success).toBe(false);
    expect(
      setup.adapter.cancels.length, "a timed-out device job must be canceled with cancelJob(104)",
    ).toBeGreaterThanOrEqual(1);
    expect(setup.adapter.cancels.every((id) => id === 104), "every cancel must target job 104").toBe(true);
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

  for (const cancelEventOrder of ["before-resolve", "after-resolve"] as const) {
    gap(`GAP-5 an abort input cancels the device job and returns a SIGNED execution_failed bundle (${cancelEventOrder})`, async () => {
      vi.useFakeTimers();
      const setup = harness(`gap-5-${cancelEventOrder}`, { cancelEventOrder });
      const ippJobId = cancelEventOrder === "before-resolve" ? 105 : 115;
      const controller = new AbortController();
      // Requested host input: pcc-adk chooses the abort input's API shape.
      const options = {
        ...job(`aborted-${cancelEventOrder}`), timeoutMs: 10_000, signal: controller.signal,
      } as Omit<PrintJobOptions, "adapter" | "emitter">;
      setup.adapter.scriptStart({ outcome: "success", jobId: ippJobId });
      const started = setup.adapter.started();
      const pending = runPrintJob({ ...options, ...setup });
      await started;
      setup.adapter.emit("execution_started", { ippJobId });
      controller.abort();
      const result = await drainPrintJob(pending);
      expect(
        setup.adapter.cancels.length, `an aborted device job must be canceled with cancelJob(${ippJobId})`,
      ).toBeGreaterThanOrEqual(1);
      expect(setup.adapter.cancels.every((id) => id === ippJobId), `every cancel must target job ${ippJobId}`).toBe(true);
      expect(
        setup.adapter.commands.some((command) => command.type === "stop"),
        "never 'stop': it ends polling before the canceled state",
      ).toBe(false);
      expect(result.durationMs).toBeLessThan(10_000);
      expect(result.success).toBe(false);
      expect(result.bundle, "an abort must return a signed failure bundle").toBeDefined();
      const bundle = result.bundle!;
      expect(bundle.events.some((event) => event.type === "execution_failed")).toBe(true);
      expect(bundle.events.some((event) => event.type === "execution_completed")).toBe(false);
      expect(verifyBundleSignature(bundle, bundleSigningKey(bundle, setup.signer.publicKeyHex))).toBe(true);
    });
  }

  gap("GAP-6 the unit fields reach every event", async () => {
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

  gap("GAP-7 a unit-level evidence session signs ONE journaled bundle under a delegated session key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    const setup = harness("gap-7");
    const journalDir = await mkdtemp(join(tmpdir(), "n144-unit-evidence-"));
    cleanups.push(() => rm(journalDir, { recursive: true, force: true }));
    const sdk = await import("@pcc/kernel-sdk") as Record<string, unknown>;
    const kernel = await import("@pcc/kernel") as Record<string, unknown>;
    const requestedApi = {
      openUnitEvidenceSession: sdk.openUnitEvidenceSession ?? kernel.openUnitEvidenceSession,
      resumeUnitEvidenceSession: sdk.resumeUnitEvidenceSession ?? kernel.resumeUnitEvidenceSession,
    };
    expect(typeof requestedApi.openUnitEvidenceSession, "missing toolkit API: openUnitEvidenceSession").toBe("function");
    expect(typeof requestedApi.resumeUnitEvidenceSession, "missing toolkit API: resumeUnitEvidenceSession").toBe("function");
    const api = requestedApi as unknown as UnitEvidenceSessionApi;
    const unit = {
      settlementUnitId: `0x${"c".repeat(64)}`,
      challengeNonce: `0x${"d".repeat(64)}`,
    };
    const options = job("delegated-unit");
    const expiresAt = Math.floor(Date.now() / 1_000) + 3 * 24 * 60 * 60;
    const session = await api.openUnitEvidenceSession({
      ...unit, jobId: options.jobId, deviceSigner: setup.signer, journalDir, expiresAt,
    });
    const result = await completingPrint(setup, options, 107);
    expect(result.success).toBe(true);
    const expectedEvents = structuredClone(result.events);
    // H3 consumes the print's events, never its already signed success bundle.
    await session.addPrintResult(result);
    const carrierEvent = async (
      type: "courier_pickup_confirmed" | "courier_delivery_confirmed",
      providerEventId: string,
    ): Promise<EvidenceEvent> => {
      const event: Omit<EvidenceEvent, "id" | "hash"> = {
        type,
        timestamp: new Date().toISOString(),
        source: {
          deviceId: "easypost:n144-tracking", deviceType: "courier_api",
          kernelId: testIds("gap-7").kernelId, simulated: false,
        },
        payload: {
          jobId: options.jobId, providerEventId, trackingCode: "n144-tracking",
          provenance: "independent_carrier_scan", independentCarrierScan: true,
        },
      };
      return { ...event, id: providerEventId, hash: await hashEvent(event) };
    };
    vi.setSystemTime(new Date("2026-10-09T01:00:00.000Z"));
    const pickup = await carrierEvent("courier_pickup_confirmed", "carrier-pickup");
    expectedEvents.push(structuredClone(pickup));
    await session.addEvent(pickup);
    // Discard the original session and recover the same unit from its journal.
    const resumeOptions = { journalDir, settlementUnitId: unit.settlementUnitId, deviceSigner: setup.signer };
    const resumed = await api.resumeUnitEvidenceSession(resumeOptions);
    vi.setSystemTime(new Date("2026-10-11T01:00:00.000Z"));
    const delivery = await carrierEvent("courier_delivery_confirmed", "carrier-delivery");
    expectedEvents.push(structuredClone(delivery));
    await resumed.addEvent(delivery);
    const bundle = await resumed.finalize();
    const canonicalBundle = canonicalize(bundle);
    expect(bundle.events).toHaveLength(expectedEvents.length);
    for (const event of bundle.events) {
      expect(event.payload, `${event.type} must commit settlementUnitId and challengeNonce`).toMatchObject(unit);
    }
    for (const event of expectedEvents) {
      expect(bundle.events).toContainEqual(expect.objectContaining({
        type: event.type, timestamp: event.timestamp, source: event.source,
        payload: expect.objectContaining(event.payload),
      }));
    }
    const authorization = bundle.sessionKeyAuthorization;
    expect(authorization, "the unit bundle must carry device-authorized sessionKeyAuthorization").toBeDefined();
    expect(authorization!.scope.contractIds).toContain(options.jobId);
    const firstEventTimestamp = Math.min(...expectedEvents.map((event) => Date.parse(event.timestamp))) / 1_000;
    expect(authorization!.issuedAt).toBeLessThanOrEqual(firstEventTimestamp);
    expect(authorization!.expiresAt).toBeLessThanOrEqual(expiresAt);
    expect(authorization!.scope.allowedActions).toContain("evidence_submit");
    expect(authorization!.scope.maxSignatures).toBeGreaterThanOrEqual(bundle.events.length);
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
    expect(verifyBundleSignature(bundle, sessionPublicKey)).toBe(true);
    expect(canonicalize(await resumed.finalize())).toBe(canonicalBundle);
    const finalizedSession = await api.resumeUnitEvidenceSession(resumeOptions);
    expect(canonicalize(await finalizedSession.finalize())).toBe(canonicalBundle);
    await expect(Promise.resolve().then(() => api.resumeUnitEvidenceSession({
      ...resumeOptions, settlementUnitId: `0x${"e".repeat(64)}`,
    }))).rejects.toThrow();
    expect(await expectPrivateJournalFiles(journalDir), "the unit session must persist journal files").toBeGreaterThan(0);
  });

  gap("GAP-8 a busy refusal is reported as busy and emits no failure (N127)", async () => {
    const setup = harness("gap-8");
    setup.adapter.scriptStart({ outcome: "busy" });
    const result = await runPrintJob({ ...job("busy-refusal"), ...setup });
    expect(result.success).toBe(false);
    expect(result.events.filter((event) => event.type === "execution_failed")).toEqual([]);
    expect(setup.emitter.getEvents("busy-refusal", "busy-refusal-print")).toEqual([]);
    // Requested structured result field; no parsing of error/message text.
    const busy = (result as PrintJobResult & { busy?: true }).busy;
    expect(busy, "a busy start refusal must expose top-level busy: true").toBe(true);
  });
});
