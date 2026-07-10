import { describe, it, expect } from "vitest";

import {
  EmitterDeclSchema,
  EvidenceEmitterManifestSchema,
  buildEvidenceTiersFromEmits,
  manifestToCsdEvidence,
  emitsToPrimitiveRefs,
  type EvidenceEmitterManifest,
} from "../evidence/emitter-manifest.js";
import {
  ADAPTER_DEFAULT_MANIFESTS,
  DEVICE_ROLE_DEFAULT_MANIFESTS,
  getAdapterManifest,
  getDeviceRoleManifest,
  buildAdapterEvidence,
} from "../evidence/adapter-manifests.js";
import { computeCsdEligibility } from "../evidence/eligibility.js";
import { VOCAB_VERSION, getPrimitive } from "../evidence/primitives.js";

// ── 1. Schema — reuses the CSD ref grammar + via/demonstrated ────────

describe("EmitterDecl — same grammar as CSD refs, plus via/demonstrated", () => {
  it("accepts a bare {id}", () => {
    expect(EmitterDeclSchema.safeParse({ id: "receipt.kernel_signed" }).success).toBe(true);
  });

  it("accepts id + params + bind + via + demonstrated", () => {
    const parsed = EmitterDeclSchema.safeParse({
      id: "capture.photo_nonced",
      params: { media: "photo", minClass: "CC2" },
      bind: "outputPhotoCid",
      via: "captureSnapshot",
      demonstrated: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a decl with no id", () => {
    expect(EmitterDeclSchema.safeParse({ via: "x" }).success).toBe(false);
  });

  it("a full manifest validates", () => {
    const manifest: EvidenceEmitterManifest = {
      subject: { kind: "device", ref: "dev-cam-001" },
      vocabVersion: VOCAB_VERSION,
      emits: [{ id: "capture.photo_nonced", params: { media: "photo", minClass: "CC1" } }],
    };
    expect(EvidenceEmitterManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("emitsToPrimitiveRefs strips via/demonstrated to plain CSD refs", () => {
    const refs = emitsToPrimitiveRefs([
      { id: "artifact.hash", params: { mode: "plain" }, bind: "cid", via: "x", demonstrated: true },
    ]);
    expect(refs).toEqual([{ id: "artifact.hash", params: { mode: "plain" }, bind: "cid" }]);
  });
});

// ── 2. Bridge — manifest emits → eligible CSD evidence tier map ──────

describe("buildEvidenceTiersFromEmits — the digital-receipt core is tier-1 eligible", () => {
  const receiptCore = [
    { id: "decl.self_attested" },
    { id: "ident.registered_key" },
    { id: "receipt.kernel_signed" },
    { id: "confirm.execution_mode", params: { expected: "real" } },
    { id: "artifact.hash", params: { mode: "plain" } },
  ];

  it("derives tier0 + tier1 and is ELIGIBLE at tier 1 (not CAPPED)", () => {
    const evidence = buildEvidenceTiersFromEmits(receiptCore);
    const report = computeCsdEligibility({ url: "pcc://test/receipt-core", evidence });
    expect(report.verdict).toBe("ELIGIBLE");
    expect(report.eligibleTier).toBe(1);
    expect(Object.keys(evidence).sort()).toEqual(["tier0", "tier1"]);
    // tier1 carries structured primitives[] — the whole point.
    const ids = evidence.tier1.primitives?.map((p) => p.id) ?? [];
    expect(ids).toContain("receipt.kernel_signed");
    expect(ids).toContain("confirm.execution_mode");
  });

  it("auto-includes transitive vocabulary dependencies", () => {
    // confirm.execution_mode alone → the builder pulls in receipt.kernel_signed
    // and ident.registered_key so the tier is dependency-closed and eligible.
    const evidence = buildEvidenceTiersFromEmits([
      { id: "decl.self_attested" },
      { id: "confirm.execution_mode", params: { expected: "real" } },
    ]);
    const ids = evidence.tier1?.primitives?.map((p) => p.id) ?? [];
    expect(ids).toContain("receipt.kernel_signed");
    expect(ids).toContain("ident.registered_key");
    expect(computeCsdEligibility({ url: "pcc://t", evidence }).eligibleTier).toBe(1);
  });

  it("drops unknown / not-yet-shipped primitive ids gracefully (rising tide)", () => {
    // A forward-referenced primitive that is not in the live vocabulary must NOT
    // cap the derived CSD — it is dropped until its entry lands, then lifts the tier.
    // NOTE: "telemetry.envelope_conformance" was the original placeholder here, but
    // it shipped in #224 (v1.5-industrial, primitives #52-#55) — rebasing onto
    // master means it now resolves, so the forward-ref example was swapped to a
    // still-unshipped id to keep testing the actual "unknown id" behavior.
    expect(getPrimitive("telemetry.envelope_conformance_v2")).toBeUndefined();
    const evidence = buildEvidenceTiersFromEmits([
      ...receiptCore,
      { id: "telemetry.envelope_conformance_v2" },
    ]);
    const report = computeCsdEligibility({ url: "pcc://t", evidence });
    expect(report.eligibleTier).toBe(1);
    const ids = Object.values(evidence).flatMap((t) => t.primitives?.map((p) => p.id) ?? []);
    expect(ids).not.toContain("telemetry.envelope_conformance_v2");
  });

  it("a self-attest-only emit set stays at the tier-0 floor", () => {
    const evidence = buildEvidenceTiersFromEmits([{ id: "decl.self_attested" }]);
    expect(Object.keys(evidence)).toEqual(["tier0"]);
    expect(computeCsdEligibility({ url: "pcc://t", evidence }).eligibleTier).toBe(0);
  });

  it("preserves a bind merged from a duplicated primitive declaration", () => {
    const evidence = buildEvidenceTiersFromEmits([
      { id: "decl.self_attested" },
      { id: "ident.registered_key" },
      { id: "receipt.kernel_signed" },
      { id: "confirm.execution_mode", params: { expected: "real" } },
      { id: "artifact.hash", params: { mode: "plain" } },
      { id: "artifact.hash", bind: "outputDocumentCid" },
    ]);
    const artifact = evidence.tier1?.primitives?.find((p) => p.id === "artifact.hash");
    expect(artifact?.bind).toBe("outputDocumentCid");
    expect(artifact?.params).toEqual({ mode: "plain" });
  });
});

// ── 3. Adapter default manifests — shipped data ─────────────────────

describe("adapter default manifests", () => {
  it("ships a manifest for every kernel adapter family", () => {
    for (const t of ["octoprint", "ipp", "opcua", "sila", "modbus", "generic-http", "mock"]) {
      expect(getAdapterManifest(t)).toBeDefined();
      expect(EvidenceEmitterManifestSchema.safeParse(getAdapterManifest(t)).success).toBe(true);
    }
  });

  it("ships evidence-only device-role manifests (camera + sensor)", () => {
    for (const role of ["camera", "sensor"]) {
      const m = getDeviceRoleManifest(role);
      expect(m).toBeDefined();
      expect(m?.subject.kind).toBe("device");
      expect(EvidenceEmitterManifestSchema.safeParse(m).success).toBe(true);
    }
  });

  it("every digital adapter is eligible-by-default at tier 1", () => {
    for (const t of ["octoprint", "ipp", "opcua", "sila", "modbus", "generic-http"]) {
      const { evidence, structured } = buildAdapterEvidence(t);
      expect(structured).toBe(true);
      const report = computeCsdEligibility({ url: `pcc://adapter/${t}`, evidence });
      expect(report.verdict).toBe("ELIGIBLE");
      expect(report.eligibleTier).toBe(1);
    }
  });

  it("octoprint reaches tier 1 despite a forward-referenced unknown primitive", () => {
    const evidence = manifestToCsdEvidence(ADAPTER_DEFAULT_MANIFESTS.octoprint);
    expect(computeCsdEligibility({ url: "pcc://oct", evidence }).eligibleTier).toBe(1);
  });

  it("the camera peripheral emits a nonce-bound photo → tier 1", () => {
    const evidence = manifestToCsdEvidence(DEVICE_ROLE_DEFAULT_MANIFESTS.camera);
    const ids = evidence.tier1?.primitives?.map((p) => p.id) ?? [];
    expect(ids).toContain("capture.photo_nonced");
    expect(computeCsdEligibility({ url: "pcc://cam", evidence }).eligibleTier).toBe(1);
  });

  it("mock is honestly capped at tier 0 (cannot attest a real execution)", () => {
    const { evidence } = buildAdapterEvidence("mock");
    expect(computeCsdEligibility({ url: "pcc://mock", evidence }).eligibleTier).toBe(0);
  });
});

// ── 4. On-ramp — an undeclared adapter falls back to free-text tier 0 ─

describe("buildAdapterEvidence — undeclared adapter preserves the tier-0 on-ramp", () => {
  it("an unknown adapter yields free-text tier-0 evidence (no primitives[])", () => {
    const { evidence, structured } = buildAdapterEvidence("totally-unknown-adapter");
    expect(structured).toBe(false);
    expect(evidence.tier0.primitives).toBeUndefined();
    const report = computeCsdEligibility({ url: "pcc://unknown", evidence });
    expect(report.eligibleTier).toBe(0);
  });

  it("eligibility BEFORE vs AFTER — free-text tier1 caps at 0; structured lifts to 1", () => {
    // BEFORE: the legacy free-text shape auto-discovery used to write.
    const before = {
      tier0: { description: "receipt", required: ["jobId", "timestamp"] },
      tier1: { description: "per-page", required: ["jobId", "pagesCompleted"] },
    };
    expect(computeCsdEligibility({ url: "pcc://before", evidence: before }).eligibleTier).toBe(0);

    // AFTER: the structured evidence derived from the ipp emitter manifest.
    const after = buildAdapterEvidence("ipp").evidence;
    expect(computeCsdEligibility({ url: "pcc://after", evidence: after }).eligibleTier).toBe(1);
  });
});
