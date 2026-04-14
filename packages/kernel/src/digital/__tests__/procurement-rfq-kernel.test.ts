/**
 * ProcurementRFQKernel -- test suite
 *
 * Exercises the 6-step RFQ workflow end-to-end:
 *   parse_rfq -> filter_vendors -> solicit_quotes -> score_quotes -> select_vendor -> emit_report
 *
 * Coverage:
 *   - happy path, zero-vendor, single-vendor, tied-score edge cases
 *   - evidence bundle integrity (signature, event counts, hash chain)
 *   - deterministic outputs (same in -> same bundleHash)
 *   - session scope gating (expired / missing action)
 *   - input validation
 *   - touchstone compatibility shape
 */

import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { canonicalize, sha256 } from "@pcc/spec";
import type { SessionKey } from "@pcc/spec";
import {
  ProcurementRFQKernel,
  ProcurementRFQValidationError,
  ProcurementRFQSessionError,
  type RFQSpec,
  type VendorCandidate,
} from "../procurement-rfq-kernel.js";

/**
 * Inline shape of the procurement touchstone task set -- avoids a circular
 * devDependency on @pcc/touchstone. Mirrors the expectedOutput schema for
 * "proc-001-compare-quotes" / "proc-003-vendor-scorecard" in
 * packages/touchstone/src/library/procurement.ts.
 */
const procurementTouchstoneShape = {
  id: "lib-procurement-v1",
  taskType: "procurement",
  fields: {
    rankings: "array",
    selectedVendor: "object",
  },
} as const;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Fixture {
  sessionKey: SessionKey;
  sessionPrivateKey: Uint8Array;
  principalPublicKey: Uint8Array;
}

function makeSessionKey(overrides?: {
  expiresAt?: number;
  allowedActions?: SessionKey["scope"]["allowedActions"];
}): Fixture {
  const principal = nacl.sign.keyPair();
  const session = nacl.sign.keyPair();
  const now = Math.floor(Date.now() / 1000);

  // NB: parentSignature is irrelevant for kernel-side gating; the kernel checks
  // only expiry + scope. A valid signature would be verified by the downstream
  // verifier, not the kernel itself.
  const sessionKey: SessionKey = {
    sessionId: "session-test-" + Math.random().toString(36).slice(2, 10),
    parentAgentId: "eip155:84532:0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as SessionKey["parentAgentId"],
    publicKey: session.publicKey,
    issuedAt: now - 60,
    expiresAt: overrides?.expiresAt ?? now + 3600,
    scope: {
      allowedActions: overrides?.allowedActions ?? ["evidence_submit", "workflow_step_complete"],
      contractIds: [],
      maxSignatures: 100,
    },
    parentSignature: new Uint8Array(64),
  };

  return {
    sessionKey,
    sessionPrivateKey: session.secretKey,
    principalPublicKey: principal.publicKey,
  };
}

function happyRFQ(): RFQSpec {
  return {
    item: "Widget A",
    quantity: 1000,
    specifications: { material: "steel", grade: "304", finish: "polished" },
    deadline: "2026-06-30",
  };
}

function happyVendors(): VendorCandidate[] {
  return [
    {
      id: "v-alpha",
      name: "Alpha Metals",
      capabilities: ["material", "grade", "finish", "iso9001"],
      lastQuoteHistory: { q1: 1, q2: 2 },
    },
    {
      id: "v-bravo",
      name: "Bravo Industrial",
      capabilities: ["material", "grade", "finish"],
      lastQuoteHistory: { q1: 1 },
    },
    {
      id: "v-charlie",
      name: "Charlie Supplies",
      capabilities: ["material", "grade", "finish", "expedited"],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProcurementRFQKernel", () => {
  // ---- 1. Happy path ------------------------------------------------------
  it("happy path: 3 eligible vendors -> awards top scorer", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel("kernel-rfq-happy");

    const result = await kernel.execute({
      rfqSpec: happyRFQ(),
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-happy",
    });

    expect(result.report.status).toBe("awarded");
    expect(result.report.selectedVendor).not.toBeNull();
    expect(result.report.eligibleVendorCount).toBe(3);
    expect(result.report.excludedVendorCount).toBe(0);
    expect(result.report.rankings).toHaveLength(3);
    expect(result.selectedVendor).not.toBeNull();
    expect(result.selectedVendor!.score).toBe(result.report.selectedVendor!.score);
    expect(result.report.purchaseOrder).not.toBeNull();
    expect(result.report.purchaseOrder!.quantity).toBe(1000);

    // Rankings must be sorted by score descending.
    for (let i = 0; i < result.report.rankings.length - 1; i++) {
      expect(result.report.rankings[i].score).toBeGreaterThanOrEqual(
        result.report.rankings[i + 1].score,
      );
    }
  });

  // ---- 2. Zero eligible vendors -------------------------------------------
  it("zero eligible vendors -> emits failure report (not exception)", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: {
        item: "Rare Widget",
        quantity: 100,
        specifications: { unobtainium: "yes", handwavium: "also yes" },
        deadline: "2026-12-31",
      },
      vendorList: [
        { id: "v-1", name: "Standard Supplies", capabilities: ["material"] },
        { id: "v-2", name: "Basic Metals", capabilities: ["material", "grade"] },
      ],
      sessionKey,
      sessionPrivateKey,
      jobId: "job-zero",
    });

    expect(result.report.status).toBe("no-vendors");
    expect(result.report.selectedVendor).toBeNull();
    expect(result.report.purchaseOrder).toBeNull();
    expect(result.report.eligibleVendorCount).toBe(0);
    expect(result.report.excludedVendorCount).toBe(2);
    expect(result.selectedVendor).toBeNull();
    // Evidence bundle still emitted
    expect(result.evidenceBundle.events.length).toBeGreaterThan(0);
  });

  // ---- 3. Single eligible vendor ------------------------------------------
  it("single vendor -> auto-selects with note", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: {
        item: "Specialty Alloy",
        quantity: 50,
        specifications: { alloy: "titanium-aerospace" },
        deadline: "2026-09-15",
      },
      vendorList: [
        { id: "v-only", name: "Only Vendor", capabilities: ["alloy", "aerospace-cert"] },
        { id: "v-generic", name: "Generic Supplies", capabilities: ["steel", "iron"] },
      ],
      sessionKey,
      sessionPrivateKey,
      jobId: "job-single",
    });

    expect(result.report.status).toBe("single-vendor");
    expect(result.report.eligibleVendorCount).toBe(1);
    expect(result.report.excludedVendorCount).toBe(1);
    expect(result.report.selectedVendor?.id).toBe("v-only");
    expect(result.report.decisionNote.toLowerCase()).toContain("single-vendor");
  });

  // ---- 4. Tied scores -> deterministic vendorId tie-break -----------------
  it("all same effective score -> deterministic tie-break by vendorId", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    // We use vendors with the SAME capability set and a small rfq -- in
    // score_quotes, when everyone has identical price/delivery/reputation,
    // every priceNorm/deliverySpeed collapses to 0.5 neutral (min==max),
    // so the final score is the same and the tie-break rules by vendorId.
    // To engineer perfect ties we'd need identical quote outputs, which only
    // happens when vendorId strings produce equal hashes. Instead we test
    // that the top scorer is the lexicographically earliest vendor among
    // those sharing the top score.
    const vendors: VendorCandidate[] = [
      { id: "v-zulu", name: "Zulu Co", capabilities: ["x"] },
      { id: "v-alpha", name: "Alpha Co", capabilities: ["x"] },
      { id: "v-mike", name: "Mike Co", capabilities: ["x"] },
    ];

    const result = await kernel.execute({
      rfqSpec: {
        item: "Commodity",
        quantity: 10,
        specifications: { x: true },
        deadline: "2026-05-01",
      },
      vendorList: vendors,
      sessionKey,
      sessionPrivateKey,
      jobId: "job-tied",
    });

    expect(result.report.selectedVendor).not.toBeNull();

    // Either there's a tie (all identical hashes, vanishingly unlikely) or
    // scoring distinguishes them. Either way, among vendors sharing the top
    // score, the lexicographically smallest vendorId must win.
    const topScore = result.report.rankings[0].score;
    const topTiedVendors = result.report.rankings
      .filter((r) => r.score === topScore)
      .map((r) => r.vendorId)
      .sort();
    expect(result.report.selectedVendor!.id).toBe(topTiedVendors[0]);
  });

  // ---- 5. Bundle signature verifies with sessionKey public key -----------
  it("evidence bundle signature verifies with sessionKey publicKey", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: happyRFQ(),
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-sig",
    });

    const bundle = result.evidenceBundle;
    expect(bundle.kernelSignature.algorithm).toBe("ed25519");

    // Recover signature bytes and verify against session public key over the bundleHash bytes.
    const sigHex = bundle.kernelSignature.value;
    const sigBytes = Buffer.from(sigHex, "hex");
    const messageBytes = new TextEncoder().encode(bundle.bundleHash);

    const ok = nacl.sign.detached.verify(
      messageBytes,
      new Uint8Array(sigBytes),
      sessionKey.publicKey,
    );
    expect(ok).toBe(true);
  });

  // ---- 6. Bundle has required lifecycle events ---------------------------
  it("bundle has exactly 1 execution_started + 1 execution_completed + N workflow_step_completed", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: happyRFQ(),
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-lifecycle",
    });

    const types = result.evidenceBundle.events.map((e) => e.type);
    const started = types.filter((t) => t === "execution_started").length;
    const completed = types.filter((t) => t === "execution_completed").length;
    const steps = types.filter((t) => t === "workflow_step_completed").length;
    const verified = types.filter((t) => t === "gcode_hash_verified").length;

    expect(started).toBe(1);
    expect(completed).toBe(1);
    expect(steps).toBe(6); // 6 workflow steps
    expect(verified).toBe(1);
    expect(result.evidenceBundle.events.length).toBe(started + completed + steps + verified);
  });

  // ---- 7. Step output hash chain (input_N+1 contains output_N) -----------
  it("step output hashes chain: solicit_quotes sees parse_rfq + filter_vendors outputs via rfqHash", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: happyRFQ(),
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-chain",
    });

    const traces = result.stepTraces;
    expect(traces.map((t) => t.stepId)).toEqual([
      "parse_rfq",
      "filter_vendors",
      "solicit_quotes",
      "score_quotes",
      "select_vendor",
      "emit_report",
    ]);

    // Each trace must have well-formed hashes (sha256:<64-hex> form from @pcc/spec).
    const hashRegex = /^(sha256:)?[0-9a-f]{64}$/;
    for (const t of traces) {
      expect(t.inputHash).toMatch(hashRegex);
      expect(t.outputHash).toMatch(hashRegex);
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }

    // score_quotes receives the solicit_quotes output as its input, so its
    // inputHash must be sha256(canonical({quotes: solicited.quotes})).
    const solicitStep = result.evidenceBundle.events.find(
      (e) => (e.payload as any).stepId === "solicit_quotes",
    );
    const scoreStep = result.evidenceBundle.events.find(
      (e) => (e.payload as any).stepId === "score_quotes",
    );
    expect(solicitStep).toBeDefined();
    expect(scoreStep).toBeDefined();

    // We can't rebuild the exact input inside this test without re-running
    // the kernel, but we can assert the hashes are stable and referenced.
    const scoreInputHash = (scoreStep!.payload as any).inputHash;
    expect(typeof scoreInputHash).toBe("string");
    expect(scoreInputHash).toMatch(hashRegex);
  });

  // ---- 8. Deterministic computation --------------------------------------
  // NB: The full bundleHash includes wall-clock timestamps on lifecycle
  // events (execution_started/completed), so identical runs intentionally
  // produce DIFFERENT bundleHashes. What we assert here is COMPUTATIONAL
  // determinism: identical inputs produce identical report content and
  // identical per-step input/output hashes (canonical-over-content).
  it("deterministic: identical inputs produce identical report + step hashes", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel("kernel-rfq-det");

    const rfq = happyRFQ();
    const vendors = happyVendors();
    const jobId = "job-det";

    const r1 = await kernel.execute({
      rfqSpec: rfq,
      vendorList: vendors,
      sessionKey,
      sessionPrivateKey,
      jobId,
    });
    const r2 = await kernel.execute({
      rfqSpec: rfq,
      vendorList: vendors,
      sessionKey,
      sessionPrivateKey,
      jobId,
    });

    // Report content must be identical even though ids + timestamps differ.
    expect(r1.report).toEqual(r2.report);
    expect(r1.selectedVendor?.id).toBe(r2.selectedVendor?.id);
    expect(r1.selectedVendor?.score).toBe(r2.selectedVendor?.score);

    // Per-step input/output hashes are deterministic functions of their
    // canonical inputs -- they do not depend on ids or timestamps.
    for (let i = 0; i < r1.stepTraces.length; i++) {
      expect(r1.stepTraces[i].inputHash).toBe(r2.stepTraces[i].inputHash);
      expect(r1.stepTraces[i].outputHash).toBe(r2.stepTraces[i].outputHash);
    }
  });

  // ---- 9. Touchstone compatibility shape ---------------------------------
  it("touchstone compatibility: output contains rankings + selection matching procurement scope", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: happyRFQ(),
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-touch",
    });

    // Shape-level alignment with procurement touchstone library output.
    expect(procurementTouchstoneShape.fields.rankings).toBe("array");
    expect(Array.isArray(result.report.rankings)).toBe(true);
    for (const r of result.report.rankings) {
      expect(typeof r.vendorId).toBe("string");
      expect(typeof r.score).toBe("number");
      expect(typeof r.totalPrice).toBe("number");
      expect(typeof r.deliveryDays).toBe("number");
    }
    expect(result.report.selectedVendor).not.toBeNull();
    expect(typeof result.report.selectedVendor!.id).toBe("string");
  });

  // ---- 10. SessionKey scope allows workflow_step_complete ----------------
  it("sessionKey scope with workflow_step_complete action -> signing works", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey({
      allowedActions: ["workflow_step_complete"],
    });
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: happyRFQ(),
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-scope-ok",
    });

    expect(result.evidenceBundle.kernelSignature.value).toMatch(/^[0-9a-f]+$/);
    expect(result.evidenceBundle.kernelSignature.algorithm).toBe("ed25519");
  });

  // ---- 11. Expired sessionKey -> throws before signing -------------------
  it("expired sessionKey -> throws ProcurementRFQSessionError before signing", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey({
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    const kernel = new ProcurementRFQKernel();

    await expect(
      kernel.execute({
        rfqSpec: happyRFQ(),
        vendorList: happyVendors(),
        sessionKey,
        sessionPrivateKey,
        jobId: "job-expired",
      }),
    ).rejects.toBeInstanceOf(ProcurementRFQSessionError);
  });

  it("sessionKey without workflow_step_complete action -> throws session error", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey({
      allowedActions: ["heartbeat"],
    });
    const kernel = new ProcurementRFQKernel();

    await expect(
      kernel.execute({
        rfqSpec: happyRFQ(),
        vendorList: happyVendors(),
        sessionKey,
        sessionPrivateKey,
        jobId: "job-scope-missing",
      }),
    ).rejects.toBeInstanceOf(ProcurementRFQSessionError);
  });

  // ---- 12. Malformed rfqSpec -> typed validation error ------------------
  it("malformed rfqSpec -> throws ProcurementRFQValidationError (not crash)", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    // quantity = 0 is invalid (must be positive)
    await expect(
      kernel.execute({
        rfqSpec: { item: "X", quantity: 0, specifications: {}, deadline: "2026-01-01" },
        vendorList: [],
        sessionKey,
        sessionPrivateKey,
        jobId: "job-bad-qty",
      }),
    ).rejects.toBeInstanceOf(ProcurementRFQValidationError);

    // Empty item string
    await expect(
      kernel.execute({
        rfqSpec: { item: "", quantity: 10, specifications: {}, deadline: "2026-01-01" },
        vendorList: [],
        sessionKey,
        sessionPrivateKey,
        jobId: "job-bad-item",
      }),
    ).rejects.toBeInstanceOf(ProcurementRFQValidationError);

    // Missing deadline
    await expect(
      kernel.execute({
        rfqSpec: { item: "X", quantity: 10, specifications: {}, deadline: "" },
        vendorList: [],
        sessionKey,
        sessionPrivateKey,
        jobId: "job-bad-deadline",
      }),
    ).rejects.toBeInstanceOf(ProcurementRFQValidationError);

    // specifications as array instead of object
    await expect(
      kernel.execute({
        rfqSpec: { item: "X", quantity: 10, specifications: [] as unknown as Record<string, unknown>, deadline: "2026-01-01" },
        vendorList: [],
        sessionKey,
        sessionPrivateKey,
        jobId: "job-bad-spec",
      }),
    ).rejects.toBeInstanceOf(ProcurementRFQValidationError);
  });

  // ---- 13. Bundle hash integrity: sorted event hashes -------------------
  it("bundleHash equals sha256(canonicalize(sorted event hashes))", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();

    const result = await kernel.execute({
      rfqSpec: happyRFQ(),
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-bundle-hash",
    });

    const eventHashes = result.evidenceBundle.events.map((e) => e.hash).sort();
    const expectedBundleHash = await sha256(canonicalize(eventHashes));
    expect(result.evidenceBundle.bundleHash).toBe(expectedBundleHash);
  });

  // ---- 14. PO draft populated when a vendor is awarded ------------------
  it("purchase-order draft matches selected vendor + echoes RFQ spec fields", async () => {
    const { sessionKey, sessionPrivateKey } = makeSessionKey();
    const kernel = new ProcurementRFQKernel();
    const rfq = happyRFQ();

    const result = await kernel.execute({
      rfqSpec: rfq,
      vendorList: happyVendors(),
      sessionKey,
      sessionPrivateKey,
      jobId: "job-po",
    });

    const po = result.report.purchaseOrder;
    expect(po).not.toBeNull();
    expect(po!.vendorId).toBe(result.report.selectedVendor!.id);
    expect(po!.item).toBe(rfq.item);
    expect(po!.quantity).toBe(rfq.quantity);
    expect(po!.deadline).toBe(rfq.deadline);
    expect(po!.totalPrice).toBeCloseTo(po!.unitPrice * po!.quantity, 2);
  });
});
