/**
 * D2 inc-2 — registry-snapshot endpoint + write-once content-addressed store.
 *
 * Covers the auditor-tightened requirements:
 *   - deterministic snapshot + digest for a fixed CSD set (same state → identical bytes)
 *   - GET /:registryDigest recovers the byte-identical stored artifact
 *   - write-once store: same digest re-store = verified no-op; forced byte-mismatch = error
 *   - ETag is the quoted registryDigest
 *   - drafts / retired CSDs are excluded from the served snapshot
 *   - observational metadata lives in headers, never inside the hashed `snapshot`
 *   - both routes are public reads (no auth) behind apiGate
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildContractRegistrySnapshot,
  computeRegistrySnapshotDigest,
  DEFAULT_REGISTRY_VERSION,
  type CSD,
  type CompositionBlock,
} from "@pcc/spec";
import { registrySnapshotRoutes } from "../routes/registry-snapshot.js";
import { apiGate } from "../middleware/api-gate.js";
import { getCsdRegistry, resetCsdRegistry } from "../routes/csd.js";
import {
  FsRegistrySnapshotStore,
  RegistrySnapshotCollisionError,
  _resetRegistrySnapshotStoreForTests,
} from "../services/registry-snapshot-store.js";

// ---------------------------------------------------------------------------
// Fixtures — mirror @pcc/spec's proven inc-1 test helpers (schema-valid CSD +
// a complete composition block). Kept in sync with
// packages/spec/src/csd/registry-contract-adapter.test.ts.
// ---------------------------------------------------------------------------

function csd(url: string, over: Partial<CSD> = {}): CSD {
  return {
    url,
    version: "1.0.0",
    status: "active",
    name: "Test cap",
    description: "a test capability",
    kind: "base",
    baseDefinition: null,
    parameters: [],
    constraints: [],
    pricing: { basePrice: "1.00", currency: "USDC" },
    ...over,
  };
}

function fullComposition(over: Partial<CompositionBlock> = {}): CompositionBlock {
  return {
    inputPorts: { model: { semanticType: "mesh", required: true } },
    outputPorts: { part: { semanticType: "physical-part", unit: "g", required: true } },
    allowedEffectSignatures: [{ kind: "create-asset", semanticType: "physical-part" }],
    requiredEffects: [{ kind: "create-asset", semanticType: "physical-part" }],
    allowedPreconditionSignatures: [{ kind: "has-type", stateClass: "asset", semanticType: "mesh" }],
    requiredPreconditions: [{ kind: "exists", subject: { kind: "asset", id: "input-model" } }],
    parameters: [{ name: "infill", semanticType: "ratio", required: true }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;

/** App with just the snapshot routes (no auth) — the default for behavior tests. */
function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(registrySnapshotRoutes);
  return app;
}

/** App with apiGate in front — exercises the public-read allowlist. */
function makeGatedApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(apiGate);
  void app.register(registrySnapshotRoutes);
  return app;
}

/** Seed the live CSD registry (the one getCsdRegistry serves) with composition CSDs. */
function seed(...csds: CSD[]): void {
  const reg = getCsdRegistry();
  for (const c of csds) reg.register(c);
}

beforeEach(async () => {
  resetCsdRegistry();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pcc-regsnap-"));
  _resetRegistrySnapshotStoreForTests(new FsRegistrySnapshotStore(tmpDir));
});

afterEach(async () => {
  resetCsdRegistry();
  _resetRegistrySnapshotStoreForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /api/compose/registry-snapshot — determinism
// ---------------------------------------------------------------------------

describe("GET /api/compose/registry-snapshot", () => {
  it("serves a deterministic snapshot + digest for a fixed CSD set", async () => {
    seed(
      csd("pcc://capabilities/alpha/v1", { composition: fullComposition() }),
      csd("pcc://capabilities/beta/v1", { composition: fullComposition() }),
    );
    const app = makeApp();

    const r1 = await app.inject({ method: "GET", url: "/api/compose/registry-snapshot" });
    const r2 = await app.inject({ method: "GET", url: "/api/compose/registry-snapshot" });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const b1 = r1.json();
    const b2 = r2.json();

    // Identical captured state → byte-identical body (snapshot + digest + version).
    expect(b1).toEqual(b2);
    expect(b1.registryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The endpoint's digest equals an INDEPENDENT inc-1 computation over the same
    // live registry — proves the endpoint serves the inc-1 artifact faithfully.
    const expectedDigest = await computeRegistrySnapshotDigest(
      await buildContractRegistrySnapshot(getCsdRegistry()),
    );
    expect(b1.registryDigest).toBe(expectedDigest);

    // Both seeded classes are present, keyed by capabilityClass.
    expect(Object.keys(b1.snapshot.contracts).sort()).toEqual(["alpha", "beta"]);
    expect(b1.snapshot.contracts.alpha.capabilityType).toBe("alpha");
    expect(b1.registryVersion).toBe(DEFAULT_REGISTRY_VERSION);
    expect(b1.registryVersion).toBe(b1.snapshot.registryVersion);
  });

  it("sets a strong, quoted ETag whose value is the registryDigest", async () => {
    seed(csd("pcc://capabilities/alpha/v1", { composition: fullComposition() }));
    const app = makeApp();

    const res = await app.inject({ method: "GET", url: "/api/compose/registry-snapshot" });
    expect(res.statusCode).toBe(200);
    const digest = res.json().registryDigest as string;
    expect(res.headers.etag).toBe(`"${digest}"`); // quoted, strong (no W/ prefix)
  });

  it("keeps observational metadata in headers, never inside the hashed snapshot", async () => {
    seed(csd("pcc://capabilities/alpha/v1", { composition: fullComposition() }));
    const app = makeApp();

    const res = await app.inject({ method: "GET", url: "/api/compose/registry-snapshot" });
    const body = res.json();

    // `snapshot` is exactly the inc-1 artifact shape — no observational fields.
    expect(Object.keys(body.snapshot).sort()).toEqual(["contracts", "registryVersion"]);
    expect(body.snapshot).not.toHaveProperty("generatedAt");
    expect(body.snapshot).not.toHaveProperty("servedBy");

    // Observational metadata IS present, but only in headers.
    expect(res.headers["x-pcc-registry-snapshot-generated-at"]).toBeTruthy();
    expect(res.headers["x-pcc-served-by"]).toBe("pcc-gateway");

    // Re-hashing the served snapshot reproduces the digest → nothing observational
    // leaked into the hashed artifact.
    const recomputed = await computeRegistrySnapshotDigest(body.snapshot);
    expect(recomputed).toBe(body.registryDigest);
  });

  it("excludes draft and retired CSDs from the served snapshot", async () => {
    seed(
      csd("pcc://capabilities/alpha/v1", { composition: fullComposition() }),
      csd("pcc://capabilities/beta/v1", { status: "draft", composition: fullComposition() }),
      csd("pcc://capabilities/gamma/v1", { status: "retired", composition: fullComposition() }),
    );
    const app = makeApp();

    const res = await app.inject({ method: "GET", url: "/api/compose/registry-snapshot" });
    expect(res.statusCode).toBe(200);
    const contracts = res.json().snapshot.contracts;
    expect(Object.keys(contracts)).toEqual(["alpha"]); // draft + retired excluded
  });
});

// ---------------------------------------------------------------------------
// GET /api/compose/registry-snapshot/:registryDigest — historical retrieval
// ---------------------------------------------------------------------------

describe("GET /api/compose/registry-snapshot/:registryDigest", () => {
  it("recovers the identical stored artifact by digest", async () => {
    seed(csd("pcc://capabilities/alpha/v1", { composition: fullComposition() }));
    const app = makeApp();

    const served = (await app.inject({ method: "GET", url: "/api/compose/registry-snapshot" })).json();
    const digest = served.registryDigest as string;

    const res = await app.inject({
      method: "GET",
      url: `/api/compose/registry-snapshot/${digest}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.registryDigest).toBe(digest);
    expect(body.snapshot).toEqual(served.snapshot); // identical artifact
    expect(body.registryVersion).toBe(served.registryVersion);
    expect(res.headers.etag).toBe(`"${digest}"`);
    // The recovered artifact still hashes to its digest.
    expect(await computeRegistrySnapshotDigest(body.snapshot)).toBe(digest);
  });

  it("404s a well-formed digest that was never served", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/compose/registry-snapshot/sha256:${"0".repeat(64)}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("400s a malformed digest", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/compose/registry-snapshot/not-a-real-digest",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_registry_digest");
  });
});

// ---------------------------------------------------------------------------
// Write-once, collision-verified store (unit)
// ---------------------------------------------------------------------------

describe("RegistrySnapshotStore — write-once + collision verification", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const D_A = `sha256:${"a".repeat(64)}`;
  const D_B = `sha256:${"b".repeat(64)}`;

  it("re-storing the same digest with identical bytes is a verified no-op", async () => {
    const store = new FsRegistrySnapshotStore(path.join(tmpDir, "wo1"));
    const bytes = enc("registry-snapshot-payload");

    const first = await store.put(D_A, bytes);
    expect(first.created).toBe(true);

    const second = await store.put(D_A, bytes); // identical → verified, not rewritten
    expect(second.created).toBe(false);

    expect(await store.get(D_A)).toEqual(bytes);
  });

  it("a forced byte-mismatch under the same digest is a hard error and never overwrites", async () => {
    const store = new FsRegistrySnapshotStore(path.join(tmpDir, "wo2"));
    const original = enc("original-bytes");
    const tampered = enc("DIFFERENT-bytes");

    await store.put(D_B, original);

    await expect(store.put(D_B, tampered)).rejects.toBeInstanceOf(RegistrySnapshotCollisionError);

    // The stored bytes are untouched — write-once never overwrites.
    expect(await store.get(D_B)).toEqual(original);
  });

  it("rejects a malformed digest on put", async () => {
    const store = new FsRegistrySnapshotStore(path.join(tmpDir, "wo3"));
    await expect(store.put("not-a-digest", enc("x"))).rejects.toThrow(/invalid registryDigest/);
  });

  it("get returns null for an absent or malformed digest", async () => {
    const store = new FsRegistrySnapshotStore(path.join(tmpDir, "wo4"));
    expect(await store.get(D_A)).toBeNull();
    expect(await store.get("bogus")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Public read (no auth) behind apiGate
// ---------------------------------------------------------------------------

describe("registry-snapshot routes are public reads", () => {
  it("serves the snapshot without an Authorization header (not 401)", async () => {
    seed(csd("pcc://capabilities/alpha/v1", { composition: fullComposition() }));
    const app = makeGatedApp();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/compose/registry-snapshot" });
    expect(res.statusCode).toBe(200); // public — no 401 from apiGate
    await app.close();
  });

  it("allows unauthenticated :registryDigest recall (404, not 401, for an unknown digest)", async () => {
    const app = makeGatedApp();
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: `/api/compose/registry-snapshot/sha256:${"0".repeat(64)}`,
    });
    expect(res.statusCode).toBe(404); // reached the handler unauthenticated
    await app.close();
  });
});
