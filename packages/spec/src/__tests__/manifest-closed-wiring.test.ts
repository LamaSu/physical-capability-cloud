/**
 * N128 wiring: the CSD tier primitives and the emitter declarations (which setup.ts parses before it
 * persists and returns a device) accept closed shapes only, and the default manifests still pass.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClosedCsdEvidencePrimitiveRefSchema, CsdEvidenceTierSchema } from "../csd/schema.js";
import { loadBuiltinCsds } from "../csd/registry.js";
import { EmitterDeclSchema, EvidenceEmitterManifestSchema } from "../evidence/emitter-manifest.js";
import { ADAPTER_DEFAULT_MANIFESTS, DEVICE_ROLE_DEFAULT_MANIFESTS } from "../evidence/adapter-manifests.js";

const ok = (schema: z.ZodTypeAny, value: unknown) => schema.safeParse(value).success;

describe("every default manifest passes the closed schema", () => {
  it.each(Object.entries({ ...ADAPTER_DEFAULT_MANIFESTS, ...DEVICE_ROLE_DEFAULT_MANIFESTS }))("%s", (_name, manifest) => {
    expect(EvidenceEmitterManifestSchema.safeParse(manifest).success).toBe(true);
    // And exactly what setup.ts parses: the declarations array.
    expect(ok(z.array(EmitterDeclSchema), manifest.emits)).toBe(true);
  });
});

describe("an emitter declaration is closed", () => {
  const good = { id: "confirm.target_system", params: { channel: "api" }, via: "http-response", bind: "outputDocumentCid" };

  it("a good declaration passes", () => {
    expect(ok(EmitterDeclSchema, good)).toBe(true);
    expect(ok(EmitterDeclSchema, { ...good, demonstrated: true })).toBe(true);
  });

  it("an unknown key, open params, or an unregistered primitive is refused", () => {
    expect(ok(EmitterDeclSchema, { ...good, apiKey: "sk_live_x" })).toBe(false);
    expect(ok(EmitterDeclSchema, { ...good, params: { channel: "api", apiKey: "sk_live_x" } })).toBe(false);
    expect(ok(EmitterDeclSchema, { ...good, params: { channel: "carrier-pigeon" } })).toBe(false);
    expect(ok(EmitterDeclSchema, { ...good, id: "capture.unregistered" })).toBe(false);
    expect(ok(EmitterDeclSchema, { id: "confirm.target_system" })).toBe(false); // its channel is required
  });

  it("bind and via are closed names, never free text and never merely identifier-shaped (r1 finding 3)", () => {
    for (const bad of ["has space", "https://x.example/?session=abc", "a/b", "", "_lead", "sk_live_x", "secret_token"]) {
      expect(ok(EmitterDeclSchema, { ...good, bind: bad }), `bind ${bad}`).toBe(false);
      expect(ok(EmitterDeclSchema, { ...good, via: bad }), `via ${bad}`).toBe(false);
    }
    // astra's reproduction: both strings are identifiers, and neither names anything.
    expect(ok(EmitterDeclSchema, { id: "decl.self_attested", via: "sk_live_x", bind: "secret_token" })).toBe(false);
    // An event type is a closed name for either.
    expect(ok(EmitterDeclSchema, { ...good, via: "execution_completed", bind: "execution_completed" })).toBe(true);
  });

  it("parsing never calls an accessor inside params (r1 finding 5)", () => {
    let called = false;
    const params = {};
    Object.defineProperty(params, "channel", { enumerable: true, get: () => ((called = true), "api") });
    const result = EmitterDeclSchema.safeParse({ id: "confirm.target_system", params });
    expect(result.success).toBe(false);
    expect(called).toBe(false);
    // Nested too: an envelope entry's getter.
    const entry = Object.defineProperty({ metric: "m" }, "min", { enumerable: true, get: () => ((called = true), 1) });
    expect(ok(EmitterDeclSchema, { id: "telemetry.envelope_conformance", params: { envelope: [entry] } })).toBe(false);
    expect(called).toBe(false);
  });
});

describe("a manifest is closed, and proposals are not public", () => {
  const manifest = { subject: { kind: "adapter", ref: "ipp" }, vocabVersion: 2, emits: [{ id: "artifact.hash", params: { mode: "plain" } }] };

  it("a closed manifest passes; proposals or an unknown key is refused", () => {
    expect(ok(EvidenceEmitterManifestSchema, manifest)).toBe(true);
    expect(ok(EvidenceEmitterManifestSchema, { ...manifest, proposals: [{ id: "x.y" }] })).toBe(false);
    expect(ok(EvidenceEmitterManifestSchema, { ...manifest, note: "contact me at secret@example.com" })).toBe(false);
  });
});

describe("a CSD evidence tier's primitives are closed", () => {
  const tier = { description: "t", required: [], primitives: [{ id: "artifact.hash", params: { mode: "plain" }, bind: "outputArtifactCid" }] };

  it("a ref with required params states them (r1 finding 1)", () => {
    expect(ok(ClosedCsdEvidencePrimitiveRefSchema, { id: "capture.photo_nonced" })).toBe(false);
    expect(ok(ClosedCsdEvidencePrimitiveRefSchema, { id: "measure.io_test_pair" })).toBe(false);
    expect(ok(ClosedCsdEvidencePrimitiveRefSchema, { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC2" } })).toBe(true);
    expect(ok(ClosedCsdEvidencePrimitiveRefSchema, { id: "measure.io_test_pair", params: { mode: "deterministic" } })).toBe(true);
  });

  it("every built-in CSD's photo capture states its media and class", () => {
    const refs = loadBuiltinCsds()
      .list()
      .flatMap((csd) => Object.values(csd.evidence ?? {}).flatMap((tier) => tier.primitives ?? []))
      .filter((ref) => ref.id === "capture.photo_nonced");
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref.params).toEqual({ media: "photo", minClass: "CC2" });
  });

  it("a CSD tier's parse never calls an accessor inside params (r1 finding 5)", () => {
    let called = false;
    const params = Object.defineProperty({}, "mode", { enumerable: true, get: () => ((called = true), "plain") });
    expect(ok(CsdEvidenceTierSchema, { ...tier, primitives: [{ id: "artifact.hash", params }] })).toBe(false);
    expect(called).toBe(false);
  });

  it("closed primitives pass; open params, an unknown ref key or free-text bind are refused", () => {
    expect(ok(CsdEvidenceTierSchema, tier)).toBe(true);
    expect(ok(CsdEvidenceTierSchema, { ...tier, primitives: [{ id: "artifact.hash", params: { mode: "plain", token: "x" } }] })).toBe(false);
    expect(ok(CsdEvidenceTierSchema, { ...tier, primitives: [{ id: "artifact.hash", params: { mode: "plain" }, extra: 1 }] })).toBe(false);
    expect(ok(CsdEvidenceTierSchema, { ...tier, primitives: [{ id: "artifact.hash", bind: "free text" }] })).toBe(false);
  });
});
