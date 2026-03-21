import { describe, it, expect, beforeEach } from "vitest";
import { KernelKeychain } from "../kernel-keychain.js";
import { LogCaptureService } from "../log-capture-service.js";
import type { LogEntry } from "../log-capture-service.js";
import { sha256, canonicalize } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

// Fixed test mnemonic — 12 words, valid BIP-39
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

let keychain: KernelKeychain;
let service: LogCaptureService;

beforeEach(() => {
  keychain = new KernelKeychain(TEST_MNEMONIC);
  service = new LogCaptureService(keychain);
});

// ---------------------------------------------------------------------------
// KernelKeychain tests
// ---------------------------------------------------------------------------

describe("KernelKeychain", () => {
  it("derives a deterministic kernel address from a fixed mnemonic", () => {
    const kc1 = new KernelKeychain(TEST_MNEMONIC);
    const kc2 = new KernelKeychain(TEST_MNEMONIC);
    expect(kc1.getKernelAddress()).toBe(kc2.getKernelAddress());
  });

  it("kernel address differs from agent address (different derivation paths)", () => {
    const kernelAddr = keychain.getKernelAddress();
    const agentAddr = keychain.getAgentAddress();
    expect(kernelAddr).not.toBe(agentAddr);
    expect(kernelAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agentAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("signs data and verifies the signature", async () => {
    const data = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const signature = await keychain.signEvidence(data);

    expect(signature.signer).toBe(keychain.getKernelAddress());
    expect(signature.algorithm).toBe("secp256k1");
    expect(signature.value).toMatch(/^0x/);

    const isValid = await keychain.verifySignature(data, signature);
    expect(isValid).toBe(true);
  });

  it("rejects verification when signature is from a different signer", async () => {
    const kc2 = new KernelKeychain(); // different random mnemonic
    const data = "sha256:deadbeef";
    const signature = await kc2.signEvidence(data);

    // Signature is valid for kc2 but not for keychain (different key)
    const isValid = await keychain.verifySignature(data, signature);
    expect(isValid).toBe(false);
  });

  it("generates a fresh mnemonic when none provided and env not set", () => {
    const kc = new KernelKeychain();
    const addr = kc.getKernelAddress();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("throws on invalid mnemonic", () => {
    expect(() => new KernelKeychain("not a valid mnemonic at all")).toThrow();
  });

  it("exports a safe summary without exposing the private key", () => {
    const summary = keychain.summary();
    expect(summary["kernelAddress"]).toMatch(/^0x/);
    expect(summary["agentAddress"]).toMatch(/^0x/);
    expect(summary["derivationPath"]).toContain("1/0");
    expect(summary["mnemonic"]).toContain("...");
    // Must not contain full private key hex
    expect(summary["mnemonic"]).not.toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// LogCaptureService — basic capture
// ---------------------------------------------------------------------------

describe("LogCaptureService.captureEntry", () => {
  it("captures a single entry with correct fields", async () => {
    const entry = await service.captureEntry("Job completed OK", "cups://job-001");

    expect(entry.entryId).toBeTruthy();
    expect(entry.rawContent).toBe("Job completed OK");
    expect(entry.source).toBe("cups://job-001");
    expect(entry.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.entryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.kernelSignature.signer).toBe(keychain.getKernelAddress());
    expect(entry.kernelSignature.algorithm).toBe("secp256k1");
  });

  it("first entry has genesis previousHash (all zeros)", async () => {
    const entry = await service.captureEntry("line one", "os://print-queue");
    expect(entry.previousHash).toBe(`sha256:${"0".repeat(64)}`);
  });

  it("second entry's previousHash equals first entry's entryHash", async () => {
    const e1 = await service.captureEntry("first log", "cups://job-001");
    const e2 = await service.captureEntry("second log", "cups://job-001");
    expect(e2.previousHash).toBe(e1.entryHash);
  });

  it("third entry chains correctly from second entry", async () => {
    const e1 = await service.captureEntry("log 1", "cups://job-1");
    const e2 = await service.captureEntry("log 2", "cups://job-1");
    const e3 = await service.captureEntry("log 3", "cups://job-1");

    expect(e2.previousHash).toBe(e1.entryHash);
    expect(e3.previousHash).toBe(e2.entryHash);
  });

  it("each entry has a unique entryHash", async () => {
    const e1 = await service.captureEntry("msg a", "cups://job-1");
    const e2 = await service.captureEntry("msg b", "cups://job-1");
    const e3 = await service.captureEntry("msg c", "cups://job-1");
    const hashes = [e1.entryHash, e2.entryHash, e3.entryHash];
    const unique = new Set(hashes);
    expect(unique.size).toBe(3);
  });

  it("entryHash is the sha256 of canonical(rawContent+source+capturedAt)", async () => {
    const entry = await service.captureEntry("verify me", "ipp://printer/job-42");
    const expected = await sha256(canonicalize({
      capturedAt: entry.capturedAt,
      rawContent: "verify me",
      source: "ipp://printer/job-42",
    }));
    expect(entry.entryHash).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// LogCaptureService — chain verification
// ---------------------------------------------------------------------------

describe("LogCaptureService.verifyChain", () => {
  it("verifies an intact chain as valid", async () => {
    await service.captureEntry("line 1", "cups://job-1");
    await service.captureEntry("line 2", "cups://job-1");
    await service.captureEntry("line 3", "cups://job-1");

    const result = await service.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(result.brokenAt).toBeUndefined();
  });

  it("verifies an empty chain as valid (vacuously)", async () => {
    const result = await service.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("verifies a single-entry chain", async () => {
    await service.captureEntry("only entry", "cups://job-1");
    const result = await service.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(1);
  });

  it("detects tampering with rawContent", async () => {
    await service.captureEntry("original content", "cups://job-1");
    await service.captureEntry("second entry", "cups://job-1");

    // Directly mutate the first entry's rawContent (simulating tampering)
    const chain = service.getChain();
    // We need to access private entries for tampering — use a cast
    const internalService = service as unknown as { entries: LogEntry[] };
    internalService.entries[0]!.rawContent = "TAMPERED CONTENT";

    const result = await service.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.brokenAt).toBe(0);
  });

  it("detects tampering with a previousHash", async () => {
    await service.captureEntry("entry 1", "cups://job-1");
    await service.captureEntry("entry 2", "cups://job-1");

    const internalService = service as unknown as { entries: LogEntry[] };
    // Break the chain link on entry 1
    internalService.entries[1]!.previousHash = `sha256:${"f".repeat(64)}` as import("@pcc/spec").SHA256;

    const result = await service.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.errors.some((e) => e.includes("chain link broken"))).toBe(true);
  });

  it("detects invalid kernel signature", async () => {
    await service.captureEntry("entry 1", "cups://job-1");

    const internalService = service as unknown as { entries: LogEntry[] };
    // Replace signature with garbage
    internalService.entries[0]!.kernelSignature = {
      signer: keychain.getKernelAddress(),
      algorithm: "secp256k1",
      value: "0x" + "00".repeat(65),
    };

    const result = await service.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("signature invalid"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LogCaptureService — reset
// ---------------------------------------------------------------------------

describe("LogCaptureService.reset", () => {
  it("clears the chain on reset", async () => {
    await service.captureEntry("before reset", "cups://job-1");
    expect(service.getChain()).toHaveLength(1);

    service.reset();
    expect(service.getChain()).toHaveLength(0);
  });

  it("starts a fresh genesis chain after reset", async () => {
    await service.captureEntry("before reset", "cups://job-1");
    service.reset();

    const entry = await service.captureEntry("after reset", "cups://job-2");
    expect(entry.previousHash).toBe(`sha256:${"0".repeat(64)}`);
  });
});

// ---------------------------------------------------------------------------
// LogCaptureService — evidence event conversion
// ---------------------------------------------------------------------------

describe("LogCaptureService.toEvidenceEvents", () => {
  it("returns an empty array when chain is empty", () => {
    expect(service.toEvidenceEvents()).toHaveLength(0);
  });

  it("converts each entry to an evidence event", async () => {
    await service.captureEntry("log line 1", "cups://job-1");
    await service.captureEntry("log line 2", "cups://job-1");

    const events = service.toEvidenceEvents();
    expect(events).toHaveLength(2);

    for (const event of events) {
      expect(event.type).toBe("log_hash_chain_entry");
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.source.deviceType).toBe("gateway_bridge");
      expect(event.payload["entryHash"]).toMatch(/^sha256:/);
      expect(event.payload["previousHash"]).toMatch(/^sha256:/);
      expect(event.payload["kernelSignature"]).toBeTruthy();
    }
  });

  it("evidence events do NOT include id or hash (caller adds those)", () => {
    // toEvidenceEvents returns Omit<EvidenceEvent, "id" | "hash">
    // So the returned objects should not have id or hash
    const events = service.toEvidenceEvents();
    for (const event of events) {
      expect((event as Record<string, unknown>)["id"]).toBeUndefined();
      expect((event as Record<string, unknown>)["hash"]).toBeUndefined();
    }
  });

  it("payload contains the full chain entry metadata", async () => {
    const entry = await service.captureEntry("test content", "ipp://printer/job-99");
    const events = service.toEvidenceEvents();

    const payload = events[0]!.payload;
    expect(payload["entryId"]).toBe(entry.entryId);
    expect(payload["entryHash"]).toBe(entry.entryHash);
    expect(payload["previousHash"]).toBe(entry.previousHash);
    expect(payload["source"]).toBe("ipp://printer/job-99");
    expect(payload["capturedAt"]).toBe(entry.capturedAt);
  });
});
