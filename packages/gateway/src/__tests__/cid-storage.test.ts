/**
 * CID Blob Storage — gateway route tests.
 *
 * Covers:
 *   POST   /api/storage           upload + idempotency + media-type detection + size limits
 *   GET    /api/storage/:cid      retrieve + range + auth gating + soft-delete handling
 *   GET    /api/storage/:cid/meta metadata-only path
 *   DELETE /api/storage/:cid      owner-only soft-delete
 *
 * Strategy:
 *   - Real better-sqlite3 in-memory store.
 *   - LocalBlobBackend with a temp directory (no network).
 *   - resolveSession mocked so requireAuth passes with a fake operatorId.
 *
 * Author: implementer-foxtrot-cid-storage
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));

import { initStore, closeStore, getStore } from "../db.js";
import { sql } from "@pcc/store";
import { storageRoutes } from "../routes/storage.js";
import {
  _resetForTests,
  LocalBlobBackend,
  computeCid,
} from "../services/cid-blob-storage.js";
import {
  initJobOffersStore,
  getJobOffersStore,
  _resetJobOffersStoreForTests,
} from "../services/job-offers-store.js";
import { resolveSession } from "../auth/siwe-auth.js";

const mockSession = resolveSession as ReturnType<typeof vi.fn>;
const OWNER = "0x0000000000000000000000000000000000000001" as const;
const OTHER = "0x0000000000000000000000000000000000000002" as const;

let app: FastifyInstance;
let tmpDir: string;

// 1KB PNG synthesized from valid magic bytes + filler. Not a real PNG body,
// but enough for media-type detection to identify it.
function syntheticPng(): Buffer {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const filler = Buffer.alloc(1024 - magic.length, 0xaa);
  return Buffer.concat([magic, filler]);
}

beforeAll(async () => {
  process.env.DATABASE_URL = ":memory:";
  initStore({ seed: false });

  tmpDir = mkdtempSync(path.join(tmpdir(), "pcc-blob-test-"));
  _resetForTests(new LocalBlobBackend(tmpDir));

  app = Fastify({ logger: false, bodyLimit: 200 * 1024 * 1024 });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(storageRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  _resetForTests();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  const { db } = getStore();
  db.run(sql`DELETE FROM storage_blobs`);
  mockSession.mockReturnValue({ address: OWNER });
});

// ───────────────────────────────────────────────────────────────────────────
// Auth gating
// ───────────────────────────────────────────────────────────────────────────

describe("storage — auth", () => {
  it("POST /api/storage returns 401 without auth", async () => {
    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("hello"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/storage/:cid returns 401 without auth (private blob)", async () => {
    // First upload as owner.
    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("private-content"),
    });
    expect(up.statusCode).toBe(201);
    const { cid } = up.json();

    // Then attempt to GET without auth.
    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "GET",
      url: `/api/storage/${cid}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /api/storage/:cid returns 401 without auth", async () => {
    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("to-delete"),
    });
    const { cid } = up.json();

    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/storage/${cid}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Upload
// ───────────────────────────────────────────────────────────────────────────

describe("storage — upload", () => {
  it("uploads a small text blob and returns a CID + metadata", async () => {
    const text = "hello cid storage";
    const bytes = Buffer.from(text);

    const res = await app.inject({
      method: "POST",
      url: "/api/storage?label=test-blob&category=manufacturing",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.cid).toBe("string");
    expect(body.cid.length).toBeGreaterThan(20);
    expect(body.size_bytes).toBe(bytes.length);
    expect(body.media_type).toBe("text/plain");
    expect(body.backend).toBe("local");
    expect(body.label).toBe("test-blob");
    expect(body.category).toBe("manufacturing");
    expect(body.idempotent).toBe(false);

    // The CID must match what computeCid would return — deterministic.
    expect(body.cid).toBe(computeCid(new Uint8Array(bytes)));
  });

  it("detects media type from magic bytes when content-type is octet-stream", async () => {
    const png = syntheticPng();
    const res = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: png,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.media_type).toBe("image/png");
    expect(body.size_bytes).toBe(png.length);
  });

  it("returns identical CID on re-upload of same bytes (idempotent)", async () => {
    const bytes = Buffer.from("idempotency-test");

    const r1 = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(r1.statusCode).toBe(201);
    const b1 = r1.json();

    const r2 = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();
    expect(b2.cid).toBe(b1.cid);
    expect(b2.idempotent).toBe(true);

    // Only one row should exist for the CID.
    const { db } = getStore();
    const rows = db.all(sql`SELECT cid FROM storage_blobs WHERE cid = ${b1.cid}`);
    expect(rows.length).toBe(1);
  });

  it("rejects empty upload with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Retrieve
// ───────────────────────────────────────────────────────────────────────────

describe("storage — retrieve", () => {
  it("GET returns the exact bytes as a forced download (C-05 containment)", async () => {
    // RULE 18 rewrite: this test previously asserted the served Content-Type
    // echoed the uploader-declared type inline (`text/plain`). That IS the
    // stored-XSS vector C-05 — an uploader who declares text/html or
    // image/svg+xml would get it rendered in the app origin. Correct behavior
    // is a non-renderable forced download, so we now assert octet-stream +
    // attachment while still requiring the bytes to round-trip exactly.
    const bytes = Buffer.from("retrieve-me");
    const up = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    const { cid } = up.json();

    const get = await app.inject({
      method: "GET",
      url: `/api/storage/${cid}`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("application/octet-stream");
    expect(String(get.headers["content-disposition"])).toMatch(/^attachment/);
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.rawPayload.toString("utf8")).toBe("retrieve-me");
  });

  it("GET /meta returns metadata without bytes", async () => {
    const bytes = Buffer.from("meta-only");
    const up = await app.inject({
      method: "POST",
      url: "/api/storage?label=meta-test",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    const { cid } = up.json();

    const meta = await app.inject({
      method: "GET",
      url: `/api/storage/${cid}/meta`,
    });
    expect(meta.statusCode).toBe(200);
    const body = meta.json();
    expect(body.cid).toBe(cid);
    expect(body.label).toBe("meta-test");
    expect(body.size_bytes).toBe(bytes.length);
  });

  it("GET with Range header returns 206 + slice", async () => {
    const bytes = Buffer.from("abcdefghijklmnopqrstuvwxyz");
    const up = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    const { cid } = up.json();

    const r = await app.inject({
      method: "GET",
      url: `/api/storage/${cid}`,
      headers: { range: "bytes=2-5" },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.toString("utf8")).toBe("cdef");
    expect(r.headers["content-range"]).toBe(`bytes 2-5/${bytes.length}`);
  });

  it("returns 400 on invalid CID syntax", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/storage/not-a-valid-cid-string",
    });
    expect(r.statusCode).toBe(400);
  });

  it("returns 404 for an unknown but well-formed CID", async () => {
    // Compute a CID for content we never uploaded.
    const phantomCid = computeCid(new Uint8Array(Buffer.from("never-uploaded")));
    const r = await app.inject({
      method: "GET",
      url: `/api/storage/${phantomCid}`,
    });
    expect(r.statusCode).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Delete
// ───────────────────────────────────────────────────────────────────────────

describe("storage — delete", () => {
  it("owner can soft-delete; subsequent GET returns 410 Gone", async () => {
    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("delete-me"),
    });
    const { cid } = up.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/storage/${cid}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().status).toBe("soft_deleted");

    const get = await app.inject({
      method: "GET",
      url: `/api/storage/${cid}`,
    });
    expect(get.statusCode).toBe(410);
  });

  it("non-owner gets 403 on DELETE", async () => {
    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("owner-only-delete"),
    });
    const { cid } = up.json();

    mockSession.mockReturnValue({ address: OTHER });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/storage/${cid}`,
    });
    expect(del.statusCode).toBe(403);
  });

  it("re-upload after soft-delete revives the row", async () => {
    mockSession.mockReturnValue({ address: OWNER });
    const bytes = Buffer.from("revive-me");
    const up1 = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    const { cid } = up1.json();

    await app.inject({ method: "DELETE", url: `/api/storage/${cid}` });

    const up2 = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(up2.statusCode).toBe(201);
    expect(up2.json().cid).toBe(cid);

    const get = await app.inject({
      method: "GET",
      url: `/api/storage/${cid}`,
    });
    expect(get.statusCode).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-05 — stored-XSS containment + server-derived public-read gating
// ───────────────────────────────────────────────────────────────────────────

describe("storage — C-05 containment", () => {
  beforeAll(() => {
    // Public-read gating now consults the job-offers store server-side.
    initJobOffersStore({});
  });
  afterAll(() => {
    _resetJobOffersStoreForTests();
  });

  it("serves an uploaded HTML blob as a non-renderable attachment, never inline text/html", async () => {
    mockSession.mockReturnValue({ address: OWNER });
    const html = Buffer.from("<script>alert(document.domain)</script>");
    const up = await app.inject({
      method: "POST",
      url: "/api/storage",
      headers: { "content-type": "text/html" },
      payload: html,
    });
    expect(up.statusCode).toBe(201);
    const { cid } = up.json();

    const get = await app.inject({ method: "GET", url: `/api/storage/${cid}` });
    expect(get.statusCode).toBe(200);
    // The uploader-declared text/html type must never be echoed back — that
    // is exactly what let the script execute in the app origin.
    expect(get.headers["content-type"]).toBe("application/octet-stream");
    expect(String(get.headers["content-disposition"])).toMatch(/^attachment/);
    // Bytes still round-trip — containment neutralizes rendering, not delivery.
    expect(get.rawPayload.toString("utf8")).toBe(html.toString("utf8"));
  });

  it("caller-supplied ?public flag alone does NOT grant unauthenticated read", async () => {
    // Marked public but linked to an offer id the server cannot resolve.
    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: "/api/storage?public=true&related_offer_id=offer-does-not-exist",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("not-really-public"),
    });
    expect(up.statusCode).toBe(201);
    const { cid } = up.json();

    // No session; the caller flag must not bypass auth without a real offer.
    mockSession.mockReturnValue(null);
    const get = await app.inject({
      method: "GET",
      url: `/api/storage/${cid}?public=true`,
    });
    expect(get.statusCode).toBe(401);
  });

  it("a blob bound to an owned, open offer is publicly readable (server-derived)", async () => {
    // A real, open offer posted by OWNER.
    const store = getJobOffersStore();
    const created = await store.create({
      capabilityType: "creative.sample",
      requirements: {},
      pricing: { amount: 1, currency: "USD", model: "fixed" },
      posterDid: OWNER,
    });
    if (!created.ok) throw new Error("offer setup failed");
    const offerId = created.offer.id;

    // OWNER uploads a public blob linked to their own offer.
    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: `/api/storage?public=true&related_offer_id=${offerId}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("portfolio-sample"),
    });
    expect(up.statusCode).toBe(201);
    const { cid } = up.json();

    // Unauthenticated read succeeds because the server verified the offer.
    mockSession.mockReturnValue(null);
    const get = await app.inject({ method: "GET", url: `/api/storage/${cid}` });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("application/octet-stream");
    expect(String(get.headers["content-disposition"])).toMatch(/^attachment/);
    expect(get.rawPayload.toString("utf8")).toBe("portfolio-sample");
  });

  it("public read is denied when the uploader does NOT own the linked offer", async () => {
    // Offer posted by OTHER; OWNER cannot make their blob public via it.
    const store = getJobOffersStore();
    const created = await store.create({
      capabilityType: "creative.sample",
      requirements: {},
      pricing: { amount: 1, currency: "USD", model: "fixed" },
      posterDid: OTHER,
    });
    if (!created.ok) throw new Error("offer setup failed");
    const offerId = created.offer.id;

    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: `/api/storage?public=true&related_offer_id=${offerId}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("hijack-attempt"),
    });
    const { cid } = up.json();

    mockSession.mockReturnValue(null);
    const get = await app.inject({ method: "GET", url: `/api/storage/${cid}` });
    expect(get.statusCode).toBe(401);
  });

  it("public read is denied once the linked offer is cancelled (visibility)", async () => {
    const store = getJobOffersStore();
    const created = await store.create({
      capabilityType: "creative.sample",
      requirements: {},
      pricing: { amount: 1, currency: "USD", model: "fixed" },
      posterDid: OWNER,
    });
    if (!created.ok) throw new Error("offer setup failed");
    const offerId = created.offer.id;

    mockSession.mockReturnValue({ address: OWNER });
    const up = await app.inject({
      method: "POST",
      url: `/api/storage?public=true&related_offer_id=${offerId}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("was-public"),
    });
    const { cid } = up.json();

    // Poster cancels the offer → it is no longer publicly visible.
    store.cancel(offerId, OWNER);

    mockSession.mockReturnValue(null);
    const get = await app.inject({ method: "GET", url: `/api/storage/${cid}` });
    expect(get.statusCode).toBe(401);
  });
});
