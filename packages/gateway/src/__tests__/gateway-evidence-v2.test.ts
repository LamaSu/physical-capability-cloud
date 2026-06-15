/**
 * Tests for the gateway oracle.evidence.v2 + verification-modes DRAFT.
 *
 * Covers (additive — does not touch v1 behavior):
 *   1. v2 schema params shape (encode/decode round-trip with fee fields)
 *   2. buildEasAttestationMetadataV2 includes feeBps + feeRecipient
 *   3. selectVerificationMode rules (tier 0/1/2/3 + intent)
 *   4. Mode A invokes V3 stub approveAndRelease calldata
 *   5. Mode B unchanged (calls verifyWithOracle)
 *   6. Mode C routes to dispute
 *   7. Flag-off: v2 helpers still exported; Mode A/C return FLAG_OFF;
 *      Mode B always executes (back-compat)
 *   8. status.ts reports lit network as "chipotle" (not stale "datil-dev")
 *
 * No on-chain calls, no real network. Oracle calls run through
 * mockVerification (no PCC_ORACLE_KEY set).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { decodeFunctionData } from "viem";

import {
  PCC_EVIDENCE_SCHEMA_V2,
  encodeEasEvidencePayloadV2,
  decodeEasEvidencePayloadV2,
  buildEasAttestationMetadataV2,
  isEvidenceV2Enabled,
  stringToBytes32Id,
  bundleHashToBytes32,
  type EasEvidencePayloadV2,
} from "../services/oracle-client.js";

import {
  selectVerificationMode,
  runVerification,
  verifyWithMode,
  encodeApproveAndReleaseV3,
  MilestoneEscrowV3ABIStub,
} from "../services/verification-mode.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const TREASURY = "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B";

const ORIG_FLAG = process.env.PCC_EVIDENCE_V2_ENABLED;
const ORIG_ORACLE_KEY = process.env.PCC_ORACLE_KEY;

// ===========================================================================
// 1 — v2 schema params shape (encode/decode round-trip with fee fields)
// ===========================================================================

describe("oracle.evidence.v2 schema params", () => {
  it("round-trips a v2 payload (encode -> decode) including feeBps + feeRecipient", () => {
    const payload: EasEvidencePayloadV2 = {
      jobId: "job-v2-1",
      kernelId: ("0x" + "aa".repeat(32)) as `0x${string}`,
      evidenceBundleHash: ("0x" + "bb".repeat(32)) as `0x${string}`,
      ipfsCid: "bafytest",
      assuranceTier: 2,
      oracleVerified: true,
      stepId: ("0x" + "cc".repeat(32)) as `0x${string}`,
      feeBps: 235,
      feeRecipient: TREASURY as `0x${string}`,
    };

    const encoded = encodeEasEvidencePayloadV2(payload);
    const decoded = decodeEasEvidencePayloadV2(encoded);

    // Bytes32 fields preserved.
    expect(decoded.jobId).toBe("job-v2-1");
    expect(decoded.kernelId).toBe(payload.kernelId);
    expect(decoded.evidenceBundleHash).toBe(payload.evidenceBundleHash);
    expect(decoded.ipfsCid).toBe("bafytest");
    expect(decoded.assuranceTier).toBe(2);
    expect(decoded.oracleVerified).toBe(true);
    expect(decoded.stepId).toBe(payload.stepId);
    // New v2 fields preserved.
    expect(decoded.feeBps).toBe(235);
    expect(decoded.feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());
  });

  it("PCC_EVIDENCE_SCHEMA_V2 contains the v1 fields PLUS feeBps + feeRecipient", () => {
    // v1 fields (must appear first, same order).
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("string jobId");
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("bytes32 kernelId");
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("bytes32 evidenceBundleHash");
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("string ipfsCid");
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("uint8 assuranceTier");
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("bool oracleVerified");
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("bytes32 stepId");
    // New v2 fields trailing.
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("uint16 feeBps");
    expect(PCC_EVIDENCE_SCHEMA_V2).toContain("address feeRecipient");
    // Tail order: feeBps appears BEFORE feeRecipient.
    const fbIdx = PCC_EVIDENCE_SCHEMA_V2.indexOf("uint16 feeBps");
    const frIdx = PCC_EVIDENCE_SCHEMA_V2.indexOf("address feeRecipient");
    expect(fbIdx).toBeGreaterThan(0);
    expect(frIdx).toBeGreaterThan(fbIdx);
  });

  it("decodeEasEvidencePayloadV2 returns numbers for feeBps (not bigint)", () => {
    const payload: EasEvidencePayloadV2 = {
      jobId: "j",
      kernelId: ("0x" + "00".repeat(32)) as `0x${string}`,
      evidenceBundleHash: ("0x" + "01".repeat(32)) as `0x${string}`,
      ipfsCid: "",
      assuranceTier: 1,
      oracleVerified: false,
      stepId: ("0x" + "02".repeat(32)) as `0x${string}`,
      feeBps: 9999,
      feeRecipient: ZERO_ADDR as `0x${string}`,
    };
    const decoded = decodeEasEvidencePayloadV2(encodeEasEvidencePayloadV2(payload));
    expect(typeof decoded.feeBps).toBe("number");
    expect(decoded.feeBps).toBe(9999);
  });
});

// ===========================================================================
// 2 — buildEasAttestationMetadataV2 includes feeBps + feeRecipient
// ===========================================================================

describe("buildEasAttestationMetadataV2", () => {
  it("produces a v2 metadata bundle with feeBps + feeRecipient in the encoded payload", () => {
    const meta = buildEasAttestationMetadataV2({
      jobId: "job-1",
      kernelId: "kernel-sf",
      stepId: "milestone-0",
      evidenceBundleHash: "sha256:" + "ab".repeat(32),
      ipfsCid: "bafycid",
      assuranceTier: 1,
      oracleVerified: true,
      recipient: "0xDeAdBeEf00000000000000000000000000000001",
      feeBps: 235,
      feeRecipient: TREASURY,
    });

    expect(meta.schema).toBe(PCC_EVIDENCE_SCHEMA_V2);
    expect(meta.schemaVersion).toBe("v2");
    expect(meta.recipient).toBe("0xDeAdBeEf00000000000000000000000000000001");

    const back = decodeEasEvidencePayloadV2(meta.encoded);
    expect(back.jobId).toBe("job-1");
    expect(back.ipfsCid).toBe("bafycid");
    expect(back.assuranceTier).toBe(1);
    expect(back.oracleVerified).toBe(true);
    expect(back.feeBps).toBe(235);
    expect(back.feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());

    // Hash derivation matches the v1 contract derivation rules.
    expect(back.kernelId).toBe(stringToBytes32Id("kernel-sf"));
    expect(back.stepId).toBe(stringToBytes32Id("milestone-0"));
    expect(back.evidenceBundleHash).toBe(bundleHashToBytes32("sha256:" + "ab".repeat(32)));
  });

  it("accepts a feeRecipient without 0x prefix and normalizes it", () => {
    const meta = buildEasAttestationMetadataV2({
      jobId: "j",
      kernelId: "k",
      stepId: "s",
      evidenceBundleHash: "sha256:" + "00".repeat(32),
      ipfsCid: "",
      assuranceTier: 0,
      oracleVerified: true,
      feeBps: 100,
      feeRecipient: TREASURY.slice(2), // no 0x
    });
    const decoded = decodeEasEvidencePayloadV2(meta.encoded);
    expect(decoded.feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());
  });

  it("uses PCC_EVIDENCE_SCHEMA_V2_UID env when no schemaUidV2 is passed", () => {
    const ORIG = process.env.PCC_EVIDENCE_SCHEMA_V2_UID;
    process.env.PCC_EVIDENCE_SCHEMA_V2_UID = "0x" + "11".repeat(32);
    try {
      const meta = buildEasAttestationMetadataV2({
        jobId: "j",
        kernelId: "k",
        stepId: "s",
        evidenceBundleHash: "sha256:" + "00".repeat(32),
        ipfsCid: "",
        assuranceTier: 0,
        oracleVerified: true,
        feeBps: 100,
        feeRecipient: TREASURY,
      });
      expect(meta.schemaUid).toBe("0x" + "11".repeat(32));
    } finally {
      if (ORIG === undefined) delete process.env.PCC_EVIDENCE_SCHEMA_V2_UID;
      else process.env.PCC_EVIDENCE_SCHEMA_V2_UID = ORIG;
    }
  });
});

// ===========================================================================
// 3 — selectVerificationMode rules (tier 0,1,2,3 + intent)
// ===========================================================================

describe("selectVerificationMode", () => {
  it("intent=dispute always routes to Mode C, regardless of tier", () => {
    for (const tier of [0, 1, 2, 3]) {
      const out = selectVerificationMode({ assuranceTier: tier, intent: "dispute" });
      expect(out.mode).toBe("C");
      expect(out.rationale).toContain("dispute");
    }
  });

  it("tier 0 + intent=settle (or default) routes to Mode A (user-attested)", () => {
    const out = selectVerificationMode({ assuranceTier: 0 });
    expect(out.mode).toBe("A");
    expect(out.rationale).toContain("user-verifiable");
  });

  it("tier 1 + intent=settle routes to Mode A (user-attested)", () => {
    const out = selectVerificationMode({ assuranceTier: 1, intent: "settle" });
    expect(out.mode).toBe("A");
  });

  it("tier 2 routes to Mode B (oracle — regulated)", () => {
    const out = selectVerificationMode({ assuranceTier: 2 });
    expect(out.mode).toBe("B");
    expect(out.rationale).toContain("regulated");
  });

  it("tier 3 routes to Mode B (oracle — regulated)", () => {
    const out = selectVerificationMode({ assuranceTier: 3 });
    expect(out.mode).toBe("B");
  });

  it("unknown high tier (>3) safely routes to Mode B (regulated catch-all)", () => {
    // Any tier >= 2 falls into the regulated rule; 99 is caught there before
    // the unknown-tier safe default.
    const out = selectVerificationMode({ assuranceTier: 99 });
    expect(out.mode).toBe("B");
    expect(out.rationale).toContain("regulated");
  });

  it("unknown negative tier (<0) safely routes to Mode B (fallback safe default)", () => {
    // Negative tiers don't match any of the explicit branches; the fallback
    // rule catches them and picks B (never lower the bar silently).
    const out = selectVerificationMode({ assuranceTier: -1 });
    expect(out.mode).toBe("B");
    expect(out.rationale).toContain("default");
  });
});

// ===========================================================================
// 4 — Mode A invokes V3 stub approveAndRelease calldata
// ===========================================================================

describe("Mode A — payer-approval release (V3 stub)", () => {
  beforeEach(() => {
    process.env.PCC_EVIDENCE_V2_ENABLED = "true";
  });
  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.PCC_EVIDENCE_V2_ENABLED;
    else process.env.PCC_EVIDENCE_V2_ENABLED = ORIG_FLAG;
  });

  it("encodeApproveAndReleaseV3 produces decodable calldata for the V3 ABI stub", () => {
    const data = encodeApproveAndReleaseV3(7);
    expect(data.startsWith("0x")).toBe(true);

    const decoded = decodeFunctionData({ abi: MilestoneEscrowV3ABIStub, data });
    expect(decoded.functionName).toBe("approveAndRelease");
    expect(decoded.args?.[0]).toBe(7n);
  });

  it("runVerification(Mode A) returns the V3 calldata + escrow target (no tx sent)", async () => {
    const res = await runVerification({
      mode: "A",
      escrowAddress: "0xDeAdBeEf00000000000000000000000000000002",
      milestoneIndex: 0,
      proofNote: "operator delivered: ipfs://bafyproof",
    });

    expect(res.mode).toBe("A");
    if (res.mode !== "A") throw new Error("type narrow");
    expect(res.escrowAddress).toBe("0xDeAdBeEf00000000000000000000000000000002");
    expect(res.milestoneIndex).toBe(0);
    expect(res.calldata.startsWith("0x")).toBe(true);
    expect(res.payerInstruction).toContain("ipfs://bafyproof");

    // The calldata is decodable by the V3 ABI stub.
    const decoded = decodeFunctionData({
      abi: MilestoneEscrowV3ABIStub,
      data: res.calldata,
    });
    expect(decoded.functionName).toBe("approveAndRelease");
    expect(decoded.args?.[0]).toBe(0n);
  });
});

// ===========================================================================
// 5 — Mode B unchanged (calls verifyWithOracle, mock path)
// ===========================================================================

describe("Mode B — oracle-attested (legacy default)", () => {
  beforeEach(() => {
    // No oracle key => mockVerification path (deterministic, no network).
    delete process.env.PCC_ORACLE_KEY;
  });
  afterEach(() => {
    if (ORIG_ORACLE_KEY === undefined) delete process.env.PCC_ORACLE_KEY;
    else process.env.PCC_ORACLE_KEY = ORIG_ORACLE_KEY;
  });

  it("runVerification(Mode B) calls verifyWithOracle (mock) and returns the OracleResponse", async () => {
    const res = await runVerification({
      mode: "B",
      oracleRequest: {
        escrowAddress: ZERO_ADDR,
        jobId: "job-b",
        kernelId: "kernel-x",
        evidenceHash: "0x" + "ab".repeat(32),
        assuranceTier: 2,
        chainId: 84532,
      },
    });

    expect(res.mode).toBe("B");
    if (res.mode !== "B") throw new Error("type narrow");
    expect(res.oracle.result.verified).toBe(true);
    expect(res.oracle.attestation).not.toBeNull();
    expect(res.oracle.result.reason).toBe("mock_verification");
  });

  it("Mode B works regardless of PCC_EVIDENCE_V2_ENABLED (back-compat)", async () => {
    delete process.env.PCC_EVIDENCE_V2_ENABLED;
    const res = await runVerification({
      mode: "B",
      oracleRequest: {
        escrowAddress: ZERO_ADDR,
        jobId: "job-b-noflag",
        kernelId: "kernel-x",
        evidenceHash: "0x" + "ab".repeat(32),
        assuranceTier: 0,
        chainId: 84532,
      },
    });
    expect(res.mode).toBe("B");
  });
});

// ===========================================================================
// 6 — Mode C routes to dispute marker
// ===========================================================================

describe("Mode C — dispute routing", () => {
  beforeEach(() => {
    process.env.PCC_EVIDENCE_V2_ENABLED = "true";
  });
  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.PCC_EVIDENCE_V2_ENABLED;
    else process.env.PCC_EVIDENCE_V2_ENABLED = ORIG_FLAG;
  });

  it("runVerification(Mode C) returns a dispute routing marker (no juror pool yet)", async () => {
    const res = await runVerification({
      mode: "C",
      reason: "user_claims_evidence_insufficient",
    });

    expect(res.mode).toBe("C");
    if (res.mode !== "C") throw new Error("type narrow");
    expect(res.route).toBe("dispute");
    expect(res.next).toBe("oracle-dispute");
    expect(res.reason).toBe("user_claims_evidence_insufficient");
  });
});

// ===========================================================================
// 7 — Flag-off behavior (back-compat guarantee)
// ===========================================================================

describe("PCC_EVIDENCE_V2_ENABLED flag gating", () => {
  beforeEach(() => {
    delete process.env.PCC_EVIDENCE_V2_ENABLED;
    delete process.env.PCC_ORACLE_KEY;
  });
  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.PCC_EVIDENCE_V2_ENABLED;
    else process.env.PCC_EVIDENCE_V2_ENABLED = ORIG_FLAG;
    if (ORIG_ORACLE_KEY === undefined) delete process.env.PCC_ORACLE_KEY;
    else process.env.PCC_ORACLE_KEY = ORIG_ORACLE_KEY;
  });

  it("isEvidenceV2Enabled() is false when flag is unset", () => {
    expect(isEvidenceV2Enabled()).toBe(false);
  });

  it("isEvidenceV2Enabled() is true when flag is 'true'", () => {
    process.env.PCC_EVIDENCE_V2_ENABLED = "true";
    expect(isEvidenceV2Enabled()).toBe(true);
  });

  it("v2 schema + builders are exported even when flag is off (additive only)", () => {
    // The flag gates BEHAVIOR (route dispatch), not the existence of helpers.
    // Live tests in earlier blocks already exercise the helpers; this is a
    // belt-and-suspenders existence check.
    expect(typeof encodeEasEvidencePayloadV2).toBe("function");
    expect(typeof buildEasAttestationMetadataV2).toBe("function");
    expect(PCC_EVIDENCE_SCHEMA_V2.length).toBeGreaterThan(0);
  });

  it("runVerification(Mode A) returns FLAG_OFF when flag is unset", async () => {
    const res = await runVerification({
      mode: "A",
      escrowAddress: ZERO_ADDR,
      milestoneIndex: 0,
    });
    expect(res.mode).toBe("FLAG_OFF");
    if (res.mode !== "FLAG_OFF") throw new Error("type narrow");
    expect(res.reason).toContain("PCC_EVIDENCE_V2_ENABLED");
  });

  it("runVerification(Mode C) returns FLAG_OFF when flag is unset", async () => {
    const res = await runVerification({
      mode: "C",
      reason: "test_dispute",
    });
    expect(res.mode).toBe("FLAG_OFF");
  });

  it("runVerification(Mode B) ALWAYS runs (back-compat — flag-independent)", async () => {
    // Mode B is the legacy default. Forcing FLAG_OFF on it would break
    // every existing pcc-node client. The flag only gates A + C.
    const res = await runVerification({
      mode: "B",
      oracleRequest: {
        escrowAddress: ZERO_ADDR,
        jobId: "job-b-flag-off",
        kernelId: "kernel-x",
        evidenceHash: "0x" + "ab".repeat(32),
        assuranceTier: 2,
        chainId: 84532,
      },
    });
    expect(res.mode).toBe("B");
  });
});

// ===========================================================================
// 8 — verifyWithMode end-to-end helper
// ===========================================================================

describe("verifyWithMode (select + run)", () => {
  beforeEach(() => {
    process.env.PCC_EVIDENCE_V2_ENABLED = "true";
    delete process.env.PCC_ORACLE_KEY;
  });
  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.PCC_EVIDENCE_V2_ENABLED;
    else process.env.PCC_EVIDENCE_V2_ENABLED = ORIG_FLAG;
    if (ORIG_ORACLE_KEY === undefined) delete process.env.PCC_ORACLE_KEY;
    else process.env.PCC_ORACLE_KEY = ORIG_ORACLE_KEY;
  });

  it("tier 0 + settle picks Mode A and emits V3 calldata", async () => {
    const out = await verifyWithMode({
      assuranceTier: 0,
      intent: "settle",
      modeAInput: {
        escrowAddress: "0xDeAdBeEf00000000000000000000000000000003",
        milestoneIndex: 1,
      },
    });
    expect(out.selection.mode).toBe("A");
    expect(out.result.mode).toBe("A");
    if (out.result.mode !== "A") throw new Error("type narrow");
    expect(out.result.milestoneIndex).toBe(1);
  });

  it("tier 3 + settle picks Mode B and calls the oracle (mock)", async () => {
    const out = await verifyWithMode({
      assuranceTier: 3,
      intent: "settle",
      modeBInput: {
        oracleRequest: {
          escrowAddress: ZERO_ADDR,
          jobId: "job-vwm-b",
          kernelId: "k",
          evidenceHash: "0x" + "ab".repeat(32),
          assuranceTier: 3,
          chainId: 84532,
        },
      },
    });
    expect(out.selection.mode).toBe("B");
    expect(out.result.mode).toBe("B");
    if (out.result.mode !== "B") throw new Error("type narrow");
    expect(out.result.oracle.result.verified).toBe(true);
  });

  it("intent=dispute picks Mode C", async () => {
    const out = await verifyWithMode({
      assuranceTier: 1,
      intent: "dispute",
      modeCInput: { reason: "bad_evidence" },
    });
    expect(out.selection.mode).toBe("C");
    expect(out.result.mode).toBe("C");
  });

  it("throws a helpful error when the chosen mode's input is missing", async () => {
    await expect(
      verifyWithMode({
        assuranceTier: 0,
        intent: "settle",
        // Note: no modeAInput provided.
      }),
    ).rejects.toThrow(/modeAInput/);
  });
});

// ===========================================================================
// 9 — status.ts reports lit network as "chipotle" (not stale "datil-dev")
// ===========================================================================

describe("status.ts lit network label (#058 cleanup)", () => {
  it("/api/status/live reports network=chipotle when LIT_PROTOCOL_REAL=true", async () => {
    // Read the status.ts source — it's small, static, and the routes need a
    // full server harness to exercise. The label fix is a string-level
    // change; a source assertion is the right granularity here.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const here = path.dirname(new URL(import.meta.url).pathname);
    const statusPath = path.resolve(here, "..", "routes", "status.ts");
    const src = await fs.readFile(statusPath, "utf-8");

    // The fixed branch picks "chipotle" when litReal is true.
    expect(src).toContain('litReal ? "chipotle" : "none"');
    // The stale "datil-dev" literal must NOT appear anywhere in status.ts.
    expect(src).not.toContain("datil-dev");
    // The details string also references "Chipotle" (not "Datil-dev").
    expect(src).toContain("Chipotle threshold encryption");
    expect(src).not.toContain("Datil-dev threshold encryption");
  });
});
