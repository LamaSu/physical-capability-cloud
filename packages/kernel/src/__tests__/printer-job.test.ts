/**
 * Tests for the print-job path (`../printer-job.ts`) — the PRINT leg of
 * document.print-and-mail. Mock mode only; no real printer required.
 *
 * Covers:
 *   - runPrintJob drives the EXISTING IppAdapter to completion and returns a
 *     kernel-signed bundle whose completion event is `execution_completed`
 *     (a value in the FIXED EVIDENCE_EVENT_TYPES vocabulary).
 *   - The bundle is signed with an Ed25519 kernelSignature; the signature
 *     verifies (tweetnacl interop) and the bundle/event hashes verify.
 *   - Mock mode is labelled honestly (source.simulated:true, payload.mock:true).
 *   - The print `execution_completed` is consumable alongside the mail leg's
 *     `courier_pickup_confirmed` (same EvidenceEvent shape + shared jobId).
 *   - A device that refuses to start yields an honest failure — never a
 *     fabricated "success" bundle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nacl from "tweetnacl";
import {
  EVIDENCE_EVENT_TYPES,
  hashEvent,
  verifyBundleHash,
  verifyEventHash,
  type EvidenceEvent,
  type EvidenceSource,
} from "@pcc/spec";
import {
  createIppPrintKernel,
  makeKernelEd25519Signer,
  runPrintJob,
  type PrintJobResult,
} from "../printer-job.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import type { MachineAdapter } from "../adapters/types.js";

// A fixed 32-byte seed → deterministic kernel signing key across the suite.
const SEED = new Uint8Array(32).fill(7);

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// makeKernelEd25519Signer
// ---------------------------------------------------------------------------

describe("makeKernelEd25519Signer", () => {
  it("is deterministic for a given seed and produces an ed25519 signature", async () => {
    const a = makeKernelEd25519Signer(SEED);
    const b = makeKernelEd25519Signer(SEED);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(a.signingPublicKey).toBe(`0x${a.publicKeyHex}`);
    expect(a.publicKeyHex).toHaveLength(64); // 32-byte raw ed25519 pubkey

    const sig = await a.signFn("sha256:deadbeef");
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.signer).toMatch(/^0x[0-9a-f]{40}$/); // repo's address-shaped label
    // The signature verifies against the raw public key over the utf8 bundleHash.
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode("sha256:deadbeef"),
      fromHex(sig.value),
      fromHex(a.publicKeyHex),
    );
    expect(ok).toBe(true);
  });

  it("generates a fresh random key when no seed is given", () => {
    const a = makeKernelEd25519Signer();
    const b = makeKernelEd25519Signer();
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });
});

// ---------------------------------------------------------------------------
// runPrintJob — mock print
// ---------------------------------------------------------------------------

describe("runPrintJob — mock print via IppAdapter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Start a print and advance fake timers past spool + all pages. */
  async function print(totalPages: number): Promise<{
    kernel: ReturnType<typeof createIppPrintKernel>;
    result: PrintJobResult;
  }> {
    const kernel = createIppPrintKernel({
      kernelId: "kernel_print_test",
      deviceId: "ipp_printer_test_01",
      mockMode: true,
      seed: SEED,
    });
    const p = kernel.print({ jobId: "pcc-job-001", jobName: "invoice.pdf", totalPages });
    // spool (500ms) + totalPages * 1200ms + margin
    await vi.advanceTimersByTimeAsync(500 + totalPages * 1200 + 500);
    const result = await p;
    return { kernel, result };
  }

  it("completes and returns a signed bundle with an execution_completed event", async () => {
    const { kernel, result } = await print(3);
    expect(result.success).toBe(true);
    expect(result.bundle).toBeDefined();

    const types = result.bundle!.events.map((e) => e.type);
    expect(types).toContain("execution_started");
    expect(types).toContain("execution_progress");
    expect(types).toContain("execution_completed");
    // exactly one completion event
    expect(types.filter((t) => t === "execution_completed")).toHaveLength(1);

    await kernel.dispose();
  });

  it("uses execution_completed — a value in the FIXED EVIDENCE_EVENT_TYPES", async () => {
    const { kernel, result } = await print(2);
    const completed = result.bundle!.events.find((e) => e.type === "execution_completed");
    expect(completed).toBeDefined();
    expect(EVIDENCE_EVENT_TYPES).toContain(completed!.type);
    await kernel.dispose();
  });

  it("signs the bundle with an Ed25519 kernelSignature that verifies", async () => {
    const { kernel, result } = await print(2);
    const bundle = result.bundle!;

    expect(bundle.kernelSignature.algorithm).toBe("ed25519");
    // not the EvidenceEmitter test-only signer
    expect((bundle as Record<string, unknown>)._testSigned).toBeUndefined();

    // Verify the signature the same way @pcc/kernel-sdk's verifyBundleSignature
    // does: detached-verify over the utf8 bytes of bundleHash.
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(bundle.bundleHash),
      fromHex(bundle.kernelSignature.value),
      fromHex(kernel.signer.publicKeyHex),
    );
    expect(ok).toBe(true);

    // And the content hashes are internally consistent.
    expect(await verifyBundleHash(bundle)).toBe(true);
    for (const ev of bundle.events) {
      expect(await verifyEventHash(ev)).toBe(true);
    }
    await kernel.dispose();
  });

  it("returns a {jobId, pageCount, printerId} completion derived from the real event", async () => {
    const { kernel, result } = await print(3);
    expect(result.completion).toEqual({
      jobId: "pcc-job-001",
      printerJobId: expect.any(Number),
      pageCount: 3,
      printerId: "ipp_printer_test_01",
      simulated: true,
      jobName: "invoice.pdf",
    });
    await kernel.dispose();
  });

  it("labels mock output honestly: source.simulated + payload.mock", async () => {
    const { kernel, result } = await print(1);
    expect(result.completion!.simulated).toBe(true);
    for (const ev of result.bundle!.events) {
      expect(ev.source.simulated).toBe(true);
      expect((ev.payload as Record<string, unknown>).mock).toBe(true);
    }
    await kernel.dispose();
  });
});

// ---------------------------------------------------------------------------
// Consumable alongside the mail leg (courier_pickup_confirmed)
// ---------------------------------------------------------------------------

describe("print evidence is consumable alongside the mail leg", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("print execution_completed and courier_pickup_confirmed coexist under one jobId", async () => {
    const jobId = "pcc-job-printmail-42";

    // PRINT leg
    const kernel = createIppPrintKernel({
      kernelId: "kernel_print",
      deviceId: "ipp_printer_9",
      mockMode: true,
      seed: SEED,
    });
    const p = kernel.print({ jobId, jobName: "letter.pdf", totalPages: 1 });
    await vi.advanceTimersByTimeAsync(2500);
    const printResult = await p;
    const printCompleted = printResult.bundle!.events.find((e) => e.type === "execution_completed")!;

    // MAIL leg — build a courier_pickup_confirmed exactly as
    // packages/gateway/src/routes/carrier.ts does (hashEvent, courier_api source).
    const courierSource: EvidenceSource = {
      deviceId: "easypost:EZMOCK0000000001",
      deviceType: "courier_api",
      kernelId: "kernel_courier",
      simulated: true,
    };
    const courierNoHash = {
      type: "courier_pickup_confirmed" as const,
      timestamp: new Date().toISOString(),
      source: courierSource,
      payload: { jobId, trackingCode: "EZMOCK0000000001", carrier: "USPS" },
    };
    const courierEvent: EvidenceEvent = {
      id: "ev_courier_test",
      ...courierNoHash,
      hash: await hashEvent(courierNoHash),
    };

    // Both are valid vocabulary, both hashes verify, both share the jobId.
    expect(EVIDENCE_EVENT_TYPES).toContain(printCompleted.type);
    expect(EVIDENCE_EVENT_TYPES).toContain(courierEvent.type);
    expect(await verifyEventHash(printCompleted)).toBe(true);
    expect(await verifyEventHash(courierEvent)).toBe(true);

    const printAndMailView: EvidenceEvent[] = [printCompleted, courierEvent];
    expect((printCompleted.payload as Record<string, unknown>).jobId).toBeDefined();
    expect(courierEvent.payload.jobId).toBe(jobId);
    expect(new Set(printAndMailView.map((e) => e.type))).toEqual(
      new Set(["execution_completed", "courier_pickup_confirmed"]),
    );

    await kernel.dispose();
  });
});

// ---------------------------------------------------------------------------
// Honesty: no fabricated bundle when the device won't start
// ---------------------------------------------------------------------------

describe("runPrintJob — honest failure", () => {
  it("surfaces a start failure instead of fabricating a signed completion", async () => {
    const offlinePrinter: MachineAdapter = {
      id: "ipp_offline",
      type: "ipp-2d",
      source: { deviceId: "ipp_offline", deviceType: "controller", kernelId: "k" },
      async getStatus() {
        return "offline";
      },
      async getProgress() {
        return 0;
      },
      async execute() {
        return { success: false, message: "printer offline" };
      },
      onEvidence() {
        /* never emits */
      },
      async dispose() {
        /* noop */
      },
    };

    const signer = makeKernelEd25519Signer(SEED);
    const emitter = new EvidenceEmitter("k", signer.signFn);
    const result = await runPrintJob({
      adapter: offlinePrinter,
      emitter,
      jobId: "pcc-job-offline",
      jobName: "x.pdf",
      totalPages: 1,
      timeoutMs: 1_000,
    });

    expect(result.success).toBe(false);
    expect(result.bundle).toBeUndefined();
    expect(result.completion).toBeUndefined();
    expect(result.error).toContain("printer offline");
  });
});
