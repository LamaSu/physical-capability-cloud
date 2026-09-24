/**
 * /api/onboard/registrations/:id/prove — negative tests for WP-B.
 *
 * The audit service is NOT mocked: audit assertions read the real audit_log
 * table. The evidence-photo store is an in-memory map (or a deferred/failing
 * store where a test needs one).
 *
 * Covers:
 *   - rule 7: no authenticated actor -> 401 with no lookup; no owner -> 403
 *   - another operator cannot prove or activate a registration
 *   - self-submitted evidence (every combination of photo, deviceHealth and
 *     events) never moves a registration past "reviewing" and cannot activate
 *   - a `status` field in the /prove body is ignored
 *   - fabricated/simulated events -> 422, status and record unchanged, the
 *     attempt audited, and no tier claim recorded or raised
 *   - bounded inputs: oversize encoded photo 413 before decode, non-image
 *     422, a PNG claiming 60000x60000 422, route body limit 413, count/size
 *     bounds on events/deviceHealth/hashes
 *   - a prove that loses a race to an approval is 409 and overwrites nothing
 *   - a failed audit write or photo store rolls back / records nothing
 *   - the persisted canonical evidence record and its audit record
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { canonicalize } from "@pcc/spec";
import { onboardRoutes } from "../routes/onboard.js";
import { setEvidencePhotoStoreForTests, type EvidencePhotoStore } from "../routes/onboard-evidence.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { b64, makePng } from "./fixtures/onboard-images.js";

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

const OWNER = "owner@example.com";
const OTHER = "someone-else@example.com";
const ADMIN_KEY = "wp-b-admin-key-0123456789abcdef";
const ENV_KEYS = ["NODE_ENV", "PCC_ADMIN_KEY"] as const;

// Noise pixels keep the file over 1 KB, so the same evidence is also accepted
// by the pre-change size heuristic (the regression-guard cases stay comparable).
const PNG = makePng(64, 48, { noise: true });
const PHOTO = b64(PNG);
const DEVICE_HEALTH = { status: "idle", model: "TestBot 9000", firmware: "1.0" };
const BUNDLE_HASH = "sha256:" + "ab12".repeat(16);
const recent = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();
const completion = (extra: Record<string, unknown> = {}) => ({ type: "execution_completed", timestamp: recent(), payload: { jobType: "test" }, ...extra });

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  // Stand-in for the gateway auth middleware (api-gate sets req.operatorId).
  app.addHook("onRequest", async (req) => {
    const operatorId = req.headers["x-test-operator"];
    if (typeof operatorId === "string") (req as any).operatorId = operatorId;
  });
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

/**
 * Register as `actor` (default OWNER). The registration's owner is the
 * authenticated caller (M3), so `actor` null with no identity in `operator`
 * makes an ownerless registration (the zero-address placeholder).
 * `operator` null sends no operator block at all.
 */
async function register(
  app: FastifyInstance,
  operator: Record<string, unknown> | null = { walletAddress: OWNER },
  actor: string | null = OWNER,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboard/register",
    headers: actor === null ? {} : { "x-test-operator": actor },
    payload: {
      name: "Test Printer",
      category: "fdm",
      manufacturer: "Test Co",
      model: "TestBot 9000",
      ...(operator ? { operator: { displayName: "Owner", certifications: [], trainingAcknowledgments: {}, ...operator } } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().registration.id;
}

/**
 * /register mints ids as `reg-${Date.now()}`, so two registrations in the same
 * millisecond collide (the second insert is dropped). Wait for the clock to
 * move on before registering again in the same test.
 */
async function nextMillisecond(): Promise<void> {
  const t = Date.now();
  while (Date.now() === t) await new Promise((r) => setTimeout(r, 1));
}

function prove(app: FastifyInstance, regId: string, body: unknown, operator: string | null = OWNER) {
  return app.inject({
    method: "POST",
    url: `/api/onboard/registrations/${regId}/prove`,
    headers: operator === null ? {} : { "x-test-operator": operator },
    payload: body as Record<string, unknown>,
  });
}

/**
 * A review-route call. /approve names the evidence the admin reviewed (M2):
 * `evidence` is that digest, default "none" (no proof on record).
 */
function admin(app: FastifyInstance, regId: string, action: "approve" | "activate" | "reject", opts: { key?: string; operator?: string; evidence?: string } = {}) {
  const headers: Record<string, string> = { "x-test-operator": opts.operator ?? "reviewer@example.com" };
  if (opts.key !== undefined) headers["x-admin-key"] = opts.key;
  const payload = action === "approve" ? { expectedEvidenceDigest: opts.evidence ?? "none" } : {};
  return app.inject({ method: "POST", url: `/api/onboard/registrations/${regId}/${action}`, headers, payload });
}

const stored = (regId: string) => getRepos().registrations.findById(regId)!;
const auditRows = (regId: string) =>
  getRepos()
    .auditLog.query({ resourceType: "registration", limit: 1000 })
    .filter((r) => r.resourceId === regId)
    .reverse();
const proofRecord = (regId: string) => JSON.parse(stored(regId).description!.replace(/^PROOF SUBMITTED: /, ""));

describe("/prove hardening (WP-B)", () => {
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;
  let blobs: Map<string, Uint8Array>;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = "production";
    process.env.PCC_ADMIN_KEY = ADMIN_KEY;
    blobs = new Map();
    setEvidencePhotoStoreForTests({
      put: async (bytes) => {
        const cid = `bafk-test-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
        blobs.set(cid, bytes);
        return { cid };
      },
    });
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setEvidencePhotoStoreForTests(null);
    await app.close();
    closeStore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // ── rule 7 + ownership ────────────────────────────────────────────────────

  it("/prove with no authenticated actor is 401 and never looks the registration up", async () => {
    const regId = await register(app);
    const findById = vi.spyOn(getRepos().registrations, "findById");
    const res = await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH } }, null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("authentication_required");
    expect(findById).not.toHaveBeenCalled();
    findById.mockRestore();
    expect(stored(regId).status).toBe("submitted");
  });

  it("another operator cannot prove someone else's registration (403)", async () => {
    const regId = await register(app);
    const res = await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH } }, OTHER);
    expect(res.statusCode).toBe(403);
    expect(stored(regId).status).toBe("submitted");
  });

  it("a registration with no owner identity cannot be proved by anyone (fails closed)", async () => {
    // Operator block without walletAddress or email: the old check skipped ownership entirely.
    // Registered with no authenticated caller, so no owner is bound (M3).
    const noOwner = await register(app, { displayName: "Nobody" }, null);
    const res = await prove(app, noOwner, { evidence: { deviceHealth: DEVICE_HEALTH } }, OTHER);
    expect(res.statusCode).toBe(403);
    expect(stored(noOwner).status).toBe("submitted");

    // No operator at all: /register stores the zero-address placeholder, which
    // is not an owner — even for a caller whose identity is the zero address.
    await nextMillisecond();
    const placeholder = await register(app, null, null);
    expect(placeholder).not.toBe(noOwner);
    expect(stored(placeholder).operator).toMatchObject({ walletAddress: "0x0000000000000000000000000000000000000000" });
    const zero = "0x0000000000000000000000000000000000000000";
    const res2 = await prove(app, placeholder, { evidence: { deviceHealth: DEVICE_HEALTH } }, zero);
    expect(res2.statusCode).toBe(403);
    expect(stored(placeholder).status).toBe("submitted");
  });

  it("another operator cannot activate a registration (no admin key)", async () => {
    const regId = await register(app);
    expect((await admin(app, regId, "approve", { key: ADMIN_KEY })).statusCode).toBe(200);
    for (const operator of [OTHER, OWNER]) {
      expect((await admin(app, regId, "activate", { operator })).statusCode).toBe(403);
      expect((await admin(app, regId, "activate", { operator, key: "not-the-key" })).statusCode).toBe(403);
    }
    expect(stored(regId).status).toBe("approved");
  });

  // ── self-submitted evidence never activates ───────────────────────────────

  const combos: Array<[string, () => Record<string, unknown>]> = [
    ["photo", () => ({ photoBase64: PHOTO })],
    ["deviceHealth", () => ({ deviceHealth: DEVICE_HEALTH })],
    ["events", () => ({ bundleHash: BUNDLE_HASH, events: [completion()] })],
    ["photo+deviceHealth", () => ({ photoBase64: PHOTO, deviceHealth: DEVICE_HEALTH })],
    ["photo+events", () => ({ photoBase64: PHOTO, bundleHash: BUNDLE_HASH, events: [completion()] })],
    ["deviceHealth+events", () => ({ deviceHealth: DEVICE_HEALTH, bundleHash: BUNDLE_HASH, events: [completion()] })],
    ["photo+deviceHealth+events", () => ({ photoBase64: PHOTO, deviceHealth: DEVICE_HEALTH, events: [completion()] })],
  ];

  it.each(combos)("self-submitted %s evidence stops at 'reviewing' and cannot activate", async (_label, evidence) => {
    const regId = await register(app);
    const res = await prove(app, regId, { evidence: evidence() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ activated: false, autoApproved: false, pendingReview: true });
    expect(stored(regId).status).toBe("reviewing");
    expect(stored(regId).approvedAt ?? null).toBeNull();

    // The owner cannot finish the job through any review route.
    expect((await admin(app, regId, "approve", { operator: OWNER })).statusCode).toBe(403);
    expect((await admin(app, regId, "activate", { operator: OWNER })).statusCode).toBe(403);
    expect((await admin(app, regId, "activate", { operator: OWNER, key: ADMIN_KEY + "x" })).statusCode).toBe(403);
    expect(stored(regId).status).toBe("reviewing");
  });

  it("a `status` field in the /prove body is ignored", async () => {
    const regId = await register(app);
    const res = await prove(app, regId, {
      status: "active",
      evidence: { status: "approved", deviceHealth: { ...DEVICE_HEALTH }, approvedAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration.status).toBe("reviewing");
    expect(stored(regId).status).toBe("reviewing");
    expect(stored(regId).approvedAt ?? null).toBeNull();
  });

  // ── B1: fabricated evidence ───────────────────────────────────────────────

  it.each([
    ["payload.mock", { payload: { mock: true } }],
    ["source.simulated", { source: { deviceId: "d1", deviceType: "printer", kernelId: "k1", simulated: true } }],
  ])("a fabricated event (%s) is 422, leaves the registration unchanged, and is audited", async (_label, flag) => {
    const regId = await register(app);
    const before = stored(regId);
    const res = await prove(app, regId, {
      evidence: { bundleHash: BUNDLE_HASH, deviceHealth: DEVICE_HEALTH, events: [completion(), completion(flag)] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "fabricated_evidence", fabricatedEvents: [1], currentStatus: "submitted" });
    expect(res.json()).not.toHaveProperty("evidenceTierClaim");
    const after = stored(regId);
    expect(after.status).toBe("submitted");
    expect(after.description ?? null).toBe(before.description ?? null);
    expect(blobs.size).toBe(0);

    const rows = auditRows(regId);
    expect(rows.filter((r) => r.eventType === "operator.proof_submitted")).toHaveLength(0);
    const rejected = rows.filter((r) => r.eventType === "operator.proof_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.actor).toBe(OWNER);
    expect(rejected[0]!.metadata).toMatchObject({ reason: "fabricated_evidence", fabricatedEventIndices: [1], statusUnchanged: "submitted" });
    expect(rejected[0]!.metadata).not.toHaveProperty("evidenceTierClaim");
  });

  it("a fabricated event cannot raise the tier claim", async () => {
    const regId = await register(app);
    // A genuine tier-0 claim first (deviceHealth only).
    const first = await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH } });
    expect(first.statusCode).toBe(200);
    const recorded = stored(regId).description;

    // bundleHash + a completion event would claim tier 1 — but the event is simulated.
    const res = await prove(app, regId, { evidence: { bundleHash: BUNDLE_HASH, events: [completion({ payload: { mock: true } })] } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("fabricated_evidence");
    expect(res.json()).not.toHaveProperty("evidenceTierClaim");
    expect(stored(regId).status).toBe("reviewing");
    expect(stored(regId).description).toBe(recorded);
    expect(proofRecord(regId).evidenceTierClaim).toBe(0);
    expect(auditRows(regId).filter((r) => r.eventType === "operator.proof_submitted")).toHaveLength(1);
  });

  // ── B2: bounded inputs ────────────────────────────────────────────────────

  it("an oversize encoded photo is rejected with 413 before it is decoded", async () => {
    const regId = await register(app);
    // 7,000,004 chars whose tail is not base64: the size bound fires before the
    // alphabet check, and both come before the decode.
    const decode = vi.spyOn(Buffer, "from");
    const res = await prove(app, regId, { evidence: { photoBase64: "A".repeat(7_000_000) + "!!!!", deviceHealth: DEVICE_HEALTH } });
    const base64Decodes = decode.mock.calls.filter((c) => c[1] === "base64");
    decode.mockRestore();
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("photo_too_large");
    expect(base64Decodes).toHaveLength(0);
    expect(stored(regId).status).toBe("submitted");
  });

  it("non-image bytes are 422 and do not count as a photo", async () => {
    const regId = await register(app);
    const res = await prove(app, regId, { evidence: { photoBase64: "A".repeat(2000), deviceHealth: DEVICE_HEALTH } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unsupported_photo_format");
    expect(stored(regId).status).toBe("submitted");
  });

  it("a PNG whose header claims 60000x60000 is 422", async () => {
    const regId = await register(app);
    const res = await prove(app, regId, { evidence: { photoBase64: b64(makePng(60000, 60000)), deviceHealth: DEVICE_HEALTH } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("photo_dimensions_out_of_range");
    expect(stored(regId).status).toBe("submitted");
    expect(blobs.size).toBe(0);
  });

  it("a body over the /prove route limit is 413 body_too_large", async () => {
    const regId = await register(app);
    const res = await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH }, pad: "x".repeat(8 * 1024 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("body_too_large");
    expect(stored(regId).status).toBe("submitted");
  });

  it("accepts a photo up to the route limit that the 1 MiB server default would refuse", async () => {
    const regId = await register(app);
    // ~2 MB of base64: a 700x700 RGB PNG of noise does not compress.
    const noisy = makePng(700, 700, { noise: true });
    expect(noisy.length).toBeGreaterThan(1_000_000);
    const res = await prove(app, regId, { evidence: { photoBase64: b64(noisy), deviceHealth: DEVICE_HEALTH } });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["too many events", 413, "too_many_events", { events: Array.from({ length: 201 }, () => completion()) }],
    ["events over 256 KiB", 413, "events_too_large", { events: [completion({ payload: { blob: "x".repeat(262_144) } })] }],
    ["an event type over 64 chars", 400, "invalid_event", { events: [completion({ type: "t".repeat(65) })] }],
    ["an ambiguous mock flag", 422, "ambiguous_fabrication_flag", { events: [completion({ payload: { mock: "true" } })] }],
    ["deviceHealth over 16 KiB", 413, "device_health_too_large", { deviceHealth: { ...DEVICE_HEALTH, notes: "n".repeat(17_000) } }],
    ["deviceHealth.model over 128 chars", 400, "invalid_device_health", { deviceHealth: { status: "idle", model: "m".repeat(129) } }],
    ["a bundleHash over 256 chars", 400, "invalid_bundle_hash", { bundleHash: "sha256:" + "a".repeat(250) }],
    ["an ipfsCid over 256 chars", 400, "invalid_ipfs_cid", { ipfsCid: "b".repeat(257), deviceHealth: DEVICE_HEALTH }],
    ["a non-base64 photo", 400, "invalid_photo_encoding", { photoBase64: "not base64!", deviceHealth: DEVICE_HEALTH }],
  ])("rejects %s (%i %s) and leaves the registration unchanged", async (_label, status, error, evidence) => {
    const regId = await register(app);
    const res = await prove(app, regId, { evidence });
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toBe(error);
    expect(stored(regId).status).toBe("submitted");
    expect(auditRows(regId).filter((r) => r.eventType === "operator.proof_submitted")).toHaveLength(0);
  });

  // ── B3: a prove racing an approval ────────────────────────────────────────

  it("a prove that loses the race to an approval is 409 and does not replace the approved evidence", async () => {
    const regId = await register(app);
    const first = await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH } });
    expect(first.statusCode).toBe(200);
    const reviewedDigest: string = first.json().evidenceDigest;

    // Hold the second prove inside its (awaited) photo retention step.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let signalPut!: () => void;
    const putCalled = new Promise<void>((r) => (signalPut = r));
    const deferred: EvidencePhotoStore = {
      put: async () => {
        signalPut();
        await gate;
        return { cid: "bafk-deferred" };
      },
    };
    setEvidencePhotoStoreForTests(deferred);

    const pending = prove(app, regId, { evidence: { photoBase64: PHOTO, deviceHealth: DEVICE_HEALTH, events: [completion()] } });
    await Promise.race([putCalled, pending]);
    const approved = await admin(app, regId, "approve", { key: ADMIN_KEY, evidence: reviewedDigest });
    expect(approved.statusCode).toBe(200);
    const approvedDescription = stored(regId).description;
    release();

    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invalid_transition", currentStatus: "approved" });
    expect(stored(regId).status).toBe("approved");
    expect(stored(regId).description).toBe(approvedDescription);
    expect(auditRows(regId).filter((r) => r.eventType === "operator.proof_submitted")).toHaveLength(1);
  });

  // ── failures record nothing ───────────────────────────────────────────────

  it("a failed audit write rolls the prove back (status and record unchanged)", async () => {
    const regId = await register(app);
    const before = stored(regId);
    vi.spyOn(getRepos().auditLog, "insert").mockImplementation(() => {
      throw new Error("audit store unavailable");
    });
    const res = await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("audit_write_failed");
    expect(stored(regId).status).toBe("submitted");
    expect(stored(regId).description ?? null).toBe(before.description ?? null);
  });

  it("an evidence-store failure is 503 and records nothing", async () => {
    const regId = await register(app);
    setEvidencePhotoStoreForTests({
      put: async () => {
        throw new Error("disk full");
      },
    });
    const res = await prove(app, regId, { evidence: { photoBase64: PHOTO, deviceHealth: DEVICE_HEALTH } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("evidence_store_unavailable");
    expect(stored(regId).status).toBe("submitted");
    expect(auditRows(regId).filter((r) => r.eventType === "operator.proof_submitted")).toHaveLength(0);
  });

  // ── B4: the persisted record and its audit record ─────────────────────────

  it("persists a bounded canonical evidence record and audits the transition with its digest", async () => {
    const regId = await register(app);
    const events = [completion({ payload: { jobType: "test", pages: 1 } })];
    const res = await prove(app, regId, {
      evidence: { photoBase64: "data:image/png;base64," + PHOTO, deviceHealth: DEVICE_HEALTH, events, bundleHash: BUNDLE_HASH, ipfsCid: "bafyexamplecid" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evidenceTierClaim).toBe(2);
    expect(body).not.toHaveProperty("assuranceTier");

    const record = proofRecord(regId);
    const photoSha = "sha256:" + createHash("sha256").update(PNG).digest("hex");
    const eventsSha = "sha256:" + createHash("sha256").update(canonicalize(events)).digest("hex");
    expect(record.evidence).toMatchObject({
      version: 1,
      registrationId: regId,
      submitterOperatorId: OWNER,
      photo: { sha256: photoSha, format: "png", width: 64, height: 48, bytes: PNG.length },
      events: { sha256: eventsSha, count: 1 },
      deviceHealth: DEVICE_HEALTH,
      bundleHash: BUNDLE_HASH,
      ipfsCid: "bafyexamplecid",
      evidenceTierClaim: 2,
    });
    expect(Date.parse(record.evidence.submittedAt)).not.toBeNaN();
    const expectedDigest = "sha256:" + createHash("sha256").update(canonicalize(record.evidence)).digest("hex");
    expect(record.evidenceDigest).toBe(expectedDigest);
    expect(body.evidenceDigest).toBe(expectedDigest);

    // Raw photo retained, content-addressed, and the reference recorded.
    const cid = record.evidence.photo.retained.cid as string;
    expect(record.evidence.photo.retained.store).toBe("cid-blob-local");
    expect(Buffer.from(blobs.get(cid)!).equals(PNG)).toBe(true);

    const audit = auditRows(regId).filter((r) => r.eventType === "operator.proof_submitted");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(OWNER);
    expect(audit[0]!.metadata).toMatchObject({
      registrationId: regId,
      from: "submitted",
      to: "reviewing",
      evidenceDigest: expectedDigest,
      previousEvidenceDigest: null,
      evidenceTierClaim: 2,
    });

    // A second submission during review replaces the record; the audit chain links the two.
    expect((await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH } })).statusCode).toBe(200);
    const second = auditRows(regId).filter((r) => r.eventType === "operator.proof_submitted")[1]!;
    expect(second.metadata).toMatchObject({ from: "reviewing", to: "reviewing", previousEvidenceDigest: expectedDigest });
  });
});

describe("owner routes fail closed and the review record cannot be forged or rewritten", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    setEvidencePhotoStoreForTests({ put: async () => ({ cid: "bafk-unused" }) });
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setEvidencePhotoStoreForTests(null);
    await app.close();
    closeStore();
  });

  const patch = (regId: string, payload: Record<string, unknown>, operator: string | null = OWNER) =>
    app.inject({
      method: "PATCH",
      url: `/api/onboard/registrations/${regId}`,
      headers: operator === null ? {} : { "x-test-operator": operator },
      payload,
    });
  const del = (regId: string, operator: string | null = OWNER) =>
    app.inject({
      method: "DELETE",
      url: `/api/onboard/registrations/${regId}`,
      headers: operator === null ? {} : { "x-test-operator": operator },
    });

  it("PATCH and DELETE with no authenticated actor are 401 and change nothing", async () => {
    const regId = await register(app);
    const before = stored(regId);
    expect((await patch(regId, { description: "hijacked" }, null)).statusCode).toBe(401);
    expect((await del(regId, null)).statusCode).toBe(401);
    expect(stored(regId).status).toBe("submitted");
    expect(stored(regId).description ?? null).toBe(before.description ?? null);
  });

  it("PATCH and DELETE of a registration with no owner identity are 403 for everyone", async () => {
    const regId = await register(app, { displayName: "Nobody" }, null);
    expect((await patch(regId, { description: "mine now" }, OTHER)).statusCode).toBe(403);
    expect((await del(regId, OTHER)).statusCode).toBe(403);
    expect(stored(regId).status).toBe("submitted");
  });

  it("the owner cannot rewrite the review record once evidence is submitted", async () => {
    const regId = await register(app);
    expect((await prove(app, regId, { evidence: { deviceHealth: DEVICE_HEALTH } })).statusCode).toBe(200);
    const record = stored(regId).description;
    const forged = `PROOF SUBMITTED: ${JSON.stringify({ evidenceTierClaim: 2, evidenceDigest: "sha256:" + "e".repeat(64) })}`;
    for (const description of [forged, "plain text", null]) {
      const res = await patch(regId, { description });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("evidence_locked");
    }
    expect(stored(regId).description).toBe(record);
    // Fields that are not the review record stay editable.
    expect((await patch(regId, { pricing: { baseCost: "5", minimum: "5", currency: "USDC" } })).statusCode).toBe(200);
    expect(stored(regId).description).toBe(record);
  });

  it("a forged review record is refused at /register and by PATCH before any evidence", async () => {
    const forged = `PROOF SUBMITTED: ${JSON.stringify({ evidenceTierClaim: 2 })}`;
    const reg = await app.inject({
      method: "POST",
      url: "/api/onboard/register",
      payload: { name: "Forger", category: "fdm", description: forged, operator: { walletAddress: OWNER, displayName: "O", certifications: [], trainingAcknowledgments: {} } },
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe("reserved_description");

    const regId = await register(app);
    const res = await patch(regId, { description: "  proved: {\"tier\":2}" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("reserved_description");
    // An ordinary description edit before evidence still works.
    expect((await patch(regId, { description: "A Prusa MK4 in my garage" })).statusCode).toBe(200);
    expect(stored(regId).description).toBe("A Prusa MK4 in my garage");
  });
});
