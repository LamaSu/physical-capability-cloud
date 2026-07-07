import { describe, it, expect } from "vitest";
import {
  deriveActivityKey,
  deriveOnchainOpKey,
  encodeOnchainOpArgs,
} from "../../src/activity/idempotency-key.js";
import { keccak256Hex, sha256Hex } from "../../src/shared/hash.js";
import { canonicalJSON } from "../../src/shared/canonical-json.js";

describe("deriveActivityKey — 3-tier fallback", () => {
  it("client-provided key wins + produces http: scope", () => {
    const { key, scope } = deriveActivityKey({
      activityName: "fund-escrow",
      workflowRunId: "run-1",
      args: [{ a: 1 }],
      attemptNumber: 1,
      clientProvidedKey: "cli-abc-123",
      actorId: "operator:0xabc",
      httpMethod: "POST",
      httpPath: "/api/escrow/fund",
    });
    expect(key).toBe("cli-abc-123");
    expect(scope).toBe("http:operator:0xabc:POST:/api/escrow/fund");
  });

  it("client-provided key uses sensible defaults for missing http metadata", () => {
    const { scope } = deriveActivityKey({
      activityName: "x",
      workflowRunId: "r",
      args: [],
      attemptNumber: 1,
      clientProvidedKey: "k",
    });
    // default actor=system, method=POST, path=/unknown
    expect(scope).toBe("http:system:POST:/unknown");
  });

  it("without clientProvidedKey falls through to sha256 content addressing", () => {
    const ctx = {
      activityName: "upload-evidence",
      workflowRunId: "run-42",
      args: { bundleId: "B1" },
      attemptNumber: 1,
    };
    const { key, scope } = deriveActivityKey(ctx);
    expect(scope).toBe("workflow:activity:upload-evidence");
    // 64-char sha256 hex
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Recompute manually and match
    const expected = sha256Hex(
      canonicalJSON({
        activityName: "upload-evidence",
        args: { bundleId: "B1" },
        workflowRunId: "run-42",
        attemptNumber: 1,
      } as never),
    );
    expect(key).toBe(expected);
  });

  it("same args in different key order yields same sha256 key (canonical JSON)", () => {
    const a = deriveActivityKey({
      activityName: "x",
      workflowRunId: "r",
      args: { a: 1, b: 2 },
      attemptNumber: 1,
    });
    const b = deriveActivityKey({
      activityName: "x",
      workflowRunId: "r",
      args: { b: 2, a: 1 },
      attemptNumber: 1,
    });
    expect(a.key).toBe(b.key);
  });

  it("different attemptNumber yields a different key", () => {
    const a = deriveActivityKey({
      activityName: "x",
      workflowRunId: "r",
      args: {},
      attemptNumber: 1,
    });
    const b = deriveActivityKey({
      activityName: "x",
      workflowRunId: "r",
      args: {},
      attemptNumber: 2,
    });
    expect(a.key).not.toBe(b.key);
  });
});

describe("deriveOnchainOpKey — EVM semantic key", () => {
  const jobId = ("0x" + "ab".repeat(32)) as `0x${string}`;

  it("returns a 0x-prefixed keccak256 hex with onchain:escrow scope", () => {
    const { key, scope } = deriveOnchainOpKey({
      jobId,
      milestoneIdx: 0,
      action: "fund",
    });
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(scope).toBe("onchain:escrow");
  });

  it("default attempt is 1 — handler-supplied ctx.attempt MUST NOT influence the key", () => {
    const a = deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "fund" });
    const b = deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "fund", attempt: 1 });
    expect(a.key).toBe(b.key);
  });

  it("different actions yield different keys", () => {
    const a = deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "fund" });
    const b = deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "release" });
    expect(a.key).not.toBe(b.key);
  });

  it("different milestoneIdx yields different keys", () => {
    const a = deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "fund" });
    const b = deriveOnchainOpKey({ jobId, milestoneIdx: 1, action: "fund" });
    expect(a.key).not.toBe(b.key);
  });

  it("attempt=2 (fencing bump) yields a different key from the default", () => {
    const a = deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "fund" });
    const b = deriveOnchainOpKey({ jobId, milestoneIdx: 0, action: "fund", attempt: 2 });
    expect(a.key).not.toBe(b.key);
  });
});

describe("encodeOnchainOpArgs", () => {
  it("returns bytes whose keccak matches deriveOnchainOpKey", () => {
    const args = {
      jobId: ("0x" + "11".repeat(32)) as `0x${string}`,
      milestoneIdx: 3,
      action: "fund",
      attempt: 1,
    };
    const encoded = encodeOnchainOpArgs(args);
    const expected = keccak256Hex(encoded);
    const { key } = deriveOnchainOpKey(args);
    expect(key).toBe(expected);
  });

  it("rejects a jobId that is not exactly 32 bytes", () => {
    const tooShort = "0xab" as `0x${string}`;
    expect(() =>
      encodeOnchainOpArgs({ jobId: tooShort, milestoneIdx: 0, action: "fund", attempt: 1 }),
    ).toThrow(/bytes32/);
  });

  it("head layout is exactly 160 bytes before dynamic tail for short actions", () => {
    // head = jobId(32) + milestoneIdx(32) + offset(32) + attempt(32) + length(32)
    // tail = padded action bytes (≥32 for any non-empty, short action)
    const bytes = encodeOnchainOpArgs({
      jobId: ("0x" + "aa".repeat(32)) as `0x${string}`,
      milestoneIdx: 0,
      action: "a",
      attempt: 1,
    });
    // 4*32 head + 32 length word + 32 padded action = 192
    expect(bytes.length).toBe(192);
    // Offset to action = 128 (sits at [64..96))
    // Read big-endian last 8 bytes of that word to confirm it encodes 128
    const offsetByte = bytes[95]!;
    expect(offsetByte).toBe(128);
  });

  it("accepts bigint milestoneIdx and attempt", () => {
    const bytes = encodeOnchainOpArgs({
      jobId: ("0x" + "cc".repeat(32)) as `0x${string}`,
      milestoneIdx: 999_999_999_999n,
      action: "release",
      attempt: 1n,
    });
    expect(bytes.length % 32).toBe(0);
  });
});

// ── E1 (BLOCKER): escrow activities pass a 20-byte ADDRESS or a non-hex job
// UUID as `jobId`, which the 32-byte guard rejects → every chain-write route
// 500s. The gateway fix converts to a canonical bytes32 before derivation:
// left-pad an address, keccak256 a string UUID. These tests mirror both
// strategies with the workflow's own helpers (no viem dep) and prove the
// derivation no longer throws AND is stable (same op → same key).
describe("deriveOnchainOpKey — E1: address / UUID → bytes32 conversion", () => {
  const ADDR20 = "0x1234567890abcdef1234567890abcdef12345678"; // 20 bytes

  it("a RAW 20-byte address throws (the exact break the gateway must guard)", () => {
    expect(() =>
      deriveOnchainOpKey({ jobId: ADDR20 as `0x${string}`, milestoneIdx: 0, action: "fund" }),
    ).toThrow(/bytes32/);
  });

  it("left-padding the address to bytes32 derives a stable key without throwing", () => {
    // Canonical `address as bytes32` = 12 zero bytes + the 20 address bytes.
    const padded = ("0x" + "00".repeat(12) + ADDR20.slice(2)) as `0x${string}`;
    const derive = () => deriveOnchainOpKey({ jobId: padded, milestoneIdx: 0, action: "fund" });
    expect(derive).not.toThrow();
    expect(derive().key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(derive().key).toBe(derive().key); // STABLE — same op → same key
  });

  it("keccak256 of a non-hex job UUID yields a valid bytes32 → stable key, no throw", () => {
    const jobId = keccak256Hex("job-abc-123-def-456") as `0x${string}`; // 0x + 64 hex
    const derive = () => deriveOnchainOpKey({ jobId, milestoneIdx: 2, action: "release" });
    expect(derive).not.toThrow();
    expect(derive().key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(derive().key).toBe(derive().key);
  });

  it("distinct (padded) addresses derive distinct keys — no cross-escrow collision", () => {
    const a = ("0x" + "00".repeat(12) + "aa".repeat(20)) as `0x${string}`;
    const b = ("0x" + "00".repeat(12) + "bb".repeat(20)) as `0x${string}`;
    const ka = deriveOnchainOpKey({ jobId: a, milestoneIdx: 0, action: "fund" }).key;
    const kb = deriveOnchainOpKey({ jobId: b, milestoneIdx: 0, action: "fund" }).key;
    expect(ka).not.toBe(kb);
  });
});
