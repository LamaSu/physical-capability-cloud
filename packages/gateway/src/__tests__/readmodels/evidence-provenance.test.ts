/**
 * EvidenceProvenanceDTO (PX-7): what the gateway can truthfully say about a job's evidence, with
 * the evidence lane's vocabulary (#3346). The negatives pin what the legacy evidence reads got
 * wrong or could never know: "verified" from a row existing, an eventCount of 0 for bundles
 * that have events, and integrity nobody recomputed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { hashBundle, hashEvent, type EvidenceEvent } from "@pcc/spec";
import { buildCanonicalEvidenceEnvelope } from "../../services/evidence-envelope.js";
import { buildEvidenceProvenanceDTO, type ProvenanceBundleRow, type ProvenanceEventRow } from "../../readmodels/evidence-provenance.js";

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

describe("integrity is recomputed, and only event_bundle_hash is evidence integrity", () => {
  it("an LO-EV bundle reproduces under event_bundle_hash", async () => {
    const dto = await build([await loEvBundle("b-a", [ev("e1", "gcode_hash_verified"), ev("e2", "execution_completed")])]);
    expect(dto.bundles[0]!.integrity).toEqual({ state: "recomputed_match", model: "event_bundle_hash" });
  });

  it("a /complete bundle reproduces only as gateway_envelope (storage integrity), never as event_bundle_hash", async () => {
    const dto = await build([envelopeBundle("b-b", [ev("e1", "execution_completed")])]);
    expect(dto.bundles[0]!.integrity).toEqual({ state: "recomputed_match", model: "gateway_envelope" });
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

describe("tier coverage counts recorded, non-fabricated event types (self-reported)", () => {
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

  it("NEGATIVE: a claimed tier outside 0-3 is null and its coverage unknown", async () => {
    const dto = await build([await loEvBundle("b-h", [ev("e1", "execution_completed")], 7)]);
    expect(dto.bundles[0]!.claimedTier).toBeNull();
    expect(dto.bundles[0]!.tierCoverage.state).toBe("unknown_tier");
  });
});

describe("the DTO never claims what the gateway does not record", () => {
  it("no verdict, no checked signature, no archive; gateway-written events are counted apart", async () => {
    const dto = await build([envelopeBundle("b-i", [ev("e1", "execution_completed", { source: { deviceId: "gateway", deviceType: "machine", kernelId: "kernel-nyc" } })])]);
    expect(dto.verification.state).toBe("no_verdict_recorded");
    const b = dto.bundles[0]!;
    expect(b.signature).toEqual({ signer: ZERO, algorithm: "ed25519", checked: false });
    expect(b.archive).toEqual({ state: "not_recorded" });
    expect(b.events.gatewayAuthored).toBe(1);
    expect(JSON.stringify(dto)).not.toMatch(/"state":"verified"|"verified":true|"checked":true|"archived"/);
    expect(b.inspect).toEqual({ envelope: `GET /api/evidence/${encodeURIComponent(b.bundleHash)}`, events: "GET /api/evidence/job-1" });
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
  });

  it("a real PUT /complete bundle: gateway_envelope storage integrity, gateway-written events, no verdict", async () => {
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
    expect(b.integrity).toEqual({ state: "recomputed_match", model: "gateway_envelope" });
    expect(b.signature).toEqual({ signer: ZERO, algorithm: "ed25519", checked: false });
    expect(b.events.count).toBeGreaterThan(0);
    expect(b.events.gatewayAuthored).toBe(b.events.count);
    expect(dto.verification.state).toBe("no_verdict_recorded");
  });

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
  });

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
  });
});
