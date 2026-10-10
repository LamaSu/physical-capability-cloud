/**
 * N128: every evidence primitive's params are a closed shape, so a public manifest carries nothing the
 * schema can't name (no free-form string, no unknown key, no secret under a harmless name).
 */
import { describe, expect, it } from "vitest";
import { EVIDENCE_PRIMITIVES } from "../evidence/primitives.js";
import { loadBuiltinCsds } from "../csd/registry.js";
import { ADAPTER_DEFAULT_MANIFESTS, DEVICE_ROLE_DEFAULT_MANIFESTS } from "../evidence/adapter-manifests.js";
import { EVIDENCE_EVENT_TYPES } from "../types/evidence.js";
import {
  EMITTER_CHANNELS,
  EVIDENCE_BIND_FIELDS,
  MAX_SNAPSHOT_DEPTH,
  PRIMITIVE_PARAMS,
  isEmitterVia,
  isEvidenceBind,
  isParamIdentifier,
  isSha256Digest,
  ownDataSnapshot,
  renderParamsSchema,
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
  "ident.registered_key": { registryId: "kernel-registry", snapshotHash: BYTES32 },
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

  it("is the ONE source: every registry paramsSchema is its rendering, field for field and requiredness for requiredness", () => {
    for (const p of EVIDENCE_PRIMITIVES) {
      const fields = PRIMITIVE_PARAMS[p.id] as Record<string, { required?: boolean }>;
      const schema = p.paramsSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties: unknown };
      expect(p.paramsSchema, p.id).toEqual(renderParamsSchema(p.id));
      // Both directions: the registry names exactly the table's fields, and requires exactly its required ones.
      expect(Object.keys(schema.properties).sort(), p.id).toEqual(Object.keys(fields).sort());
      const requiredFields = Object.keys(fields).filter((k) => fields[k]!.required === true).sort();
      expect([...(schema.required ?? [])].sort(), p.id).toEqual(requiredFields);
      expect(schema.additionalProperties, p.id).toBe(false);
    }
  });

  it("keeps the registry's required fields (r1 finding 1): a capture states its media and class, a test pair its mode", () => {
    expect(validatePrimitiveParams("capture.photo_nonced", undefined).ok).toBe(false);
    expect(validatePrimitiveParams("capture.photo_nonced", { media: "photo" }).ok).toBe(false);
    expect(validatePrimitiveParams("capture.photo_nonced", { minClass: "CC2" }).ok).toBe(false);
    expect(validatePrimitiveParams("capture.photo_nonced", { media: "photo", minClass: "CC2" })).toEqual({ ok: true });
    expect(validatePrimitiveParams("measure.io_test_pair", undefined).ok).toBe(false);
    expect(validatePrimitiveParams("measure.io_test_pair", {}).ok).toBe(false);
  });

  it("renders every default as a member of its enum, and no renderer exists for an unknown id", () => {
    const defaults: string[] = [];
    for (const [primitiveId, fields] of Object.entries(PRIMITIVE_PARAMS)) {
      for (const [key, field] of Object.entries(fields)) {
        if (field.default === undefined) continue;
        defaults.push(`${primitiveId}.${key}`);
        expect(field.type.kind, `${primitiveId}.${key}`).toBe("enum");
        expect((field.type as { values: readonly string[] }).values, `${primitiveId}.${key}`).toContain(field.default);
        expect(validatePrimitiveParams(primitiveId, { ...SAMPLES[primitiveId], [key]: field.default }), `${primitiveId}.${key}`).toEqual({ ok: true });
      }
    }
    expect(defaults.sort()).toEqual([
      "artifact.hash.mode",
      "machine.execution_log.disclosure",
      "telemetry.envelope_conformance.severityFloor",
      "telemetry.envelope_conformance.source",
    ]);
    expect(() => renderParamsSchema("capture.unregistered")).toThrow();
    expect(() => renderParamsSchema("__proto__")).toThrow();
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

  it("a registry snapshot hash is bytes32, as types/registry.ts computes it (r1 note), never a sha256: digest", () => {
    expect(validatePrimitiveParams("ident.registered_key", { snapshotHash: BYTES32 })).toEqual({ ok: true });
    expect(validatePrimitiveParams("ident.registered_key", { snapshotHash: DIGEST }).ok).toBe(false);
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

describe("bind and via are closed names (r1 finding 3), never merely identifier-shaped", () => {
  it("bind is an evidence field or an event type; via is an emitter channel or an event type", () => {
    for (const field of EVIDENCE_BIND_FIELDS) expect(isEvidenceBind(field), field).toBe(true);
    for (const channel of EMITTER_CHANNELS) expect(isEmitterVia(channel), channel).toBe(true);
    for (const type of EVIDENCE_EVENT_TYPES) {
      expect(isEvidenceBind(type), type).toBe(true);
      expect(isEmitterVia(type), type).toBe(true);
    }
  });

  it("the lists cover the built-in data: every CSD bind, every artifact field a CSD declares, every manifest bind and via", () => {
    const csds = loadBuiltinCsds().list();
    const tiers = csds.flatMap((csd) => Object.values(csd.evidence ?? {}));
    for (const tier of tiers) {
      for (const ref of tier.primitives ?? []) if (ref.bind !== undefined) expect(isEvidenceBind(ref.bind), ref.bind).toBe(true);
      for (const field of tier.required) if (field.endsWith("Cid")) expect(EVIDENCE_BIND_FIELDS, field).toContain(field);
    }
    for (const manifest of Object.values({ ...ADAPTER_DEFAULT_MANIFESTS, ...DEVICE_ROLE_DEFAULT_MANIFESTS })) {
      for (const decl of manifest.emits) {
        if (decl.bind !== undefined) expect(isEvidenceBind(decl.bind), decl.bind).toBe(true);
        if (decl.via !== undefined) expect(isEmitterVia(decl.via), decl.via).toBe(true);
      }
    }
    // Every channel is one a default manifest uses: the list names no channel that nothing emits through.
    const vias = new Set(Object.values({ ...ADAPTER_DEFAULT_MANIFESTS, ...DEVICE_ROLE_DEFAULT_MANIFESTS }).flatMap((m) => m.emits.map((e) => e.via)));
    for (const channel of EMITTER_CHANNELS) expect(vias, channel).toContain(channel);
  });

  it("an identifier-shaped name outside the lists is refused (astra's sk_live_x and secret_token)", () => {
    for (const bad of ["sk_live_x", "secret_token", "dropoffVideoCid", "toString", "__proto__", "constructor", "", 7, null]) {
      expect(isEvidenceBind(bad), String(bad)).toBe(false);
      expect(isEmitterVia(bad), String(bad)).toBe(false);
    }
    // The lists don't leak into each other: a channel is not a field, and a field is not a channel.
    expect(isEvidenceBind("toKernelOutput")).toBe(false);
    expect(isEmitterVia("outputArtifactCid")).toBe(false);
  });
});

describe("ownDataSnapshot: a descriptor-only copy (r1 finding 5)", () => {
  it("copies JSON data exactly, as a new object", () => {
    const value = JSON.parse('{"a":1,"b":[true,null,"x",{"c":-2.5}],"d":{}}') as Record<string, unknown>;
    const copy = ownDataSnapshot(value);
    expect(copy).toEqual({ ok: true, value });
    expect(copy.ok && copy.value).not.toBe(value);
  });

  it("refuses an accessor anywhere, and never calls it", () => {
    let called = 0;
    const getter = () => ((called += 1), "api");
    const flat = Object.defineProperty({}, "channel", { enumerable: true, get: getter });
    const deep = { envelope: [Object.defineProperty({ metric: "m" }, "min", { enumerable: true, get: getter })] };
    const index = Object.defineProperty(["a", "b"], 1, { enumerable: true, get: getter });
    const hidden = Object.defineProperty({}, "channel", { enumerable: false, get: getter });
    for (const value of [flat, deep, { claimIds: index }, hidden]) expect(ownDataSnapshot(value).ok).toBe(false);
    expect(called).toBe(0);
  });

  it("refuses a proxy without running a trap (Node offers a trap-free check)", () => {
    let trapped = false;
    const handler: ProxyHandler<object> = {
      ownKeys: () => ((trapped = true), []),
      getOwnPropertyDescriptor: () => ((trapped = true), undefined),
      getPrototypeOf: () => ((trapped = true), Object.prototype),
    };
    expect(ownDataSnapshot(new Proxy({ channel: "api" }, handler)).ok).toBe(false);
    expect(ownDataSnapshot({ envelope: [new Proxy({ metric: "m" }, handler)] }).ok).toBe(false);
    expect(trapped).toBe(false);
  });

  it("refuses symbol keys, __proto__ keys, non-plain objects, irregular arrays and non-data values", () => {
    class Params {
      channel = "api";
    }
    const holey = ["a", , "c"];
    const extra = Object.assign(["a"], { secret: "x" });
    const subclassed = new (class extends Array<string> {})();
    for (const value of [
      { [Symbol("s")]: "x" },
      JSON.parse('{"__proto__":{"admin":true}}'),
      new Params(),
      new Map([["channel", "api"]]),
      new Date(0),
      { list: holey },
      { list: extra },
      { list: subclassed },
      { f: () => 1 },
      { n: BigInt(1) },
      { s: Symbol("s") },
    ]) {
      expect(ownDataSnapshot(value).ok, String(value)).toBe(false);
    }
  });

  it("copies a non-enumerable data key as an ordinary one, so a closed check still sees and refuses it", () => {
    const params = Object.defineProperty({ channel: "api" }, "apiKey", { value: "sk_live_x", enumerable: false });
    const copy = ownDataSnapshot(params);
    expect(copy.ok && Object.keys(copy.value as object).sort()).toEqual(["apiKey", "channel"]);
    expect(validatePrimitiveParams("confirm.target_system", copy.ok ? copy.value : undefined).ok).toBe(false);
  });

  it("bounds nesting, so a cycle is refused rather than walked forever", () => {
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let i = 0; i < MAX_SNAPSHOT_DEPTH; i++) nested = nested.next = {} as Record<string, unknown>;
    expect(ownDataSnapshot(root).ok).toBe(false);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(ownDataSnapshot(cyclic).ok).toBe(false);
    let shallow: Record<string, unknown> = {};
    const shallowRoot = shallow;
    for (let i = 0; i < MAX_SNAPSHOT_DEPTH - 1; i++) shallow = shallow.next = {} as Record<string, unknown>;
    expect(ownDataSnapshot(shallowRoot).ok).toBe(true);
  });
});
