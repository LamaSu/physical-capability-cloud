import { describe, it, expect } from "vitest";
import { pad, keccak256, toBytes, type Address } from "viem";
import { deriveOnchainOpKey } from "@pcc/workflow";
import { isTransientError, TRANSIENT_ERROR_CODE } from "../facades/transient-error.js";
import { BaseFacade } from "../facades/base.facade.js";
import type { AgentRole } from "../facades/types.js";

/**
 * Regression tests for the escrow-activity idempotency fixes (E1 + E2).
 *
 * E1: the chain-write activities used to pass a 20-byte escrow ADDRESS (and,
 *     in releaseMilestoneByJobActivity, a non-hex job UUID) straight into the
 *     on-chain semantic-key derivation, which requires exactly 32 bytes → every
 *     route 500'd. The fix converts to a canonical bytes32 first.
 * E2: a transient RPC/network failure was wrapped as a permanent FacadeError,
 *     so retries never engaged and the failed key was poisoned for 30 days.
 *     The fix classifies transient errors (base.facade → TRANSIENT_ERROR_CODE)
 *     so the activity retries; only true reverts/business errors stay permanent.
 */

const ADDR: Address = "0x1234567890abcdef1234567890abcdef12345678"; // 20 bytes

describe("escrow activity key derivation — E1 (address/UUID → bytes32)", () => {
  it("a RAW 20-byte address throws (the exact break the fix guards against)", () => {
    expect(() =>
      deriveOnchainOpKey({ jobId: ADDR as `0x${string}`, milestoneIdx: 0, action: "fund" }),
    ).toThrow(/bytes32/);
  });

  it("pad(address,{size:32}) — the gateway's address strategy — derives a stable key, no throw", () => {
    const jobId = pad(ADDR, { size: 32 });
    expect(jobId.length).toBe(66); // 0x + 64 hex = 32 bytes
    const derive = () => deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "fund" });
    expect(derive).not.toThrow();
    expect(derive().key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(derive().key).toBe(derive().key); // stable: same op → same key
  });

  it("keccak256(toBytes(uuid)) — the gateway's job-UUID strategy — derives a stable key, no throw", () => {
    const jobId = keccak256(toBytes("job-abc-123-def-456"));
    const derive = () => deriveOnchainOpKey({ jobId, milestoneIdx: 2, action: "release" });
    expect(derive).not.toThrow();
    expect(derive().key).toBe(derive().key);
  });

  it("all five chain-write actions on the same escrow derive DISTINCT keys", () => {
    const jobId = pad(ADDR, { size: 32 });
    const keys = ["fund", "release", "dispute", "depositBond", "submitEvidence"].map(
      (action) => deriveOnchainOpKey({ jobId, milestoneIdx: 0, action }).key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the same address in checksummed vs lowercase form derives the SAME key (case-insensitive)", () => {
    const lower = pad(ADDR.toLowerCase() as Address, { size: 32 });
    const upper = pad(("0x" + ADDR.slice(2).toUpperCase()) as Address, { size: 32 });
    const kl = deriveOnchainOpKey({ jobId: lower, milestoneIdx: 0, action: "fund" }).key;
    const ku = deriveOnchainOpKey({ jobId: upper, milestoneIdx: 0, action: "fund" }).key;
    expect(kl).toBe(ku); // idempotency holds regardless of address casing
  });
});

describe("isTransientError — E2 classification (money-safe: positive-match only)", () => {
  it("classifies transport / RPC / timeout / nonce failures as transient", () => {
    expect(isTransientError(new Error("HTTP request failed"))).toBe(true);
    expect(isTransientError(new Error("request timed out"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientError(new Error("nonce too low"))).toBe(true);
    expect(isTransientError(new Error("replacement transaction underpriced"))).toBe(true);
    expect(isTransientError(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe(true);
    const named = new Error("x");
    named.name = "TimeoutError";
    expect(isTransientError(named)).toBe(true);
  });

  it("follows the cause chain (viem nests the transport error under a higher-level error)", () => {
    const outer = new Error("TransactionExecutionError: the transaction failed");
    (outer as { cause?: unknown }).cause = new Error("fetch failed");
    expect(isTransientError(outer)).toBe(true);
  });

  it("does NOT classify a contract revert or business error as transient (never waste gas on a resend)", () => {
    expect(isTransientError(new Error("execution reverted: ChallengeWindowActive"))).toBe(false);
    expect(isTransientError(new Error("insufficient funds for gas * price + value"))).toBe(false);
    expect(isTransientError(new Error("MilestoneNotEvidenced"))).toBe(false);
    expect(isTransientError(new Error("BadRequest: invalid milestone index"))).toBe(false);
    const reverted = new Error("reverted");
    reverted.name = "ContractFunctionRevertedError";
    expect(isTransientError(reverted)).toBe(false);
  });
});

/** Minimal concrete facade to exercise BaseFacade.execute() error mapping. */
class _TestFacade extends BaseFacade {
  protected readonly allowedRoles: readonly AgentRole[] = [];
  constructor() {
    super("test");
  }
  run<T>(fn: () => Promise<T>) {
    return this.execute("op", fn);
  }
}

describe("BaseFacade.execute — E2 transient vs permanent mapping", () => {
  it("tags a transient throw with TRANSIENT_ERROR_CODE + retryable (so the activity retries)", async () => {
    const f = new _TestFacade();
    const r = await f.run(async () => {
      throw new Error("HTTP request failed");
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe(TRANSIENT_ERROR_CODE);
      expect(r.error.retryable).toBe(true);
      expect(r.error.httpStatus).toBe(503);
    }
  });

  it("keeps a revert / business throw as a permanent INTERNAL_ERROR (activity will NOT retry)", async () => {
    const f = new _TestFacade();
    const r = await f.run(async () => {
      throw new Error("execution reverted: ChallengeWindowActive");
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).not.toBe(TRANSIENT_ERROR_CODE);
      expect(r.error.code).toBe("INTERNAL_ERROR");
    }
  });
});
