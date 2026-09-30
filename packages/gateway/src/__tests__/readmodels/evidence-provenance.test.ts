/**
 * EvidenceProvenanceDTO (PX-7): what the gateway can truthfully say about a job's evidence, with
 * the evidence lane's vocabulary (#3346). The negatives pin what the legacy evidence reads got
 * wrong or could never know: "verified" from a row existing, an eventCount of 0 for bundles
 * that have events, and integrity nobody recomputed.
 */
import { provenWalletFor } from "../helpers/job-read-party.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { hashBundle, hashEvent, type EvidenceEvent } from "@pcc/spec";
import { buildCanonicalEvidenceEnvelope } from "../../services/evidence-envelope.js";
import { buildEvidenceProvenanceDTO, type ProvenanceBundleRow, type ProvenanceEventRow } from "../../readmodels/evidence-provenance.js";

import { PLACEHOLDER_SIGNATURE_VALUES } from "../../services/device-evidence-settlement.js";

const AS_OF = "2026-09-28T12:00:00.000Z";
const ZERO = "0x0000000000000000000000000000000000000000";

function ev(id: string, type: string, extra: Partial<ProvenanceEventRow> = {}): Omit<ProvenanceEventRow, "hash"> {
  return {
    id,
    type,
    timestamp: `2026-09-28T10:00:0${id.slice(-1)}.000Z`,
    source: { deviceId: "printer-1", deviceType: "machine", kernelId: "kernel-nyc" },
    payload: { n: id },
    ...extra,
  };
}

/** A bundle as the kernel emitter writes it: LO-EV event hashes and bundle hash. */
async function loEvBundle(id: string, events: Array<Omit<ProvenanceEventRow, "hash">>, tier = 1): Promise<ProvenanceBundleRow> {
  const hashed = await Promise.all(events.map(async (e) => ({ ...e, hash: await hashEvent(e as unknown as EvidenceEvent) })));
  return {
    id,
    jobId: "job-1",
    stepId: "step-1",
    kernelId: "kernel-nyc",
    assuranceTier: tier,
    bundleHash: await hashBundle(hashed as unknown as EvidenceEvent[]),
    kernelSignature: { signer: "0xabc", algorithm: "secp256k1", value: "sig" },
    createdAt: "2026-09-28T10:01:00.000Z",
    events: hashed,
  };
}

/** A bundle as PUT /complete writes it: event hashes over {type,timestamp}, bundle hash over the envelope. */
function envelopeBundle(id: string, events: Array<Omit<ProvenanceEventRow, "hash">>, tier = 1): ProvenanceBundleRow {
  const hashed = events.map((e) => ({ ...e, hash: `sha256:${createHash("sha256").update(JSON.stringify({ type: e.type, timestamp: e.timestamp })).digest("hex")}` }));
  const kernelSignature = { signer: ZERO, algorithm: "ed25519", value: "gateway-auto-sign" };
  const row = { id, jobId: "job-1", stepId: "step-1", kernelId: "kernel-nyc", assuranceTier: tier, createdAt: "2026-09-28T10:02:00.000Z", kernelSignature };
  const envelope = buildCanonicalEvidenceEnvelope(row, hashed);
  return { ...row, bundleHash: `sha256:${createHash("sha256").update(envelope).digest("hex")}`, events: hashed };
}

const build = (rows: ProvenanceBundleRow[]) => buildEvidenceProvenanceDTO("job-1", { ok: true, value: rows }, AS_OF);

describe("integrity is recomputed, and only event_bundle_hash is evidence integrity (recomputed_match)", () => {
  it("an LO-EV bundle reproduces under event_bundle_hash", async () => {
    const dto = await build([await loEvBundle("b-a", [ev("e1", "gcode_hash_verified"), ev("e2", "execution_completed")])]);
    expect(dto.bundles[0]!.integrity).toEqual({ state: "recomputed_match", model: "event_bundle_hash" });
  });

  it("NEGATIVE (evidence #3680 F3): a /complete bundle is storage_envelope_match, never recomputed_match", async () => {
    const dto = await build([envelopeBundle("b-b", [ev("e1", "execution_completed")])]);
    expect(dto.bundles[0]!.integrity).toEqual({ state: "storage_envelope_match", model: "gateway_envelope" });
    // A surface reading only `state` never sees "recomputed" for a bundle /settle would refuse.
    expect(dto.bundles[0]!.integrity.state).not.toBe("recomputed_match");
  });

  it("NEGATIVE (evidence #3680): a value no model can canonicalize is no_model_reproduces for that bundle, never a failed read", async () => {
    // Canonicalizing this payload throws in both models. Today a circular value does; after #359,
    // an integer beyond 2^53-1 will too.
    const bad = await loEvBundle("b-big", [ev("e1", "execution_completed")]);
    const circular: Record<string, unknown> = { n: 1 };
    circular.self = circular;
    bad.events[0] = { ...bad.events[0]!, payload: circular };
    const good = await loEvBundle("b-ok", [ev("e1", "execution_completed")]);
    const dto = await build([bad, good]);
    expect(dto.state).toBe("received");
    const byId = Object.fromEntries(dto.bundles.map((b) => [b.bundleId, b.integrity]));
    expect(byId["b-big"]).toEqual({ state: "no_model_reproduces", model: null });
    expect(byId["b-ok"]).toEqual({ state: "recomputed_match", model: "event_bundle_hash" });
  });

  it("NEGATIVE: a payload changed after hashing reproduces under no model", async () => {
    const a = await loEvBundle("b-c", [ev("e1", "gcode_hash_verified"), ev("e2", "execution_completed")]);
    a.events[1] = { ...a.events[1]!, payload: { n: "tampered" } };
    const b = envelopeBundle("b-d", [ev("e1", "execution_completed")]);
    b.events[0] = { ...b.events[0]!, payload: { n: "tampered" } };
    const dto = await build([a, b]);
    for (const bundle of dto.bundles) expect(bundle.integrity, bundle.bundleId).toEqual({ state: "no_model_reproduces", model: null });
  });

  it("NEGATIVE: a bundle hash with no events (relay, setup) is not recomputable, never a match", async () => {
    const dto = await build([
      { id: "b-e", jobId: "job-1", stepId: "s", kernelId: "k", assuranceTier: 0, bundleHash: "sha256-b-e", kernelSignature: null, createdAt: AS_OF, events: [] },
    ]);
    expect(dto.bundles[0]!.integrity).toEqual({ state: "not_recomputable", model: null });
  });
});

describe("tier coverage counts the event types a DEVICE recorded: not fabricated, not gateway-stamped (self-reported)", () => {
  it("covers when every required group has a counted event and the minimum is met", async () => {
    const dto = await build([await loEvBundle("b-f", [ev("e1", "gcode_hash_verified"), ev("e2", "execution_completed"), ev("e3", "power_profile_summary")], 1)]);
    expect(dto.bundles[0]!.tierCoverage).toMatchObject({ state: "covers", missing: [], minimumEvents: 3, countedEvents: 3, basis: "recorded_event_types" });
  });

  it("NEGATIVE (evidence #3346): a fabricated event never satisfies a requirement or the minimum", async () => {
    const dto = await build([
      await loEvBundle("b-g", [
        ev("e1", "gcode_hash_verified"),
        ev("e2", "execution_completed"),
        ev("e3", "power_profile_summary", { payload: { mock: true } }),
      ], 1),
    ]);
    const b = dto.bundles[0]!;
    expect(b.events.fabricated).toBe(1);
    expect(b.tierCoverage.state).toBe("missing");
    expect(b.tierCoverage.missing).toEqual([["power_profile_summary"]]);
    expect(b.tierCoverage.countedEvents).toBe(2);
  });

  it("NEGATIVE (evidence #3680 F1, their probe): a bundle as /complete writes it, claimed tier 2, never covers", async () => {
    // /complete stamps its own execution_completed and the caller's body events, of ANY type,
    // with source.deviceId "gateway". No device reported them.
    const gw = { source: { deviceId: "gateway", deviceType: "machine", kernelId: "kernel-nyc" } };
    const dto = await build([
      envelopeBundle(
        "b-probe",
        [
          ev("e1", "execution_completed", gw),
          ev("e2", "gcode_hash_verified", gw),
          ev("e3", "power_profile_summary", gw),
          ev("e4", "cv_inspection_result", gw),
        ],
        2,
      ),
    ]);
    const b = dto.bundles[0]!;
    expect(b.events).toMatchObject({ count: 4, gatewayAuthored: 4, fabricated: 0 });
    expect(b.tierCoverage).toMatchObject({ state: "missing", countedEvents: 0, minimumEvents: 4 });
    expect(b.tierCoverage.missing).toHaveLength(4);
    expect(b.integrity.state).toBe("storage_envelope_match");
    expect(b.signature).toEqual({ signer: null, algorithm: null, checked: false });
  });

  it("NEGATIVE (evidence #3680 F1): device events count; a gateway-stamped one among them does not", async () => {
    const dto = await build([
      await loEvBundle("b-mixed", [
        ev("e1", "gcode_hash_verified"),
        ev("e2", "execution_completed", { source: { deviceId: "gateway", deviceType: "machine", kernelId: "kernel-nyc" } }),
        ev("e3", "power_profile_summary"),
      ], 1),
    ]);
    const b = dto.bundles[0]!;
    expect(b.tierCoverage).toMatchObject({ state: "missing", countedEvents: 2 });
    expect(b.tierCoverage.missing).toEqual([["execution_completed"]]);
  });

  it("NEGATIVE: a claimed tier outside 0-3 is null and its coverage unknown", async () => {
    const dto = await build([await loEvBundle("b-h", [ev("e1", "execution_completed")], 7)]);
    expect(dto.bundles[0]!.claimedTier).toBeNull();
    expect(dto.bundles[0]!.tierCoverage.state).toBe("unknown_tier");
  });

  it("NEGATIVE (M3): events with no device source (source: null) never satisfy tier coverage", async () => {
    const dto = await build([
      await loEvBundle(
        "b-nosource",
        [
          ev("e1", "gcode_hash_verified", { source: null }),
          ev("e2", "execution_completed", { source: null }),
          ev("e3", "power_profile_summary", { source: null }),
        ],
        1,
      ),
    ]);
    const b = dto.bundles[0]!;
    expect(b.events).toMatchObject({ count: 3, fabricated: 0, gatewayAuthored: 0 });
    expect(b.tierCoverage.state).not.toBe("covers");
    expect(b.tierCoverage.countedEvents).toBe(0);
    expect(b.tierCoverage.missing).toHaveLength(3);
  });
});

describe("the DTO never claims what the gateway does not record", () => {
  it("no verdict, no checked signature, no archive; gateway-written events are counted apart", async () => {
    const dto = await build([envelopeBundle("b-i", [ev("e1", "execution_completed", { source: { deviceId: "gateway", deviceType: "machine", kernelId: "kernel-nyc" } })])]);
    expect(dto.verification.state).toBe("no_verdict_recorded");
    const b = dto.bundles[0]!;
    // evidence #3680 F2: the gateway's zero-address placeholder is no signature.
    expect(b.signature).toEqual({ signer: null, algorithm: null, checked: false });
    expect(b.archive).toEqual({ state: "not_recorded" });
    expect(b.events.gatewayAuthored).toBe(1);
    expect(JSON.stringify(dto)).not.toMatch(/"state":"verified"|"verified":true|"checked":true|"archived"/);
    expect(b.inspect).toEqual({ envelope: `GET /api/evidence/${encodeURIComponent(b.bundleHash)}`, events: "GET /api/evidence/job-1" });
  });

  it("NEGATIVE (evidence #3680 F2): a placeholder is no signature, by its signer or its value; a real signer is shown as stored", async () => {
    const withSig = async (id: string, kernelSignature: unknown) => {
      const b = await loEvBundle(id, [ev("e1", "execution_completed")]);
      return { ...b, kernelSignature };
    };
    const dto = await build([
      await withSig("s-zero", { signer: ZERO.toUpperCase().replace("0X", "0x"), algorithm: "ed25519", value: "x" }),
      await withSig("s-value", { signer: "0xabc", algorithm: "ed25519", value: "gateway-auto-sign" }),
      await withSig("s-real", { signer: "0xabc", algorithm: "secp256k1", value: "sig" }),
    ]);
    const sig = Object.fromEntries(dto.bundles.map((b) => [b.bundleId, b.signature]));
    expect(sig["s-zero"]).toEqual({ signer: null, algorithm: null, checked: false });
    expect(sig["s-value"]).toEqual({ signer: null, algorithm: null, checked: false });
    expect(sig["s-real"]).toEqual({ signer: "0xabc", algorithm: "secp256k1", checked: false });
  });

  it("NEGATIVE (evidence #4088): the relay's placeholder, every gateway placeholder value and the emitter's test marker are no signature; a secp256k1 kernel signature is still shown", async () => {
    const withSig = async (id: string, kernelSignature: unknown) => {
      const b = await loEvBundle(id, [ev("e1", "execution_completed")]);
      return { ...b, kernelSignature };
    };
    const secp = "0x1111111111111111111111111111111111111111";
    const dto = await build([
      // POST /api/operator/evidence stores a bundle without a device signature like this (their probe).
      await withSig("s-relay", { signer: "kernel-1", algorithm: "sha256", value: "operator-relay-auto" }),
      ...(await Promise.all(
        [...PLACEHOLDER_SIGNATURE_VALUES].map((value, i) => withSig(`s-set-${i}`, { signer: "kernel-1", algorithm: "ed25519", value })),
      )),
      await withSig("s-test", { signer: "0xabc", algorithm: "ed25519", value: "test_sig_run-1" }),
      await withSig("s-secp", { signer: secp, algorithm: "secp256k1", value: "0xdead" }),
    ]);
    const sig = Object.fromEntries(dto.bundles.map((b) => [b.bundleId, b.signature]));
    const none = { signer: null, algorithm: null, checked: false };
    expect(sig["s-relay"]).toEqual(none);
    for (let i = 0; i < PLACEHOLDER_SIGNATURE_VALUES.size; i += 1) expect(sig[`s-set-${i}`]).toEqual(none);
    expect(sig["s-test"]).toEqual(none);
    expect(sig["s-secp"]).toEqual({ signer: secp, algorithm: "secp256k1", checked: false });
  });

  it("NEGATIVE (M4): the deviceless self-attest placeholder (routes/setup.ts) is no signature; real secp256k1/ed25519 signatures still show", async () => {
    const withSig = async (id: string, kernelSignature: unknown) => {
      const b = await loEvBundle(id, [ev("e1", "execution_completed")]);
      return { ...b, kernelSignature };
    };
    const dto = await build([
      // routes/setup.ts's deviceless branch writes exactly this shape (:765,:783).
      await withSig("s-self-attest", {
        signer: "self-attest",
        algorithm: "none",
        value: "self-attested by kernel kernel-nyc at 2026-09-28T10:00:00.000Z",
      }),
      await withSig("s-secp2", { signer: "0x2222222222222222222222222222222222222222", algorithm: "secp256k1", value: "0xbeef" }),
      await withSig("s-ed2", { signer: "kernel-ed", algorithm: "ed25519", value: "0xfeed" }),
    ]);
    const sig = Object.fromEntries(dto.bundles.map((b) => [b.bundleId, b.signature]));
    expect(sig["s-self-attest"]).toEqual({ signer: null, algorithm: null, checked: false });
    expect(sig["s-secp2"]).toEqual({ signer: "0x2222222222222222222222222222222222222222", algorithm: "secp256k1", checked: false });
    expect(sig["s-ed2"]).toEqual({ signer: "kernel-ed", algorithm: "ed25519", checked: false });
  });

  it("NEGATIVE (evidence #3680 nit): first and last are ordered by time, not by string, and shown as recorded", async () => {
    const dto = await build([
      await loEvBundle("b-times", [
        ev("e1", "gcode_hash_verified", { timestamp: "2026-09-28T10:00:00.500Z" }),
        ev("e2", "execution_completed", { timestamp: "2026-09-28T10:00:00Z" }),
        ev("e3", "power_profile_summary", { timestamp: "2026-09-28T12:00:00+02:00" }),
        ev("e4", "photo_captured", { timestamp: "not a time" }),
      ]),
    ]);
    // As strings, "...00.500Z" sorts before "...00Z" and "+02:00" (10:00Z) after both.
    expect(dto.bundles[0]!.events).toMatchObject({ firstAt: "2026-09-28T10:00:00Z", lastAt: "2026-09-28T10:00:00.500Z" });
  });

  it("counts and order: newest first; counts are sums of the bundles", async () => {
    const older = await loEvBundle("b-old", [ev("e1", "execution_completed")]);
    older.createdAt = "2026-09-28T09:00:00.000Z";
    const newer = envelopeBundle("b-new", [ev("e1", "execution_completed"), ev("e2", "photo_captured", { payload: { mock: true } })]);
    const dto = await build([older, newer]);
    expect(dto.bundles.map((b) => b.bundleId)).toEqual(["b-new", "b-old"]);
    expect(dto.counts).toEqual({ bundles: 2, events: 3, fabricatedEvents: 1, gatewayAuthoredEvents: 0 });
    expect(dto.bundles[0]!.events).toMatchObject({ count: 2, types: ["execution_completed", "photo_captured"], firstAt: expect.any(String), lastAt: expect.any(String) });
  });

  it("NEGATIVE: an unreadable store is unavailable with null counts, never none", async () => {
    const dto = await buildEvidenceProvenanceDTO("job-1", { ok: false }, AS_OF);
    expect(dto).toMatchObject({ state: "unavailable", counts: null, bundles: [], schemaId: "pcc.evidence-provenance/v1" });
    const none = await build([]);
    expect(none).toMatchObject({ state: "none", counts: { bundles: 0, events: 0, fabricatedEvents: 0, gatewayAuthoredEvents: 0 } });
  });
});

/**
 * PUT /complete starts the in-process evidence store (Helia by default), which takes about 4 s
 * alone and more under a loaded machine's full suite; 5 s was too tight there at 5a947235 and
 * after it. The wait is for startup, not for an answer the test could miss.
 */
const REAL_STORE_TIMEOUT_MS = 30_000;

describe("GET /api/jobs/:jobId/evidence/provenance on a real store", () => {
  let app: FastifyInstance;
  const OPERATOR_NYC = "0x1111111111111111111111111111111111111111";

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true";
    const db = await import("../../db.js");
    db.initStore({ seed: true });
    const { paidJobFlowRoutes } = await import("../../routes/paid-job-flow.js");
    const { negotiationRoutes } = await import("../../routes/negotiation.js");
    const { evidenceProvenanceRoutes } = await import("../../routes/evidence-provenance.js");
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const p = req.headers["x-test-principal"];
      if (typeof p === "string" && p !== "none") (req as any).operatorId = p;
      else if (p === undefined) (req as any).operatorId = OPERATOR_NYC;
      // WP-A's gate proves a wallet by SIWE (#353 r3): a wallet principal reads as proven.
      (req as any).provenWallet = provenWalletFor(req.headers["x-test-proven-wallet"], (req as any).operatorId);
    });
    await app.register(paidJobFlowRoutes);
    await app.register(negotiationRoutes);
    await app.register(evidenceProvenanceRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // PUT /complete starts the in-process evidence store; stop it as the server's onClose does
    // (server.ts), or its native handles can abort the process at exit.
    await (await import("../../services.js")).stopEvidenceStorage();
    (await import("../../db.js")).closeStore();
    delete process.env.MOCK_SETTLEMENT;
  }, REAL_STORE_TIMEOUT_MS);

  it("a real PUT /complete bundle: storage_envelope_match, gateway-stamped events that cover nothing, no signature, no verdict", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId: "user-agent-prov" },
    });
    expect(created.statusCode).toBe(201);
    const { jobId } = created.json();
    expect((await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} })).statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/evidence/provenance` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const dto = res.json();
    expect(dto.state).toBe("received");
    const b = dto.bundles[0];
    expect(b.integrity).toEqual({ state: "storage_envelope_match", model: "gateway_envelope" });
    expect(b.signature).toEqual({ signer: null, algorithm: null, checked: false });
    expect(b.events.count).toBeGreaterThan(0);
    expect(b.events.gatewayAuthored).toBe(b.events.count);
    // Every event is gateway-stamped, so nothing counts toward the claimed tier.
    expect(b.tierCoverage.countedEvents).toBe(0);
    expect(b.tierCoverage.state).not.toBe("covers");
    expect(dto.verification.state).toBe("no_verdict_recorded");
  }, REAL_STORE_TIMEOUT_MS);

  it("NEGATIVE (facts map item B): the legacy evidence reads count the bundle's real events, not 0", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId: "user-agent-prov3" },
    });
    const { jobId } = created.json();
    expect((await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} })).statusCode).toBe(200);
    const prov = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}/evidence/provenance` })).json();
    const events = prov.bundles[0].events.count;
    expect(events).toBeGreaterThan(0);
    const { getComplianceFacade, getJobFacade } = await import("../../facades/index.js");
    const list = await getComplianceFacade().getEvidenceForJob(jobId);
    expect(list.success && list.data[0]!.eventCount).toBe(events);
    const one = await getComplianceFacade().getBundle(prov.bundles[0].bundleId);
    expect(one.success && one.data.eventCount).toBe(events);
    const detail = await getJobFacade().getById(jobId);
    expect(detail.success && detail.data.evidenceBundles[0]!.eventCount).toBe(events);
  }, REAL_STORE_TIMEOUT_MS);

  it("NEGATIVE: anonymous is 401; another principal gets the same 404 as a missing job", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId: "user-agent-prov2" },
    });
    const { jobId } = created.json();
    expect((await app.inject({ method: "GET", url: `/api/jobs/${jobId}/evidence/provenance`, headers: { "x-test-principal": "none" } })).statusCode).toBe(401);
    const other = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/evidence/provenance`, headers: { "x-test-principal": "0x9999999999999999999999999999999999999999" } });
    const missing = await app.inject({ method: "GET", url: "/api/jobs/job-does-not-exist/evidence/provenance", headers: { "x-test-principal": "0x9999999999999999999999999999999999999999" } });
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(other.body.replace(jobId, "X")).toBe(missing.body.replace("job-does-not-exist", "X"));
    // A key that only CLAIMS the operator's id, without a proven wallet, is 403 (#353 r3).
    const claimed = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/evidence/provenance`,
      headers: { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": "none" },
    });
    expect(claimed.statusCode).toBe(403);
    expect(claimed.json().error).toBe("identity_unverified");
  }, REAL_STORE_TIMEOUT_MS);
});
