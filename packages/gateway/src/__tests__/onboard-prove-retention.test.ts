/**
 * /prove photo retention is bounded (WP-B round 5, M4), against the REAL
 * local CID blob store in a temporary PCC_BLOB_DIR:
 *   - a registration accepts at most 5 proofs per hour: the next is 429
 *     too_many_proofs before any decode or store, and the cap holds exactly
 *     even when proofs commit between the early check and the transition;
 *   - a prove whose transition fails (a lost CAS, a failed audit write)
 *     leaves no new blob and no staging file;
 *   - a blob that existed before the request (the store is content-addressed
 *     and shared, e.g. an /api/storage upload of the same bytes) is never
 *     removed.
 * The audit service is not mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onboardRoutes } from "../routes/onboard.js";
import { getEvidencePhotoStore, setEvidencePhotoStoreForTests } from "../routes/onboard-evidence.js";
import { LocalBlobBackend, computeCid } from "../services/cid-blob-storage.js";
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
const DEVICE_HEALTH = { status: "idle", model: "TestBot 9000" };
const PNG_A = makePng(64, 48, { noise: true });
const PNG_B = makePng(80, 60, { noise: true });

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const operatorId = req.headers["x-test-operator"];
    if (typeof operatorId === "string") (req as any).operatorId = operatorId;
  });
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

async function register(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboard/register",
    headers: { "x-test-operator": OWNER },
    payload: { name: "Printer", category: "fdm", manufacturer: "Co", model: "M1", operator: { walletAddress: OWNER } },
  });
  expect(res.statusCode).toBe(200);
  return res.json().registration.id;
}

function prove(app: FastifyInstance, regId: string, evidence: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/onboard/registrations/${regId}/prove`,
    headers: { "x-test-operator": OWNER },
    payload: { evidence },
  });
}

const proofRows = (regId: string) =>
  getRepos().auditLog.query({ eventType: "operator.proof_submitted", limit: 1000 }).filter((r) => r.resourceId === regId);

/** A proof row as a concurrent /prove would commit it. */
function commitCompetingProof(regId: string) {
  getRepos().auditLog.insert({
    timestamp: new Date().toISOString(),
    eventType: "operator.proof_submitted",
    actor: OWNER,
    resourceType: "registration",
    resourceId: regId,
    action: "prove",
    metadata: { evidenceDigest: "sha256:" + "c".repeat(64) },
  });
}

/**
 * Make the next registrations.findById (the /prove handler's read) return the
 * row as it was, then apply `competing` — another transition that commits
 * between the handler's read and its transaction.
 */
function interposeAfterRead(competing: () => void) {
  const repo = getRepos().registrations;
  const realFindById = repo.findById.bind(repo);
  vi.spyOn(repo, "findById").mockImplementationOnce((id: string) => {
    const observed = realFindById(id);
    competing();
    return observed;
  });
}

/**
 * Wrap the real evidence-photo store so `during` runs right after the photo
 * is written. Accepts both store shapes (the pre-round-5 put and the current
 * stage), so the same test runs against the pre-change code for polarity.
 */
function afterPhotoWrite(during: () => void) {
  const real = getEvidencePhotoStore() as unknown as Record<string, (bytes: Uint8Array, mediaType: string) => Promise<unknown>>;
  const wrapped: Record<string, unknown> = {};
  for (const method of ["put", "stage"]) {
    if (typeof real[method] !== "function") continue;
    wrapped[method] = async (bytes: Uint8Array, mediaType: string) => {
      const result = await real[method]!(bytes, mediaType);
      during();
      return result;
    };
  }
  setEvidencePhotoStoreForTests(wrapped as never);
}

describe("/prove photo retention is bounded (M4)", () => {
  let app: FastifyInstance;
  let blobDir: string;
  let savedBlobDir: string | undefined;

  /** Files in the blob store, by CID (staging excluded). */
  const storedCids = (): string[] => {
    const out: string[] = [];
    for (const shard of readdirSync(blobDir)) {
      if (shard.startsWith(".")) continue;
      out.push(...readdirSync(path.join(blobDir, shard)));
    }
    return out.sort();
  };
  const stagingFiles = (): string[] => {
    const dir = path.join(blobDir, ".staging");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  beforeEach(async () => {
    savedBlobDir = process.env.PCC_BLOB_DIR;
    blobDir = mkdtempSync(path.join(os.tmpdir(), "wpb-r5-blobs-"));
    process.env.PCC_BLOB_DIR = blobDir;
    setEvidencePhotoStoreForTests(null); // the real local store, rooted at blobDir
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setEvidencePhotoStoreForTests(null);
    await app.close();
    closeStore();
    rmSync(blobDir, { recursive: true, force: true });
    if (savedBlobDir === undefined) delete process.env.PCC_BLOB_DIR;
    else process.env.PCC_BLOB_DIR = savedBlobDir;
  });

  it("a prove that loses its CAS leaves no new blob and no staging file", async () => {
    const regId = await register(app);
    expect((await prove(app, regId, { photoBase64: b64(PNG_A), deviceHealth: DEVICE_HEALTH })).statusCode).toBe(200);
    expect(storedCids()).toEqual([computeCid(PNG_A)]);

    // An approval commits between this prove's read and its transaction.
    interposeAfterRead(() => {
      expect(getRepos().registrations.transitionStatus(regId, ["reviewing"], "approved", { approvedAt: new Date().toISOString() })).not.toBeNull();
    });
    const res = await prove(app, regId, { photoBase64: b64(PNG_B), deviceHealth: DEVICE_HEALTH });
    expect(res.statusCode).toBe(409);
    expect(storedCids()).toEqual([computeCid(PNG_A)]);
    expect(stagingFiles()).toEqual([]);
  });

  it("a prove whose audit write fails leaves no new blob and no staging file", async () => {
    const regId = await register(app);
    vi.spyOn(getRepos().auditLog, "insert").mockImplementation(() => {
      throw new Error("audit store unavailable");
    });
    const res = await prove(app, regId, { photoBase64: b64(PNG_B), deviceHealth: DEVICE_HEALTH });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("audit_write_failed");
    expect(storedCids()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });

  it("a blob that existed before the request is kept when the transition fails, and reused when it succeeds", async () => {
    // The same bytes were already stored, e.g. by an /api/storage upload.
    const shared = new LocalBlobBackend(blobDir);
    await shared.put(PNG_B, { mediaType: "image/png" });
    const cid = computeCid(PNG_B);

    const regId = await register(app);
    interposeAfterRead(() => {
      expect(getRepos().registrations.transitionStatus(regId, ["submitted"], "rejected", { description: "REJECTED: x" })).not.toBeNull();
    });
    expect((await prove(app, regId, { photoBase64: b64(PNG_B), deviceHealth: DEVICE_HEALTH })).statusCode).toBe(409);
    expect(storedCids()).toEqual([cid]);
    expect(Buffer.from(await shared.get(cid)).equals(PNG_B)).toBe(true);

    const other = await register(app);
    const ok = await prove(app, other, { photoBase64: b64(PNG_B), deviceHealth: DEVICE_HEALTH });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().evidence.photo.retained).toEqual({ store: "cid-blob-local", cid });
    expect(storedCids()).toEqual([cid]);
    expect(stagingFiles()).toEqual([]);
  });

  it("the 6th proof within an hour is 429 before any decode or store; other registrations are unaffected", async () => {
    const regId = await register(app);
    for (let i = 0; i < 5; i++) {
      expect((await prove(app, regId, { deviceHealth: { ...DEVICE_HEALTH, firmware: `v${i}` } })).statusCode).toBe(200);
    }

    const decode = vi.spyOn(Buffer, "from");
    const res = await prove(app, regId, { photoBase64: b64(PNG_B), deviceHealth: DEVICE_HEALTH });
    const base64Decodes = decode.mock.calls.filter((c) => c[1] === "base64");
    decode.mockRestore();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "too_many_proofs" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(3600);
    expect(base64Decodes).toHaveLength(0);
    expect(storedCids()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
    expect(proofRows(regId)).toHaveLength(5);

    const other = await register(app);
    expect((await prove(app, other, { deviceHealth: DEVICE_HEALTH })).statusCode).toBe(200);
  });

  it("the cap is exact: proofs that commit after the early check still count, and the staged photo is dropped", async () => {
    const regId = await register(app);
    for (let i = 0; i < 4; i++) {
      expect((await prove(app, regId, { deviceHealth: { ...DEVICE_HEALTH, firmware: `v${i}` } })).statusCode).toBe(200);
    }
    // While this (5th) prove writes its photo, another proof commits: 5 in the window.
    afterPhotoWrite(() => commitCompetingProof(regId));
    const res = await prove(app, regId, { photoBase64: b64(PNG_B), deviceHealth: DEVICE_HEALTH });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("too_many_proofs");
    expect(storedCids()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
    expect(proofRows(regId)).toHaveLength(5);
  });
});
