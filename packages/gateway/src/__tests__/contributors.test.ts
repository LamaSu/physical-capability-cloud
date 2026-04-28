/**
 * Tests for the contributor-economics gateway routes:
 *
 *   POST /api/contributors                                  — profile registration
 *   GET  /api/contributors/:address                         — profile listing by address
 *   GET  /api/contributors/by-role/:role                    — profile listing by role
 *   POST /api/contributors/schedules                        — schedule publication
 *   GET  /api/contributors/schedules/:scheduleHash          — schedule fetch
 *   POST /api/contributors/schedules/:scheduleHash/evaluate — schedule evaluation
 *   POST /api/contributors/training-manifests               — training manifest set
 *   GET  /api/contributors/training-manifests/:modelIpId    — training manifest fetch
 *
 * Uses fastify.inject + an in-memory better-sqlite3 store (PCC_DB_PATH=":memory:").
 * Mirrors the style of __tests__/ip.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { contributorRoutes } from "../routes/contributors.js";
import { initStore, closeStore } from "../db.js";
import { computeScheduleHash, type RateSegment } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });

  const app = Fastify({ logger: false });
  await app.register(contributorRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";

/** A minimal flat 500 bps schedule. Hash recomputed below. */
const FLAT_500_SEGMENTS: RateSegment[] = [
  { kind: "constant", startTime: 0, endTime: null, bps: 500 },
];

const FLAT_500_HASH = computeScheduleHash({
  version: 1,
  segments: FLAT_500_SEGMENTS,
  publishedAt: "1970-01-01T00:00:00.000Z",
});

/** Adoption-indexed schedule used for the jobsPerDay path. */
const ADOPTION_SEGMENTS: RateSegment[] = [
  {
    kind: "adoption-indexed",
    startTime: 0,
    endTime: null,
    scale: 1000,
    floorBps: 100,
    capBps: 1000,
  },
];

const ADOPTION_HASH = computeScheduleHash({
  version: 1,
  segments: ADOPTION_SEGMENTS,
  publishedAt: "1970-01-01T00:00:00.000Z",
});

/** Schedule with a covering window then a gap; used for the no-segment case. */
const BOUNDED_SEGMENTS: RateSegment[] = [
  { kind: "constant", startTime: 0, endTime: 1000, bps: 700 },
];

const BOUNDED_HASH = computeScheduleHash({
  version: 1,
  segments: BOUNDED_SEGMENTS,
  publishedAt: "1970-01-01T00:00:00.000Z",
});

// ---------------------------------------------------------------------------
// POST /api/contributors
// ---------------------------------------------------------------------------

describe("POST /api/contributors", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("creates a profile and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: {
        address: ALICE,
        role: "protocol-author",
        scheduleHash: FLAT_500_HASH,
        ipId: "0xip-alice",
        metadataUri: "ipfs://bafyalice",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      profile: {
        id: string;
        address: string;
        role: string;
        scheduleHash: string;
        ipId: string | null;
      };
    }>();
    expect(body.profile.address).toBe(ALICE);
    expect(body.profile.role).toBe("protocol-author");
    expect(body.profile.scheduleHash).toBe(FLAT_500_HASH);
    expect(body.profile.ipId).toBe("0xip-alice");
    // id is composite: address:role:tail
    expect(body.profile.id.startsWith(`${ALICE}:protocol-author:`)).toBe(true);
  });

  it("rejects an unknown role with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: {
        address: ALICE,
        role: "wizard",
        scheduleHash: FLAT_500_HASH,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("invalid_request");
  });

  it("rejects a malformed scheduleHash with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: {
        address: ALICE,
        role: "operator",
        scheduleHash: "not-a-hash",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed address with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: {
        address: "0xtoo-short",
        role: "operator",
        scheduleHash: FLAT_500_HASH,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("is idempotent for the same composite id (upsert)", async () => {
    // Same (address, role, contributorNftTokenId) → same composite id.
    const payload = {
      address: ALICE,
      role: "operator",
      scheduleHash: FLAT_500_HASH,
      contributorNftTokenId: "1",
      metadataUri: "ipfs://first",
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: { ...payload, metadataUri: "ipfs://second" },
    });
    expect(second.statusCode).toBe(201);

    // Listing by address returns one record (the upserted, latest).
    const list = await app.inject({
      method: "GET",
      url: `/api/contributors/${encodeURIComponent(ALICE)}`,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ profiles: Array<{ metadataUri: string | null }> }>();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]?.metadataUri).toBe("ipfs://second");
  });
});

// ---------------------------------------------------------------------------
// GET /api/contributors/:address
// ---------------------------------------------------------------------------

describe("GET /api/contributors/:address", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("returns all profiles for an address across roles", async () => {
    for (const role of ["operator", "verifier"]) {
      await app.inject({
        method: "POST",
        url: "/api/contributors",
        payload: {
          address: ALICE,
          role,
          scheduleHash: FLAT_500_HASH,
          contributorNftTokenId: role === "operator" ? "1" : "2",
        },
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/contributors/${encodeURIComponent(ALICE)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ profiles: Array<{ role: string }> }>();
    expect(body.profiles).toHaveLength(2);
    const roles = body.profiles.map((p) => p.role).sort();
    expect(roles).toEqual(["operator", "verifier"]);
  });

  it("returns an empty array when nothing is registered for an address", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/contributors/${encodeURIComponent(BOB)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ profiles: unknown[] }>();
    expect(body.profiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/contributors/by-role/:role
// ---------------------------------------------------------------------------

describe("GET /api/contributors/by-role/:role", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("filters profiles by role", async () => {
    await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: {
        address: ALICE,
        role: "operator",
        scheduleHash: FLAT_500_HASH,
        contributorNftTokenId: "1",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: {
        address: BOB,
        role: "operator",
        scheduleHash: FLAT_500_HASH,
        contributorNftTokenId: "2",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/contributors",
      payload: {
        address: CAROL,
        role: "verifier",
        scheduleHash: FLAT_500_HASH,
        contributorNftTokenId: "3",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/contributors/by-role/operator",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ profiles: Array<{ address: string }> }>();
    expect(body.profiles).toHaveLength(2);
    const addrs = body.profiles.map((p) => p.address).sort();
    expect(addrs).toEqual([ALICE, BOB].sort());
  });
});

// ---------------------------------------------------------------------------
// POST /api/contributors/schedules
// ---------------------------------------------------------------------------

describe("POST /api/contributors/schedules", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("publishes a valid RateSchedule and returns the recomputed hash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: {
          version: 1,
          segments: FLAT_500_SEGMENTS,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ scheduleHash: string; alreadyPublished: boolean }>();
    expect(body.scheduleHash.toLowerCase()).toBe(FLAT_500_HASH.toLowerCase());
    expect(body.alreadyPublished).toBe(false);
  });

  it("computed scheduleHash matches off-chain computeScheduleHash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: {
          version: 1,
          segments: ADOPTION_SEGMENTS,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ scheduleHash: string }>();
    expect(body.scheduleHash.toLowerCase()).toBe(ADOPTION_HASH.toLowerCase());
  });

  it("ignores duplicate scheduleHash (alreadyPublished:true)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: { version: 1, segments: FLAT_500_SEGMENTS },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ alreadyPublished: boolean }>().alreadyPublished).toBe(false);

    const second = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: BOB, // different publisher; same content → same hash
        schedule: { version: 1, segments: FLAT_500_SEGMENTS },
      },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json<{ scheduleHash: string; alreadyPublished: boolean }>();
    expect(body.alreadyPublished).toBe(true);
    expect(body.scheduleHash.toLowerCase()).toBe(FLAT_500_HASH.toLowerCase());
  });

  it("rejects schedules with malformed segments (Zod fail) with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: {
          version: 1,
          segments: [
            // bps > 10000 violates ConstantSegmentSchema bps.max(10000)
            { kind: "constant", startTime: 0, endTime: null, bps: 99999 },
          ],
        },
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects mismatched caller-claimed scheduleHash with 400", async () => {
    const wrongHash = "0x" + "f".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: {
          version: 1,
          segments: FLAT_500_SEGMENTS,
          scheduleHash: wrongHash,
        },
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("schedule_hash_mismatch");
  });

  // SEAM-1 round-trip: response.canonicalBytes must hash to response.scheduleHash
  // exactly. This is the bytes-vs-hash invariant the on-chain
  // RateScheduleRegistry.publish(bytes, expectedHash) check enforces, so the
  // gateway response must hand integrators bytes that DO hash to the value
  // they will reference at ContributorNFT.mint() time. Without this, the
  // off-chain hash and on-chain bytes drift apart and mint reverts with
  // "Schedule not registered" — see verify-05-e2e.md SEAM-1.
  it("returns canonicalBytes whose sha256 equals scheduleHash (on-chain round-trip)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: {
          // Note: caller submits keys in version-first / segments-second order.
          // Server must still return canonical bytes with `segments` first
          // (lex-sort), and that canonical sha256 is the one ContributorNFT
          // will gate against.
          version: 1,
          segments: FLAT_500_SEGMENTS,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      scheduleHash: string;
      canonicalBytes: string;
      alreadyPublished: boolean;
    }>();

    // 1. canonicalBytes is present
    expect(typeof body.canonicalBytes).toBe("string");
    expect(body.canonicalBytes.length).toBeGreaterThan(0);

    // 2. canonicalBytes is in canonical (lex-sorted-keys) form — segments before version
    expect(body.canonicalBytes.indexOf('"segments"')).toBeLessThan(
      body.canonicalBytes.indexOf('"version"'),
    );

    // 3. The on-chain invariant: sha256(canonicalBytes) === scheduleHash.
    //    This is exactly what `RateScheduleRegistry.publish(bytes, expectedHash)`
    //    re-checks on-chain. If this assertion ever fails, integrators following
    //    the deploy doc will publish under one hash and mint under another.
    const computedHashHex = createHash("sha256")
      .update(body.canonicalBytes)
      .digest("hex");
    expect(`0x${computedHashHex}`.toLowerCase()).toBe(
      body.scheduleHash.toLowerCase(),
    );
  });

  it("returns canonicalBytes on duplicate publishes too (for idempotent on-chain re-runs)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: { version: 1, segments: FLAT_500_SEGMENTS },
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: BOB,
        schedule: { version: 1, segments: FLAT_500_SEGMENTS },
      },
    });
    expect(second.statusCode).toBe(200);

    const firstBody = first.json<{ canonicalBytes: string; scheduleHash: string }>();
    const secondBody = second.json<{
      canonicalBytes: string;
      scheduleHash: string;
      alreadyPublished: boolean;
    }>();

    expect(secondBody.alreadyPublished).toBe(true);
    // alreadyPublished response must STILL include canonicalBytes — operators
    // re-running a deploy script on an already-published schedule still need
    // those bytes to feed the on-chain publish (which itself short-circuits
    // via exists()).
    expect(secondBody.canonicalBytes).toBe(firstBody.canonicalBytes);
    expect(secondBody.scheduleHash.toLowerCase()).toBe(
      firstBody.scheduleHash.toLowerCase(),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/contributors/schedules/:scheduleHash
// ---------------------------------------------------------------------------

describe("GET /api/contributors/schedules/:scheduleHash", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("returns the parsed schedule", async () => {
    await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: { version: 1, segments: FLAT_500_SEGMENTS },
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/contributors/schedules/${encodeURIComponent(FLAT_500_HASH)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      schedule: { version: number; segments: RateSegment[] };
      publishedBy: string;
    }>();
    expect(body.schedule.version).toBe(1);
    expect(body.schedule.segments).toHaveLength(1);
    expect(body.schedule.segments[0]?.kind).toBe("constant");
    expect(body.publishedBy).toBe(ALICE);
  });

  it("returns 404 for an unknown scheduleHash", async () => {
    const unknown = "0x" + "a".repeat(64);
    const res = await app.inject({
      method: "GET",
      url: `/api/contributors/schedules/${encodeURIComponent(unknown)}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("schedule_not_found");
  });
});

// ---------------------------------------------------------------------------
// POST /api/contributors/schedules/:scheduleHash/evaluate
// ---------------------------------------------------------------------------

describe("POST /api/contributors/schedules/:scheduleHash/evaluate", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("returns bps for a constant segment", async () => {
    await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: { version: 1, segments: FLAT_500_SEGMENTS },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/contributors/schedules/${encodeURIComponent(FLAT_500_HASH)}/evaluate`,
      payload: { now: 12345 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ bps: number; segmentKind: string }>();
    expect(body.bps).toBe(500);
    expect(body.segmentKind).toBe("constant");
  });

  it("returns bps for an adoption-indexed segment using jobsPerDay", async () => {
    await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: { version: 1, segments: ADOPTION_SEGMENTS },
      },
    });

    // scale=1000, jobsPerDay=100 → 1000/sqrt(100)=100, clamped to floor 100.
    const res = await app.inject({
      method: "POST",
      url: `/api/contributors/schedules/${encodeURIComponent(ADOPTION_HASH)}/evaluate`,
      payload: { now: 0, jobsPerDay: 100 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ bps: number; segmentKind: string }>();
    expect(body.segmentKind).toBe("adoption-indexed");
    expect(body.bps).toBe(100);
  });

  it("returns 0 bps when no segment covers the moment", async () => {
    await app.inject({
      method: "POST",
      url: "/api/contributors/schedules",
      payload: {
        publishedBy: ALICE,
        schedule: { version: 1, segments: BOUNDED_SEGMENTS },
      },
    });

    // BOUNDED_SEGMENTS covers [0, 1000); now=5000 lies in the gap → 0 bps.
    const res = await app.inject({
      method: "POST",
      url: `/api/contributors/schedules/${encodeURIComponent(BOUNDED_HASH)}/evaluate`,
      payload: { now: 5000 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ bps: number; segmentIndex: number }>();
    expect(body.bps).toBe(0);
    expect(body.segmentIndex).toBe(-1);
  });

  it("404s for an unknown scheduleHash", async () => {
    const unknown = "0x" + "b".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: `/api/contributors/schedules/${encodeURIComponent(unknown)}/evaluate`,
      payload: { now: 1 },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/contributors/training-manifests
// ---------------------------------------------------------------------------

describe("POST /api/contributors/training-manifests", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("stores a valid manifest and returns the manifest hash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/training-manifests",
      payload: {
        modelIpId: "0xmodel-1",
        datasetWeights: [
          { datasetIpId: "0xdataset-a", weightBps: 6000 },
          { datasetIpId: "0xdataset-b", weightBps: 4000 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ modelIpId: string; manifestHash: string }>();
    expect(body.modelIpId).toBe("0xmodel-1");
    expect(body.manifestHash).toMatch(/^0x[a-f0-9]{64}$/i);
  });

  it("rejects when weights sum > 10000 bps", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/training-manifests",
      payload: {
        modelIpId: "0xmodel-bad",
        datasetWeights: [
          { datasetIpId: "0xdataset-a", weightBps: 6000 },
          { datasetIpId: "0xdataset-b", weightBps: 5000 },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("weights_exceed_total");
  });

  it("upserts on duplicate modelIpId (matches repo semantics)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/contributors/training-manifests",
      payload: {
        modelIpId: "0xmodel-2",
        datasetWeights: [
          { datasetIpId: "0xdataset-a", weightBps: 10000 },
        ],
      },
    });
    expect(first.statusCode).toBe(200);

    // Re-publish with different datasets — the repo does
    // onConflictDoUpdate(modelIpId), so the second call replaces the row.
    const second = await app.inject({
      method: "POST",
      url: "/api/contributors/training-manifests",
      payload: {
        modelIpId: "0xmodel-2",
        datasetWeights: [
          { datasetIpId: "0xdataset-x", weightBps: 7000 },
          { datasetIpId: "0xdataset-y", weightBps: 3000 },
        ],
      },
    });
    expect(second.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: `/api/contributors/training-manifests/${encodeURIComponent("0xmodel-2")}`,
    });
    expect(get.statusCode).toBe(200);
    const body = get.json<{ manifest: { datasets: Array<{ datasetIpId: string }> } }>();
    const ids = body.manifest.datasets.map((d) => d.datasetIpId).sort();
    expect(ids).toEqual(["0xdataset-x", "0xdataset-y"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/contributors/training-manifests/:modelIpId
// ---------------------------------------------------------------------------

describe("GET /api/contributors/training-manifests/:modelIpId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("404s for unknown modelIpId", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/contributors/training-manifests/${encodeURIComponent("0xnope")}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("training_manifest_not_found");
  });
});
