/**
 * Tests for PrinterLogAdapter.
 *
 * Covers:
 *  - startRecording() triggers log polling and emits log_hash_chain_entry events
 *  - Each event carries a kernel-signed hash chain entry
 *  - Hash chain is correctly linked (each entry references the previous)
 *  - stopRecording() emits a printer_job_verified summary event
 *  - stopRecording() returns the summary with correct chain length
 *  - getCurrentReading() reflects live state
 *  - dispose() cleans up the poll timer
 *  - Custom logProvider is called with the correct jobId
 *  - logProvider returning null causes no event emission
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KernelKeychain } from "../kernel-keychain.js";
import { LogCaptureService } from "../log-capture-service.js";
import { PrinterLogAdapter } from "../adapters/printer-log-adapter.js";
import type { EvidenceEvent } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Shared test setup
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

/** Make a fresh adapter with a deterministic log provider for a given set of lines. */
function makeAdapter(
  lines: string[],
  opts?: { pollIntervalMs?: number; logSource?: string },
) {
  const keychain = new KernelKeychain(TEST_MNEMONIC);
  const logService = new LogCaptureService(keychain);
  const remaining = [...lines];

  const logProvider = vi.fn(async (_jobId: string) => {
    return remaining.shift() ?? null;
  });

  const adapter = new PrinterLogAdapter(
    "printer_log_01",
    "kernel_test",
    logService,
    {
      logSource: opts?.logSource ?? "cups://test-job",
      pollIntervalMs: opts?.pollIntervalMs ?? 50,
      logProvider,
    },
  );

  return { adapter, logProvider, logService, keychain };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("PrinterLogAdapter — constructor", () => {
  it("sets id, type, and source properties", () => {
    const { adapter } = makeAdapter([]);
    expect(adapter.id).toBe("printer_log_01");
    expect(adapter.type).toBe("power_monitor");
    expect(adapter.source.deviceId).toBe("printer_log_01");
    expect(adapter.source.deviceType).toBe("controller");
    expect(adapter.source.kernelId).toBe("kernel_test");
    expect(adapter.source.firmwareVersion).toBe("PrinterLogAdapter-1.0.0");
  });

  it("implements SensorAdapter interface", () => {
    const { adapter } = makeAdapter([]);
    expect(typeof adapter.startRecording).toBe("function");
    expect(typeof adapter.stopRecording).toBe("function");
    expect(typeof adapter.getCurrentReading).toBe("function");
    expect(typeof adapter.onEvidence).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// startRecording — evidence emission
// ---------------------------------------------------------------------------

describe("PrinterLogAdapter — startRecording", () => {
  it("emits log_hash_chain_entry events for each log line", async () => {
    const lines = [
      "[2026-03-21T10:00:00Z] Job started: pages=1",
      "[2026-03-21T10:00:01Z] Page 1 printed",
      "[2026-03-21T10:00:02Z] Job completed: status=ok",
    ];
    const { adapter } = makeAdapter(lines);

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-001");
    // Wait for polling to pick up remaining lines
    await new Promise((resolve) => setTimeout(resolve, 200));
    await adapter.dispose();

    const chainEvents = events.filter((e) => e.type === "log_hash_chain_entry");
    expect(chainEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("each chain event has correct structure", async () => {
    const { adapter } = makeAdapter([
      "[2026-03-21T10:00:00Z] Job started",
    ]);

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-002");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.dispose();

    const chainEvents = events.filter((e) => e.type === "log_hash_chain_entry");
    expect(chainEvents.length).toBeGreaterThanOrEqual(1);

    const first = chainEvents[0]!;
    expect(first.type).toBe("log_hash_chain_entry");
    expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.source.deviceType).toBe("gateway_bridge");
    expect(first.payload["entryHash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.payload["previousHash"]).toMatch(/^sha256:[0-9a-f]{0,64}/);
    expect(first.payload["kernelSignature"]).toBeTruthy();
    expect(first.payload["jobId"]).toBe("job-002");
    expect(first.payload["rawContent"]).toBe("[2026-03-21T10:00:00Z] Job started");
  });

  it("chain is correctly linked — each entry references the previous hash", async () => {
    const lines = [
      "[T1] Line one",
      "[T2] Line two",
      "[T3] Line three",
    ];
    const { adapter } = makeAdapter(lines, { pollIntervalMs: 20 });

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-003");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.dispose();

    const chainEvents = events.filter((e) => e.type === "log_hash_chain_entry");
    expect(chainEvents.length).toBe(3);

    // First entry must have genesis hash (all zeros)
    expect(chainEvents[0]!.payload["previousHash"]).toBe(`sha256:${"0".repeat(64)}`);

    // Each subsequent entry's previousHash must equal the prior entry's entryHash
    for (let i = 1; i < chainEvents.length; i++) {
      expect(chainEvents[i]!.payload["previousHash"]).toBe(
        chainEvents[i - 1]!.payload["entryHash"],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Kernel signature verification
// ---------------------------------------------------------------------------

describe("PrinterLogAdapter — kernel signatures", () => {
  it("each chain entry is signed by the kernel key", async () => {
    const { adapter, keychain } = makeAdapter([
      "[T1] Signed log line",
    ]);

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-004");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.dispose();

    const chainEvents = events.filter((e) => e.type === "log_hash_chain_entry");
    expect(chainEvents.length).toBeGreaterThanOrEqual(1);

    const sig = chainEvents[0]!.payload["kernelSignature"] as {
      signer: string;
      algorithm: string;
      value: string;
    };
    // Signer must be the kernel address derived from the test mnemonic
    expect(sig.signer.toLowerCase()).toBe(
      keychain.getKernelAddress().toLowerCase(),
    );
    expect(sig.algorithm).toBe("secp256k1");
    expect(sig.value).toMatch(/^0x/);
  });

  it("signature is verifiable by the KernelKeychain", async () => {
    const { adapter, keychain } = makeAdapter(["[T1] Verifiable line"]);

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-005");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.dispose();

    const chainEvents = events.filter((e) => e.type === "log_hash_chain_entry");
    expect(chainEvents.length).toBeGreaterThanOrEqual(1);

    const payload = chainEvents[0]!.payload;
    const rawSig = payload["kernelSignature"] as {
      signer: string;
      algorithm: string;
      value: string;
    };
    const sig = {
      signer: rawSig.signer as `0x${string}`,
      algorithm: rawSig.algorithm as "secp256k1" | "ed25519",
      value: rawSig.value as `0x${string}`,
    };

    const isValid = await keychain.verifySignature(
      payload["entryHash"] as string,
      sig,
    );
    expect(isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stopRecording — summary event
// ---------------------------------------------------------------------------

describe("PrinterLogAdapter — stopRecording", () => {
  it("returns a printer_job_verified summary event", async () => {
    const { adapter } = makeAdapter([
      "[T1] Job started",
      "[T2] Job completed",
    ]);

    await adapter.startRecording("job-006");
    await new Promise((resolve) => setTimeout(resolve, 200));

    const summary = await adapter.stopRecording();

    expect(summary.type).toBe("printer_job_verified");
    expect(summary.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(summary.source.deviceId).toBe("printer_log_01");
    expect(summary.payload["jobId"]).toBe("job-006");
  });

  it("summary includes chain length", async () => {
    const lines = ["[T1] Line 1", "[T2] Line 2", "[T3] Line 3"];
    const { adapter } = makeAdapter(lines);

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-007");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const summary = await adapter.stopRecording();

    expect(typeof summary.payload["chainLength"]).toBe("number");
    expect((summary.payload["chainLength"] as number)).toBeGreaterThanOrEqual(1);
  });

  it("summary event is also emitted to evidence listeners", async () => {
    const { adapter } = makeAdapter(["[T1] only line"]);

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-008");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.stopRecording();

    const summaryEvents = events.filter((e) => e.type === "printer_job_verified");
    expect(summaryEvents).toHaveLength(1);
  });

  it("summary chainLength matches the number of chain events emitted", async () => {
    const lines = ["[T1] A", "[T2] B", "[T3] C"];
    const { adapter } = makeAdapter(lines, { pollIntervalMs: 20 });

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-009");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const summary = await adapter.stopRecording();

    const chainEvents = events.filter((e) => e.type === "log_hash_chain_entry");
    expect(summary.payload["chainLength"]).toBe(chainEvents.length);
  });

  it("summary payload includes headHash, tailHash, and logSource", async () => {
    const { adapter } = makeAdapter(["[T1] entry"], { logSource: "cups://printer-001" });

    await adapter.startRecording("job-010");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const summary = await adapter.stopRecording();

    expect(summary.payload["logSource"]).toBe("cups://printer-001");
    expect(summary.payload["headHash"]).toMatch(/^sha256:/);
    expect(summary.payload["tailHash"]).toMatch(/^sha256:/);
  });
});

// ---------------------------------------------------------------------------
// getCurrentReading
// ---------------------------------------------------------------------------

describe("PrinterLogAdapter — getCurrentReading", () => {
  it("returns recording=false before startRecording", async () => {
    const { adapter } = makeAdapter([]);
    const reading = await adapter.getCurrentReading();
    expect(reading["recording"]).toBe(false);
    expect(reading["chainLength"]).toBe(0);
  });

  it("returns recording=true during recording", async () => {
    const { adapter } = makeAdapter([]);
    await adapter.startRecording("job-reading-01");
    const reading = await adapter.getCurrentReading();
    expect(reading["recording"]).toBe(true);
    expect(reading["jobId"]).toBe("job-reading-01");
    await adapter.dispose();
  });

  it("returns the latest entry hash after capturing a line", async () => {
    const { adapter } = makeAdapter(["[T1] captured line"]);

    await adapter.startRecording("job-reading-02");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const reading = await adapter.getCurrentReading();
    expect(reading["latestEntryHash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// logProvider contract
// ---------------------------------------------------------------------------

describe("PrinterLogAdapter — logProvider contract", () => {
  it("calls logProvider with the correct jobId", async () => {
    const { adapter, logProvider } = makeAdapter(["[T1] line"]);

    await adapter.startRecording("job-lp-01");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.dispose();

    expect(logProvider).toHaveBeenCalledWith("job-lp-01");
  });

  it("does not emit events when logProvider returns null", async () => {
    const { adapter } = makeAdapter([]); // empty lines → always null

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-lp-02");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await adapter.dispose();

    const chainEvents = events.filter((e) => e.type === "log_hash_chain_entry");
    expect(chainEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("PrinterLogAdapter — dispose", () => {
  it("stops polling after dispose", async () => {
    const { adapter, logProvider } = makeAdapter(
      ["[T1] before dispose"],
      { pollIntervalMs: 50 },
    );

    await adapter.startRecording("job-dispose-01");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await adapter.dispose();

    const countAtDispose = logProvider.mock.calls.length;
    // Wait to ensure no more calls happen
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logProvider.mock.calls.length).toBe(countAtDispose);
  });

  it("listeners are cleared after dispose", async () => {
    const { adapter } = makeAdapter(["[T1] post-dispose line"]);

    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.startRecording("job-dispose-02");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await adapter.dispose();

    const countAtDispose = events.length;
    // Any lingering async work should not reach the cleared listeners
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.length).toBe(countAtDispose);
  });
});
