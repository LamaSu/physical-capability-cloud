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
 *     removed;
 *   - a database COMMIT that fails after the photo was placed (astra pack 88,
 *     Q3) removes the blob that request created, unless a committed record
 *     refers to it or another request in flight holds the same bytes, and no
 *     request leaves a staged photo held.
 * The audit service is not mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "@pcc/store";
import { onboardRoutes } from "../routes/onboard.js";
import { getEvidencePhotoStore, heldEvidencePhotos, setEvidencePhotoStoreForTests } from "../routes/onboard-evidence.js";
import { LocalBlobBackend, computeCid } from "../services/cid-blob-storage.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
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

/**
 * Spy on the database transaction, once per test. `failNext()` makes the next
 * transaction fail at COMMIT: its callback runs to the end first, so every
 * write in it is made and the staged photo is placed, and then an error is
 * thrown, which rolls the writes back, as a failed COMMIT does. `throwNext()`
 * makes the next transaction throw before it runs at all (a locked database).
 * Calls queue in order; `spy.mock.calls` records every transaction and its
 * config.
 */
function databaseCommits() {
  const db = getStore().db as unknown as { transaction: (fn: (tx: unknown) => unknown, config?: unknown) => unknown };
  const real = db.transaction.bind(db); // bound before the spy replaces it
  const spy = vi.spyOn(db, "transaction");
  return {
    spy,
    failNext() {
      spy.mockImplementationOnce(((fn: (tx: unknown) => unknown, config?: unknown) =>
        real((tx: unknown) => {
          fn(tx);
          throw new Error("SQLITE_FULL: database or disk is full");
        }, config)) as never);
    },
    throwNext(err: Error) {
      spy.mockImplementationOnce((() => {
        throw err;
      }) as never);
    },
    /** The `behavior` of each transaction so far. */
    behaviors(): Array<string | undefined> {
      return spy.mock.calls.map((call) => (call[1] as { behavior?: string } | undefined)?.behavior);
    },
  };
}

/**
 * Hold the next request that stages a photo right after the photo is staged:
 * it holds its CID but has not started its transaction. `staged` resolves when
 * it is held, `release()` lets it go on. Later requests are not held.
 */
function holdNextAfterStaging() {
  const real = getEvidencePhotoStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const staged = new Promise<void>((resolve) => (reached = resolve));
  let held = false;
  setEvidencePhotoStoreForTests({
    async stage(bytes, mediaType) {
      const photo = await real.stage(bytes, mediaType);
      if (!held) {
        held = true;
        reached();
        await gate;
      }
      return photo;
    },
  });
  return { staged, release };
}

/**
 * Wrap the real evidence-photo store and record what each staged photo's
 * commit() returned: true when that call created the blob, false when the CID
 * was already stored.
 */
function recordPlacements(): boolean[] {
  const real = getEvidencePhotoStore();
  const placements: boolean[] = [];
  setEvidencePhotoStoreForTests({
    async stage(bytes, mediaType) {
      const staged = await real.stage(bytes, mediaType);
      return {
        cid: staged.cid,
        commit() {
          const created = staged.commit();
          placements.push(created);
          return created;
        },
        discard: (finish) => staged.discard(finish),
      };
    },
  });
  return placements;
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
    // Whatever the test did, no request left a staged photo held: a hold that
    // was never released would stop the removal of that blob for good.
    expect(heldEvidencePhotos()).toBe(0);
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

  // ── astra pack 88, Q3 ─────────────────────────────────────────────────────
  // The photo is placed under its CID inside the transaction, so a database
  // commit that fails afterwards used to leave it behind.

  const proveWith = (regId: string, png: Buffer) => prove(app, regId, { photoBase64: b64(png), deviceHealth: DEVICE_HEALTH });
  /** The bytes stored under `cid`, read through the shared backend. */
  const blobBytes = async (cid: string) => Buffer.from(await new LocalBlobBackend(blobDir).get(cid));

  it("a database commit that fails after a fresh photo was placed leaves no blob (astra pack 88, Q3)", async () => {
    const regId = await register(app);
    const cid = computeCid(PNG_A);
    const placements = recordPlacements();
    const commits = databaseCommits();
    commits.failNext();

    const res = await proveWith(regId, PNG_A);
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("transition_failed");
    // The transaction rolled back ...
    expect(proofRows(regId)).toHaveLength(0);
    expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
    expect(stagingFiles()).toEqual([]);
    // ... after this request had created the blob (so this is the failure the
    // verdict names), and nothing references it, so it is not left behind.
    expect(placements).toEqual([true]);
    expect(storedCids()).toEqual([]);
    // The removal ran in an immediate transaction of its own, after the failed one.
    expect(commits.behaviors()).toEqual(["immediate", "immediate"]);

    // The same photo can be submitted again, and is stored once.
    const retry = await proveWith(regId, PNG_A);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().evidence.photo.retained).toEqual({ store: "cid-blob-local", cid });
    expect(storedCids()).toEqual([cid]);
    expect((await blobBytes(cid)).equals(PNG_A)).toBe(true);
  });

  it("a blob that was already stored, with no record of it, is kept when this proof fails to commit", async () => {
    // The same bytes were stored before, e.g. by an /api/storage upload.
    await new LocalBlobBackend(blobDir).put(PNG_B, { mediaType: "image/png" });
    const cid = computeCid(PNG_B);
    const regId = await register(app);
    const placements = recordPlacements();
    databaseCommits().failNext();

    const res = await proveWith(regId, PNG_B);
    expect(res.statusCode).toBe(500);
    expect(placements).toEqual([false]); // this request created nothing
    expect(proofRows(regId)).toHaveLength(0);
    expect(storedCids()).toEqual([cid]);
    expect((await blobBytes(cid)).equals(PNG_B)).toBe(true);
    expect(stagingFiles()).toEqual([]);
  });

  it("a blob that another registration's proof refers to is kept when this proof fails to commit", async () => {
    const first = await register(app);
    expect((await proveWith(first, PNG_B)).statusCode).toBe(200);
    const cid = computeCid(PNG_B);
    const second = await register(app);
    const placements = recordPlacements();
    databaseCommits().failNext();

    const res = await proveWith(second, PNG_B);
    expect(res.statusCode).toBe(500);
    expect(placements).toEqual([false]);
    expect(proofRows(second)).toHaveLength(0);
    expect(proofRows(first)).toHaveLength(1);
    expect(storedCids()).toEqual([cid]);
    expect((await blobBytes(cid)).equals(PNG_B)).toBe(true);
  });

  it("a photo that cannot be placed is a 503 that leaves no blob, no staging file and no held photo", async () => {
    const regId = await register(app);
    const cid = computeCid(PNG_A);
    // A plain file where the shard directory should be, so placing the blob fails.
    const blocker = path.join(blobDir, cid.slice(0, 2));
    writeFileSync(blocker, "not a directory");

    const res = await proveWith(regId, PNG_A);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("evidence_store_unavailable");
    expect(proofRows(regId)).toHaveLength(0);
    expect(stagingFiles()).toEqual([]);
    rmSync(blocker);
    expect(storedCids()).toEqual([]);
  });

  it("when the removal itself cannot run, the blob stays and the request still answers 500", async () => {
    const regId = await register(app);
    const cid = computeCid(PNG_A);
    const commits = databaseCommits();
    commits.failNext(); // the request's own commit fails ...
    commits.throwNext(new Error("SQLITE_BUSY: database is locked")); // ... and so does the removal

    const res = await proveWith(regId, PNG_A);
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("transition_failed");
    expect(proofRows(regId)).toHaveLength(0);
    // Fail safe: a leaked blob is harmless, a record that points at a missing one is not.
    expect(storedCids()).toEqual([cid]);
    expect(stagingFiles()).toEqual([]);
  });

  // Two requests with the same photo: both stage it, so both hold its CID.

  it("one of two proofs of the same photo fails to commit while the other is in flight: the other keeps the blob", async () => {
    const regA = await register(app);
    const regB = await register(app);
    const cid = computeCid(PNG_A);
    const commits = databaseCommits();
    const hold = holdNextAfterStaging();

    // B stages the photo and waits, holding its CID, before its transaction.
    const pendingB = proveWith(regB, PNG_A);
    await hold.staged;
    expect(heldEvidencePhotos()).toBe(1);

    // A, the same bytes, creates the blob and then fails to commit.
    commits.failNext();
    const a = await proveWith(regA, PNG_A);
    expect(a.statusCode).toBe(500);
    expect(proofRows(regA)).toHaveLength(0);
    // B holds the same bytes and may be about to record a reference to the blob
    // A placed, so A does not remove it.
    expect(storedCids()).toEqual([cid]);

    hold.release();
    const b = await pendingB;
    expect(b.statusCode).toBe(200);
    expect(b.json().evidence.photo.retained).toEqual({ store: "cid-blob-local", cid });
    expect(proofRows(regB)).toHaveLength(1);
    expect(storedCids()).toEqual([cid]);
    expect((await blobBytes(cid)).equals(PNG_A)).toBe(true);
  });

  it("two proofs of the same photo that both fail to commit leave no blob: the last one to finish removes it", async () => {
    const regA = await register(app);
    const regB = await register(app);
    const commits = databaseCommits();
    const hold = holdNextAfterStaging();

    const pendingB = proveWith(regB, PNG_A);
    await hold.staged;

    commits.failNext();
    expect((await proveWith(regA, PNG_A)).statusCode).toBe(500);
    expect(storedCids()).toEqual([computeCid(PNG_A)]); // B still holds it

    commits.failNext();
    hold.release();
    expect((await pendingB).statusCode).toBe(500);
    expect(proofRows(regA)).toHaveLength(0);
    expect(proofRows(regB)).toHaveLength(0);
    expect(storedCids()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });

  it("a blob that the storage index lists is kept when the requests that held it fail to commit", async () => {
    const regA = await register(app);
    const regB = await register(app);
    const cid = computeCid(PNG_A);
    const commits = databaseCommits();
    const hold = holdNextAfterStaging();

    const pendingB = proveWith(regB, PNG_A);
    await hold.staged;
    commits.failNext();
    expect((await proveWith(regA, PNG_A)).statusCode).toBe(500);

    // Meanwhile an /api/storage upload of the same bytes finds the blob there
    // and records its row in the storage index.
    getStore().db.run(sql`
      INSERT INTO storage_blobs (cid, size_bytes, media_type, backend, uploaded_by, created_at)
      VALUES (${cid}, ${PNG_A.length}, 'image/png', 'local', ${OWNER}, ${new Date().toISOString()})
    `);

    commits.failNext();
    hold.release();
    expect((await pendingB).statusCode).toBe(500);
    expect(storedCids()).toEqual([cid]);
    expect((await blobBytes(cid)).equals(PNG_A)).toBe(true);
  });
});
