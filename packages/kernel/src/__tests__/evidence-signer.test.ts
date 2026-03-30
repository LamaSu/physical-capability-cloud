/**
 * Tests for EvidenceEmitter signing behavior.
 *
 * Covers:
 *   - isTestSigner() returns true with default signer
 *   - isTestSigner() returns false with custom signer
 *   - _testSigned annotation is set on bundles signed with test key
 *   - cleanup() removes in-memory data
 *   - cleanup is idempotent
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EvidenceEmitter } from "../evidence-emitter.js";
import type { Signature } from "@pcc/spec";

// Mock Sentry to avoid real network calls
vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KERNEL_ID = "kernel-signer-test";

/** Minimal event to add to a step */
function makeRawEvent(): Parameters<EvidenceEmitter["addEvent"]>[2] {
  return {
    type: "execution_started",
    timestamp: new Date().toISOString(),
    source: {
      deviceId: "dev-test-001",
      deviceType: "controller",
      kernelId: KERNEL_ID,
    },
    payload: { test: true },
  };
}

/** A real custom signing function */
async function customSignFn(_data: string): Promise<Signature> {
  return {
    signer: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    algorithm: "secp256k1" as const,
    value: `custom_sig_${Date.now()}`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvidenceEmitter — signing behavior", () => {
  describe("isTestSigner()", () => {
    it("returns true when constructed without a signing function (uses default)", () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);
      expect(emitter.isTestSigner()).toBe(true);
    });

    it("returns false when constructed with a custom signing function", () => {
      const emitter = new EvidenceEmitter(KERNEL_ID, customSignFn);
      expect(emitter.isTestSigner()).toBe(false);
    });

    it("returns false even when custom sign fn is a simple mock", () => {
      const mockSign = vi.fn().mockResolvedValue({
        signer: "0xabcdef0000000000000000000000000000000000" as `0x${string}`,
        algorithm: "secp256k1" as const,
        value: "mock_custom_sig",
      });
      const emitter = new EvidenceEmitter(KERNEL_ID, mockSign);
      expect(emitter.isTestSigner()).toBe(false);
    });
  });

  describe("_testSigned annotation", () => {
    it("sets _testSigned=true on bundles signed with the test key", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID); // no custom signFn

      emitter.registerStep("job-ts-001", "step-1", 0);
      await emitter.addEvent("job-ts-001", "step-1", makeRawEvent());
      const bundle = await emitter.finalizeBundle("job-ts-001", "step-1");

      // Should be annotated
      expect((bundle as unknown as Record<string, unknown>)._testSigned).toBe(true);
    });

    it("does NOT set _testSigned on bundles signed with a custom key", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID, customSignFn);

      emitter.registerStep("job-ts-002", "step-1", 0);
      await emitter.addEvent("job-ts-002", "step-1", makeRawEvent());
      const bundle = await emitter.finalizeBundle("job-ts-002", "step-1");

      // Should NOT be annotated
      expect((bundle as unknown as Record<string, unknown>)._testSigned).toBeUndefined();
    });

    it("test-signed bundle has zero-address signer", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);

      emitter.registerStep("job-ts-003", "step-1", 0);
      await emitter.addEvent("job-ts-003", "step-1", makeRawEvent());
      const bundle = await emitter.finalizeBundle("job-ts-003", "step-1");

      expect(bundle.kernelSignature.signer).toBe("0x0000000000000000000000000000000000000000");
    });

    it("custom-signed bundle has non-zero signer", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID, customSignFn);

      emitter.registerStep("job-ts-004", "step-1", 0);
      await emitter.addEvent("job-ts-004", "step-1", makeRawEvent());
      const bundle = await emitter.finalizeBundle("job-ts-004", "step-1");

      expect(bundle.kernelSignature.signer).not.toBe("0x0000000000000000000000000000000000000000");
    });
  });

  describe("cleanup()", () => {
    it("removes in-memory event data for a completed job step", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);

      emitter.registerStep("job-clean-001", "step-1", 0);
      await emitter.addEvent("job-clean-001", "step-1", makeRawEvent());

      // Before cleanup — events exist
      expect(emitter.getEvents("job-clean-001", "step-1")).toHaveLength(1);

      emitter.cleanup("job-clean-001", "step-1");

      // After cleanup — events are gone
      expect(emitter.getEvents("job-clean-001", "step-1")).toHaveLength(0);
    });

    it("cleanup is idempotent — calling twice does not throw", () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);

      emitter.registerStep("job-clean-002", "step-1", 0);

      expect(() => {
        emitter.cleanup("job-clean-002", "step-1");
        emitter.cleanup("job-clean-002", "step-1"); // second call
      }).not.toThrow();
    });

    it("cleanup of non-existent step does not throw", () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);

      expect(() => {
        emitter.cleanup("job-nonexistent", "step-nonexistent");
      }).not.toThrow();
    });

    it("cleanup removes only the specified step, not others", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);

      emitter.registerStep("job-clean-003", "step-A", 0);
      emitter.registerStep("job-clean-003", "step-B", 0);

      await emitter.addEvent("job-clean-003", "step-A", makeRawEvent());
      await emitter.addEvent("job-clean-003", "step-B", makeRawEvent());

      emitter.cleanup("job-clean-003", "step-A");

      // step-A should be gone
      expect(emitter.getEvents("job-clean-003", "step-A")).toHaveLength(0);
      // step-B should still exist
      expect(emitter.getEvents("job-clean-003", "step-B")).toHaveLength(1);
    });

    it("cleanup prevents finalizeBundle from succeeding on cleaned step", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);

      emitter.registerStep("job-clean-004", "step-1", 0);
      await emitter.addEvent("job-clean-004", "step-1", makeRawEvent());

      emitter.cleanup("job-clean-004", "step-1");

      // Should throw after cleanup since the step is no longer registered
      await expect(
        emitter.finalizeBundle("job-clean-004", "step-1"),
      ).rejects.toThrow();
    });
  });

  describe("bundle listener callbacks", () => {
    it("calls onBundle listeners when a bundle is finalized", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);
      const listener = vi.fn();
      emitter.onBundle(listener);

      emitter.registerStep("job-listen-001", "step-1", 0);
      await emitter.addEvent("job-listen-001", "step-1", makeRawEvent());
      const bundle = await emitter.finalizeBundle("job-listen-001", "step-1");

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(bundle);
    });

    it("calls multiple listeners", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      emitter.onBundle(listener1);
      emitter.onBundle(listener2);

      emitter.registerStep("job-listen-002", "step-1", 0);
      await emitter.addEvent("job-listen-002", "step-1", makeRawEvent());
      await emitter.finalizeBundle("job-listen-002", "step-1");

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });
  });

  describe("storage service", () => {
    it("getStorageService returns null when no storage is attached", () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);
      expect(emitter.getStorageService()).toBeNull();
    });

    it("getLastIpfsResult returns undefined before any finalization", () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);
      expect(emitter.getLastIpfsResult()).toBeUndefined();
    });

    it("getLastIpfsResult remains undefined when no storage service is set", async () => {
      const emitter = new EvidenceEmitter(KERNEL_ID);
      emitter.registerStep("job-ipfs-001", "step-1", 0);
      await emitter.addEvent("job-ipfs-001", "step-1", makeRawEvent());
      await emitter.finalizeBundle("job-ipfs-001", "step-1");

      // No storage service — IPFS result should remain undefined
      expect(emitter.getLastIpfsResult()).toBeUndefined();
    });
  });
});
