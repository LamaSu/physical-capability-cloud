/**
 * S4 — mock oracle HONESTY (fail-closed, structural degradation).
 *
 * The gateway's mock oracle (used when no PCC_ORACLE_KEY is configured, or — pre-fix
 * — when a non-hex escrow was passed) used to fabricate `verified:true` with a
 * real-shaped attestation and every check invented true, carrying only a `reason`
 * string a caller could ignore. Because the settlement crank gates on exactly
 * `result.verified` (paid-job-flow.ts:1195 / :1611), a mock escrow could drive a
 * paid job to "verified"/"settled" on an invented verdict — the S4 two-truths hazard.
 *
 * These tests pin the honest behaviour:
 *   1. Any PAID tier (assuranceTier >= 1) in mock mode fails CLOSED (verified:false,
 *      no fabricated attestation), so the crank's existing gate rejects it.
 *   2. Tier 0 (self-attested dev floor) may still pass, but is STRUCTURALLY marked
 *      `mode:"mock"` / `degraded:true` — never mistakable for a real verdict.
 *   3. With a real oracle key set, a non-hex / "mock"-prefixed escrow is a hard
 *      ERROR (bad input), not a silent mock pass — a data value cannot bypass a
 *      configured real oracle.
 *
 * All deterministic: the mock path makes no network call, and the real-key guard
 * throws BEFORE any fetch, so no oracle server is required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const REAL_ESCROW = "0x" + "ab".repeat(20); // 20-byte hex address
const EVIDENCE = "0x" + "cd".repeat(32);

const ORIG_ORACLE_KEY = process.env.PCC_ORACLE_KEY;

function baseRequest(over: Record<string, unknown> = {}) {
  return {
    escrowAddress: ZERO_ADDR,
    jobId: "job-s4",
    kernelId: "kernel-s4",
    evidenceHash: EVIDENCE,
    assuranceTier: 0,
    chainId: 84532,
    ...over,
  };
}

// ===========================================================================
// Degraded fallback (no PCC_ORACLE_KEY) — mock path
// ===========================================================================

describe("mock oracle honesty — degraded fallback (no PCC_ORACLE_KEY)", () => {
  beforeEach(() => {
    vi.resetModules();
    // No key => verifyWithOracle routes to mockVerification (deterministic).
    delete process.env.PCC_ORACLE_KEY;
  });

  afterEach(() => {
    if (ORIG_ORACLE_KEY === undefined) delete process.env.PCC_ORACLE_KEY;
    else process.env.PCC_ORACLE_KEY = ORIG_ORACLE_KEY;
  });

  it("tier 0 still passes BUT is structurally flagged mode:mock / degraded:true", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle(baseRequest({ assuranceTier: 0 }));

    expect(res.result.verified).toBe(true); // dev/prototype floor may proceed
    expect(res.result.reason).toBe("mock_verification");
    // ...but it must NOT be mistakable for a real verdict:
    expect(res.mode).toBe("mock");
    expect(res.degraded).toBe(true);
    expect(typeof res.degraded).toBe("boolean"); // structural, not a reason string
    expect(res.attestation).not.toBeNull(); // mock (all-zero signature) dev attestation
    expect(res.attestation?.signature).toBe("0x" + "0".repeat(130));
  });

  it("tier 1 (paid) FAILS CLOSED — verified:false, no fabricated attestation, degraded", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle(baseRequest({ assuranceTier: 1 }));

    // This is the exact field the settlement crank gates on
    // (paid-job-flow.ts: `if (!oracleResponse.result.verified) return 422`).
    expect(res.result.verified).toBe(false);
    expect(res.result.reason).toBe("mock_verification_refused_paid_tier");
    expect(res.attestation).toBeNull(); // no self-invented, bindable attestation
    expect(res.mode).toBe("mock");
    expect(res.degraded).toBe(true);
    // No invented all-true checks:
    expect(Object.values(res.result.checks).every((c) => c === false)).toBe(true);
  });

  it("tiers 2 and 3 (paid) also fail closed", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    for (const tier of [2, 3]) {
      const res = await verifyWithOracle(baseRequest({ assuranceTier: tier, jobId: `job-t${tier}` }));
      expect(res.result.verified).toBe(false);
      expect(res.degraded).toBe(true);
      expect(res.attestation).toBeNull();
    }
  });

  it("a paid-tier mint request does NOT fabricate a bindable easAttestation UID", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle(
      baseRequest({ assuranceTier: 2, mintEasAttestation: true, stepId: "0x" + "cc".repeat(32) }),
    );
    expect(res.result.verified).toBe(false);
    expect(res.easAttestation ?? null).toBeNull();
  });

  it("tier 0 mint request still returns a mock easAttestation (dev orchestration path intact)", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle(
      baseRequest({ assuranceTier: 0, mintEasAttestation: true, stepId: "0x" + "cc".repeat(32) }),
    );
    expect(res.result.verified).toBe(true);
    expect(res.easAttestation).not.toBeNull();
    expect(res.easAttestation?.easUid).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ===========================================================================
// Real-key guard — a non-hex/mock escrow can't bypass a configured oracle
// ===========================================================================

describe("mock oracle honesty — real-key guard (PCC_ORACLE_KEY set)", () => {
  beforeEach(() => {
    vi.resetModules();
    // ORACLE_KEY is read at module load, so set it BEFORE the dynamic import.
    process.env.PCC_ORACLE_KEY = "test-oracle-key";
  });

  afterEach(() => {
    if (ORIG_ORACLE_KEY === undefined) delete process.env.PCC_ORACLE_KEY;
    else process.env.PCC_ORACLE_KEY = ORIG_ORACLE_KEY;
  });

  it("throws (bad input) for a non-hex escrow instead of fabricating a mock pass", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    await expect(
      verifyWithOracle(baseRequest({ escrowAddress: "not-a-hex-escrow", assuranceTier: 1 })),
    ).rejects.toThrow(/not a hex on-chain address|refusing to fabricate/i);
  });

  it("throws for a 'mock'-prefixed escrow instead of fabricating a mock pass", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    await expect(
      verifyWithOracle(baseRequest({ escrowAddress: "mock-escrow-123", assuranceTier: 0 })),
    ).rejects.toThrow(/refusing to fabricate|not a hex/i);
  });

  it("the guard fires even at tier 0 (data value must not bypass a configured oracle)", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    await expect(
      verifyWithOracle(baseRequest({ escrowAddress: "mockEscrow", assuranceTier: 0 })),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// Provenance contract — a real oracle response is NOT flagged degraded
// ===========================================================================

describe("mock oracle honesty — provenance contract", () => {
  it("degraded/mode are optional so a real oracle response (no flags) reads as live", async () => {
    // A live server response omits mode/degraded; absence must mean "live".
    const liveLike: import("../services/oracle-client.js").OracleResponse = {
      result: { verified: true, tier: 1, reason: "ok", checks: { real: true } },
      attestation: null,
      oracle: REAL_ESCROW,
      chainId: 84532,
    };
    expect(liveLike.degraded ?? false).toBe(false);
    expect(liveLike.mode ?? "live").toBe("live");
  });
});
