/**
 * Tests for the idempotent paid-write broadcast (security review PR #157 point 1).
 *
 * Pure — no chain, no viem. `broadcastIdempotent` is driven by injected sign / send /
 * confirmOnChain callbacks, so we assert the review's exact failover semantics
 * deterministically:
 *   - `already known` from a failover re-send resolves to the ORIGINAL tx hash (no throw).
 *   - `nonce too low` is ambiguous: our tx on-chain → idempotent success; a different tx
 *     on the nonce → real failure (rethrow so the manager re-seeds).
 *   - the tx is signed ONCE; only the byte-identical bytes are re-broadcast.
 */
import { describe, it, expect, vi } from "vitest";
import {
  classifyBroadcastError,
  resolveBroadcastOutcome,
  broadcastIdempotent,
  type IdempotentBroadcast,
} from "../contracts/idempotent-write.js";
import { isAlreadyKnownError } from "../contracts/nonce-manager.js";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const SER = ("0x" + "cd".repeat(50)) as `0x${string}`;

describe("isAlreadyKnownError", () => {
  it("matches already-known / already-imported style messages (case-insensitive, nested)", () => {
    for (const m of [
      "already known",
      "ALREADY KNOWN",
      "transaction already exists",
      "already imported",
      "known transaction",
    ]) {
      expect(isAlreadyKnownError(new Error(m))).toBe(true);
    }
    // viem-style nested field
    expect(isAlreadyKnownError({ details: "known transaction: 0xabc" })).toBe(true);
  });

  it("does NOT match a bare nonce-too-low, a revert, or funds errors", () => {
    expect(isAlreadyKnownError(new Error("nonce too low"))).toBe(false);
    expect(isAlreadyKnownError(new Error("execution reverted"))).toBe(false);
    expect(isAlreadyKnownError(new Error("insufficient funds for gas"))).toBe(false);
  });
});

describe("classifyBroadcastError", () => {
  it("already-known → idempotent (checked before the broader nonce set)", () => {
    expect(classifyBroadcastError(new Error("already known"))).toBe("idempotent");
  });
  it("nonce-too-low / replacement-underpriced → confirm", () => {
    expect(classifyBroadcastError(new Error("nonce too low"))).toBe("confirm");
    expect(classifyBroadcastError(new Error("replacement transaction underpriced"))).toBe("confirm");
  });
  it("reverts and other failures → rethrow", () => {
    expect(classifyBroadcastError(new Error("execution reverted"))).toBe("rethrow");
    expect(classifyBroadcastError(new Error("insufficient funds"))).toBe("rethrow");
    expect(classifyBroadcastError(new Error("fetch failed"))).toBe("rethrow");
  });
});

describe("resolveBroadcastOutcome", () => {
  it("already-known resolves to the pre-computed hash WITHOUT any on-chain lookup", async () => {
    const confirm = vi.fn();
    await expect(resolveBroadcastOutcome(new Error("already known"), HASH, confirm)).resolves.toBe(HASH);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("nonce-too-low + our tx confirmed on-chain → resolves to the hash", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(resolveBroadcastOutcome(new Error("nonce too low"), HASH, confirm)).resolves.toBe(HASH);
    expect(confirm).toHaveBeenCalledWith(HASH);
  });

  it("nonce-too-low + a DIFFERENT tx took the nonce → rethrows the original error", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    await expect(
      resolveBroadcastOutcome(new Error("nonce too low: tx 8, state 9"), HASH, confirm),
    ).rejects.toThrow(/nonce too low/);
    expect(confirm).toHaveBeenCalledWith(HASH);
  });

  it("a non-nonce failure rethrows without any on-chain lookup", async () => {
    const confirm = vi.fn();
    await expect(
      resolveBroadcastOutcome(new Error("execution reverted: window not passed"), HASH, confirm),
    ).rejects.toThrow(/reverted/);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("broadcastIdempotent", () => {
  const makeDeps = (over: Partial<IdempotentBroadcast> = {}): IdempotentBroadcast => ({
    sign: vi.fn(async () => ({ serialized: SER, hash: HASH })),
    send: vi.fn(async () => {}),
    confirmOnChain: vi.fn(async () => false),
    ...over,
  });

  it("happy path: signs once for the nonce, sends those bytes, returns the hash", async () => {
    const deps = makeDeps();
    await expect(broadcastIdempotent(11, deps)).resolves.toBe(HASH);
    expect(deps.sign).toHaveBeenCalledTimes(1);
    expect(deps.sign).toHaveBeenCalledWith(11);
    expect(deps.send).toHaveBeenCalledWith(SER);
    expect(deps.confirmOnChain).not.toHaveBeenCalled();
  });

  it("`already known` on send → idempotent success; tx signed ONCE (never re-signed on retry)", async () => {
    const deps = makeDeps({
      send: vi.fn(async () => {
        throw new Error("already known");
      }),
    });
    await expect(broadcastIdempotent(7, deps)).resolves.toBe(HASH);
    expect(deps.sign).toHaveBeenCalledTimes(1);
    expect(deps.confirmOnChain).not.toHaveBeenCalled();
  });

  it("`nonce too low` + our tx confirmed on-chain → resolves to the hash", async () => {
    const deps = makeDeps({
      send: vi.fn(async () => {
        throw new Error("nonce too low");
      }),
      confirmOnChain: vi.fn(async () => true),
    });
    await expect(broadcastIdempotent(7, deps)).resolves.toBe(HASH);
    expect(deps.confirmOnChain).toHaveBeenCalledWith(HASH);
  });

  it("`nonce too low` + a different tx on the nonce → rethrows so the manager re-seeds", async () => {
    const deps = makeDeps({
      send: vi.fn(async () => {
        throw new Error("nonce too low");
      }),
      // confirmOnChain defaults to false → not our tx
    });
    await expect(broadcastIdempotent(7, deps)).rejects.toThrow(/nonce too low/);
    expect(deps.sign).toHaveBeenCalledTimes(1);
    expect(deps.confirmOnChain).toHaveBeenCalledWith(HASH);
  });

  it("a revert propagates unchanged (not a nonce/idempotency case)", async () => {
    const deps = makeDeps({
      send: vi.fn(async () => {
        throw new Error("execution reverted: challenge window not passed");
      }),
    });
    await expect(broadcastIdempotent(7, deps)).rejects.toThrow(/reverted/);
    expect(deps.confirmOnChain).not.toHaveBeenCalled();
  });
});
