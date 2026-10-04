/**
 * N128: every evidence primitive's params are a closed shape, so a public manifest carries nothing the
 * schema can't name (no free-form string, no unknown key, no secret under a harmless name).
 */
import { describe, expect, it } from "vitest";
import { EVIDENCE_PRIMITIVES } from "../evidence/primitives.js";
import {
  PRIMITIVE_PARAMS,
  isParamIdentifier,
  isSha256Digest,
  validatePrimitiveParams,
  type ParamKind,
} from "../evidence/primitive-params.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const BYTES32 = `0x${"cd".repeat(32)}`;
const ADDRESS = `0x${"ef".repeat(20)}`;

/** One valid params object per primitive, using every field. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  "approval.payer": { approverRole: "payer", claimIds: ["claim-1", "claim_2"] },
  "approval.expert": { approverRole: "expert", claimIds: ["claim-1"], rubricRef: DIGEST },
  "decl.self_attested": { schemaRef: DIGEST },
  "confirm.execution_mode": { expected: "real" },
  "artifact.hash": { mode: "redacted-commit" },
  "fresh.challenge_bound": { form: "capture", maxAgeSeconds: 300 },
  "pay.escrow_receipt": { childJobId: "job_child.1", childEscrow: ADDRESS },
  "ident.registered_key": { registryId: "kernel-registry", snapshotHash: DIGEST },
  "receipt.kernel_signed": { capability: "print.inkjet" },
  "telemetry.geofence_event": { lat: 37.77, lng: -122.42, radiusM: 50 },
  "confirm.recipient_nonce": { validityWindowSeconds: 3600 },
  "confirm.recipient_signature": {},
  "measure.io_test_pair": { mode: "deterministic" },
  "capture.photo_nonced": { media: "photo", minClass: "CC2", nonceType: "qr" },
  "telemetry.gps_trail": { integrityGrade: "checked", maxGapSeconds: 30, plausibility: { maxSpeedKph: 120 } },
  "confirm.target_system": { channel: "webhook", matcher: "order-status-shipped" },
  "machine.execution_log": { logKind: "job_log", disclosure: "full", minCadenceMs: 1000, alarmPolicy: "declared", role: "supporting" },
  "telemetry.envelope_conformance": {
    envelope: [{ metric: "spindle_temp_c", unit: "degC", min: 10, max: 90, ratioBands: [0.5, 1.5] }],
    source: "stream",
    severityFloor: "critical",
    materialParam: "pla",
    includePipelineAnomalies: true,
  },
  "telemetry.coverage_gate": { requiredGroups: [["power", "camera"], ["gps"]], maxGapSeconds: 60, evidenceGradeChannels: false },
  "process.batch_record": { recipeRef: BYTES32, phaseGraph: BYTES32, sampleManifestRef: BYTES32 },
};

/** Values that fit no closed shape at all, whatever the field. */
const NEVER_VALID: Array<[string, unknown]> = [
  ["free text with spaces", "please use api key sk_live_abc and password hunter2"],
  ["an empty string", ""],
  ["null", null],
  ["an open object", { secret: "x" }],
  ["a non-finite number", Number.POSITIVE_INFINITY],
  ["NaN", Number.NaN],
];

describe("PRIMITIVE_PARAMS covers the registry exactly", () => {
  it("has one closed entry per registry primitive, and none for anything else", () => {
    expect(Object.keys(PRIMITIVE_PARAMS).sort()).toEqual(EVIDENCE_PRIMITIVES.map((p) => p.id).sort());
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(PRIMITIVE_PARAMS).sort());
  });

  it("keeps every param the registry declares (closing a primitive drops none of its documented params)", () => {
    for (const p of EVIDENCE_PRIMITIVES) {
      const declared = Object.keys(((p.paramsSchema as { properties?: object }).properties ?? {}) as object);
      for (const key of declared) expect(Object.keys(PRIMITIVE_PARAMS[p.id] as object), `${p.id}.${key}`).toContain(key);
    }
  });
});

describe("validatePrimitiveParams: closed shapes only", () => {
  it.each(Object.keys(SAMPLES))("%s: the sample, using every field, is valid", (primitiveId) => {
    expect(validatePrimitiveParams(primitiveId, SAMPLES[primitiveId])).toEqual({ ok: true });
  });

  it.each(Object.keys(SAMPLES))("%s: an unknown key is refused, whatever its value", (primitiveId) => {
    for (const [, value] of [["a string", "x"], ...NEVER_VALID] as Array<[string, unknown]>) {
      const result = validatePrimitiveParams(primitiveId, { ...SAMPLES[primitiveId], apiKey: value });
      expect(result.ok, `${primitiveId} + apiKey`).toBe(false);
    }
  });

  it.each(Object.keys(SAMPLES))("%s: every field refuses every value that fits no closed shape", (primitiveId) => {
    for (const key of Object.keys(PRIMITIVE_PARAMS[primitiveId] as object)) {
      for (const [label, value] of NEVER_VALID) {
        const result = validatePrimitiveParams(primitiveId, { ...SAMPLES[primitiveId], [key]: value });
        expect(result.ok, `${primitiveId}.${key} = ${label}`).toBe(false);
      }
    }
  });

  it("required fields are required", () => {
    for (const [primitiveId, fields] of Object.entries(PRIMITIVE_PARAMS)) {
      for (const [key, field] of Object.entries(fields)) {
        if (field.required !== true) continue;
        const { [key]: _dropped, ...rest } = SAMPLES[primitiveId] as Record<string, unknown>;
        expect(validatePrimitiveParams(primitiveId, rest).ok, `${primitiveId} without ${key}`).toBe(false);
        expect(validatePrimitiveParams(primitiveId, undefined).ok, `${primitiveId} with no params`).toBe(false);
      }
    }
    expect(validatePrimitiveParams("confirm.recipient_signature", undefined)).toEqual({ ok: true });
  });

  it("an unknown primitive id is refused", () => {
    expect(validatePrimitiveParams("capture.photo_unregistered", {}).ok).toBe(false);
    expect(validatePrimitiveParams("__proto__", {}).ok).toBe(false);
    expect(validatePrimitiveParams("constructor", {}).ok).toBe(false);
  });

  it("bounds hold: integers are integers, numbers stay in range, arrays stay short", () => {
    expect(validatePrimitiveParams("fresh.challenge_bound", { maxAgeSeconds: 1.5 }).ok).toBe(false);
    expect(validatePrimitiveParams("fresh.challenge_bound", { maxAgeSeconds: 0 }).ok).toBe(false);
    expect(validatePrimitiveParams("fresh.challenge_bound", { maxAgeSeconds: 86_401 }).ok).toBe(false);
    expect(validatePrimitiveParams("telemetry.geofence_event", { lat: 91, lng: 0, radiusM: 1 }).ok).toBe(false);
    expect(validatePrimitiveParams("approval.payer", { claimIds: new Array(65).fill("c") }).ok).toBe(false);
    expect(validatePrimitiveParams("telemetry.envelope_conformance", { envelope: "builtin-defaults" })).toEqual({ ok: true });
    expect(validatePrimitiveParams("telemetry.envelope_conformance", { envelope: "custom" }).ok).toBe(false);
    expect(validatePrimitiveParams("telemetry.envelope_conformance", { envelope: [{ metric: "m", unit: "furlongs" }] }).ok).toBe(false);
    expect(validatePrimitiveParams("telemetry.envelope_conformance", { envelope: [{ metric: "m", unit: "degC", note: "x" }] }).ok).toBe(false);
  });
});

describe("own data only: no accessor, inherited key or exotic object passes", () => {
  it("an accessor field is refused and never called", () => {
    let called = false;
    const params = { channel: "api" } as Record<string, unknown>;
    Object.defineProperty(params, "matcher", { enumerable: true, get: () => ((called = true), "m") });
    expect(validatePrimitiveParams("confirm.target_system", params).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("a key inherited from a polluted Object.prototype is neither read nor required to be absent", () => {
    Object.defineProperty(Object.prototype, "apiKey", { value: "sk_live_polluted", configurable: true, writable: true });
    try {
      expect(validatePrimitiveParams("confirm.target_system", { channel: "api" })).toEqual({ ok: true });
    } finally {
      delete (Object.prototype as Record<string, unknown>).apiKey;
    }
  });

  it("non-plain objects, symbol keys and irregular arrays are refused", () => {
    class Params {
      channel = "api";
    }
    expect(validatePrimitiveParams("confirm.target_system", new Params()).ok).toBe(false);
    expect(validatePrimitiveParams("confirm.target_system", new Map([["channel", "api"]])).ok).toBe(false);
    expect(validatePrimitiveParams("confirm.target_system", ["api"]).ok).toBe(false);
    expect(validatePrimitiveParams("confirm.target_system", { channel: "api", [Symbol("s")]: "x" }).ok).toBe(false);
    const holey = ["claim-1", , "claim-3"];
    expect(validatePrimitiveParams("approval.payer", { claimIds: holey }).ok).toBe(false);
    const extra = Object.assign(["claim-1"], { secret: "x" });
    expect(validatePrimitiveParams("approval.payer", { claimIds: extra }).ok).toBe(false);
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { channel: "api" });
    expect(validatePrimitiveParams("confirm.target_system", nullProto)).toEqual({ ok: true });
  });
});

describe("formats are checked character by character", () => {
  it("identifiers", () => {
    for (const ok of ["a", "job_1", "Job-1.v2", "eip155:84532:0xabc", "x".repeat(128)]) expect(isParamIdentifier(ok), ok).toBe(true);
    for (const bad of ["", "-lead", "_lead", "has space", "semi;colon", "slash/x", "x".repeat(129), "é", 7, null]) {
      expect(isParamIdentifier(bad), String(bad)).toBe(false);
    }
  });

  it("digests, bytes32 and addresses are exact and lowercase", () => {
    expect(isSha256Digest(DIGEST)).toBe(true);
    for (const bad of [DIGEST.toUpperCase(), `sha256:${"ab".repeat(31)}`, `sha512:${"ab".repeat(32)}`, `${DIGEST}0`]) {
      expect(isSha256Digest(bad), bad).toBe(false);
    }
    const bytes32Field: ParamKind = { kind: "bytes32" };
    expect(bytes32Field.kind).toBe("bytes32");
    expect(validatePrimitiveParams("process.batch_record", { recipeRef: BYTES32.toUpperCase().replace("0X", "0x") }).ok).toBe(false);
    expect(validatePrimitiveParams("process.batch_record", { recipeRef: `0x${"cd".repeat(31)}` }).ok).toBe(false);
    expect(validatePrimitiveParams("pay.escrow_receipt", { childEscrow: ADDRESS.slice(0, -1) }).ok).toBe(false);
    expect(validatePrimitiveParams("pay.escrow_receipt", { childEscrow: `0X${"ef".repeat(20)}` }).ok).toBe(false);
  });
});
