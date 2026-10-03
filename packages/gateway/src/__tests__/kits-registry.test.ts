/**
 * Black-box tests for the Capability Kit registry (kits K1 slice 1).
 *
 * Source of truth: ai/.../spec-k1-slice1.md (the "Tests" section + the
 * reviewer's detailed point-by-point checklist). Every assertion here is
 * taken directly from that spec. Where the implementation disagrees with the
 * spec, the assertion is left as the spec states it — a failure here is a
 * reportable divergence, not a bug in the test.
 *
 * Strategy: service unit tests call KitRegistry methods directly; route
 * tests go through Fastify's `app.inject` with `kitRoutes` mounted standalone
 * (no api-gate/scope-checker — those are covered separately in
 * kits-scope.test.ts). The authenticated principal is injected via an
 * onRequest hook that sets `(req as any).operatorId`, mirroring
 * compliance-routes.test.ts's `buildAuthedApp` pattern.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  canonicalize,
  computeKitDigest,
  normalizeKitManifest,
  type CapabilityKitManifestV1,
} from "@pcc/spec";
import {
  KitRegistry,
  KitRegistryError,
  KitIntegrityError,
  isDurableKitRoot,
} from "../services/kit-registry.js";
import { kitRoutes } from "../routes/kits.js";
import type { AuditEntry } from "../services/audit-service.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

/** `H("a")` => `sha256:aaaa...a` (64 hex chars). Matches the spec's helper exactly. */
const H = (c: string) => `sha256:${c.repeat(64)}`;

/** A COMPLETE manifest (passes validateKitCompleteness), per the spec's fixture. */
function kit(overrides: Partial<CapabilityKitManifestV1> = {}): CapabilityKitManifestV1 {
  return {
    schema: "pcc.capability-kit/v1",
    name: "OT-2 dye serial dilution",
    version: "1.0.0",
    parentKitDigest: null,
    capabilities: [{ csdUrl: "pcc://capabilities/liquid-handling/v1", capabilityContractDigest: H("a") }],
    artifacts: [
      { role: "method", name: "serial-dilution.py", mediaType: "text/x-python", digest: H("1") },
      { role: "tests", name: "checks.json", mediaType: "application/json", digest: H("5") },
      { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: H("6") },
      { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: H("7") },
    ],
    compatibility: { deviceFamilies: ["opentrons-ot2"], interfaces: ["opentrons"] },
    declaredAssuranceTiers: [1],
    economics: { spdxLicense: "Apache-2.0" },
    ...overrides,
  } as CapabilityKitManifestV1;
}

/** A manifest whose canonical form exceeds 256 KiB via 200 artifacts (zod's cap) each
 * carrying a near-max `source` field (2000 chars, unconstrained in format). */
function oversizedKit(): CapabilityKitManifestV1 {
  const filler = (i: number) => ({
    role: "docs" as const,
    name: `filler-${String(i).padStart(3, "0")}.md`,
    mediaType: "text/markdown",
    digest: H("0"),
    source: "x".repeat(2000),
  });
  return kit({
    version: "9.9.9",
    name: "oversized kit for the 413 bound",
    artifacts: [
      { role: "method", name: "impl.py", mediaType: "text/x-python", digest: H("1") },
      { role: "tests", name: "checks.json", mediaType: "application/json", digest: H("5") },
      { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: H("6") },
      { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: H("7") },
      ...Array.from({ length: 196 }, (_, i) => filler(i)),
    ],
  });
}

// ── Temp roots ───────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function mkTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "kits-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A registry rooted in a fresh temp dir. `durable` defaults to `() => true` so
 * tests are never at the mercy of the ambient NODE_ENV — the durability guard
 * is tested explicitly in its own section below.
 */
async function mkRegistry(
  opts: {
    now?: () => Date;
    dailyLimit?: number;
    audit?: (entry: AuditEntry) => void;
    durable?: () => boolean;
  } = {},
): Promise<{ registry: KitRegistry; rootDir: string }> {
  const rootDir = await mkTempRoot();
  const registry = new KitRegistry({ rootDir, durable: () => true, ...opts });
  return { registry, rootDir };
}

/** `<root>/manifests/<hex[0:2]>/<hex>.json` per the spec's on-disk layout. */
function manifestFilePath(rootDir: string, digest: string): string {
  const hex = digest.slice("sha256:".length);
  return path.join(rootDir, "manifests", hex.slice(0, 2), `${hex}.json`);
}

/** `<root>/publications/<hex[0:2]>/<hex>.json` per the spec's on-disk layout. */
function publicationFilePath(rootDir: string, digest: string): string {
  const hex = digest.slice("sha256:".length);
  return path.join(rootDir, "publications", hex.slice(0, 2), `${hex}.json`);
}

async function writeRawPublication(
  rootDir: string,
  atDigest: string,
  record: { schema: string; kitDigest: string; publisher: string; publishedAt: string },
): Promise<void> {
  const file = publicationFilePath(rootDir, atDigest);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, canonicalize(record));
}

/**
 * Build a Fastify app with only kitRoutes mounted. When `operatorId` is
 * provided, an onRequest hook stamps `(req as any).operatorId` before the
 * route runs (the compliance-routes.test.ts `buildAuthedApp` pattern).
 * Omitting it simulates an unauthenticated caller (no principal at all).
 */
async function buildApp(registry: KitRegistry, operatorId?: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  if (operatorId !== undefined) {
    app.decorateRequest("operatorId", null);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { operatorId: string }).operatorId = operatorId;
    });
  }
  await app.register(kitRoutes, { registry });
  return app;
}

// ── Publish and read ─────────────────────────────────────────────────────

describe("publish and read", () => {
  it("publish then get round-trips the normalized manifest", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const manifest = kit({ version: "1.0.0" });

    const publishRes = await app.inject({ method: "POST", url: "/api/kits", payload: manifest });
    expect(publishRes.statusCode).toBe(201);
    const { kitDigest } = publishRes.json();

    const getRes = await app.inject({ method: "GET", url: `/api/kits/${kitDigest}` });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.kit.kitDigest).toBe(kitDigest);
    expect(body.kit.manifest).toEqual(normalizeKitManifest(manifest));
    expect(typeof body.kit.publishedAt).toBe("string");
    await app.close();
  });

  it("the digest equals computeKitDigest", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const manifest = kit({ version: "1.0.1" });

    const res = await app.inject({ method: "POST", url: "/api/kits", payload: manifest });
    expect(res.json().kitDigest).toBe(await computeKitDigest(manifest));
    await app.close();
  });

  it("two manifests differing only in artifact list order get the same digest; the second publish is created:false", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const manifest = kit({ version: "1.0.2" });
    const reordered = { ...manifest, artifacts: [...manifest.artifacts].reverse() };

    const res1 = await app.inject({ method: "POST", url: "/api/kits", payload: manifest });
    expect(res1.statusCode).toBe(201);
    expect(res1.json().created).toBe(true);

    const res2 = await app.inject({ method: "POST", url: "/api/kits", payload: reordered });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().created).toBe(false);
    expect(res2.json().kitDigest).toBe(res1.json().kitDigest);
    await app.close();
  });

  it("a re-publish by another principal is created:false, and the publisher on record is unchanged", async () => {
    const { registry } = await mkRegistry();
    const manifest = kit({ version: "1.0.3" });
    const appAlice = await buildApp(registry, "alice@kits.test");
    const res1 = await appAlice.inject({ method: "POST", url: "/api/kits", payload: manifest });
    const digest = res1.json().kitDigest;

    const appBob = await buildApp(registry, "bob@kits.test");
    const res2 = await appBob.inject({ method: "POST", url: "/api/kits", payload: manifest });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().created).toBe(false);
    expect(await registry.publisherOf(digest)).toBe("alice@kits.test");

    await appAlice.close();
    await appBob.close();
  });
});

// ── Service unit: get() ──────────────────────────────────────────────────

describe("service unit: KitRegistry.get", () => {
  it("throws KitRegistryError invalid_digest (400) for a malformed digest", async () => {
    const { registry } = await mkRegistry();
    const err = await registry.get("not-a-digest").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitRegistryError);
    expect((err as KitRegistryError).code).toBe("invalid_digest");
    expect((err as KitRegistryError).status).toBe(400);
  });

  it("returns null for a well-formed digest that was never published", async () => {
    const { registry } = await mkRegistry();
    expect(await registry.get(H("e"))).toBeNull();
  });
});

// ── Integrity ─────────────────────────────────────────────────────────────

describe("integrity", () => {
  it("flipping one byte of a stored manifest: get gives 500; after a reload the kit is skipped and absent from list", async () => {
    const { registry, rootDir } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const res = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.1.0" }) });
    const digest = res.json().kitDigest;

    const mp = manifestFilePath(rootDir, digest);
    const bytes = await fs.readFile(mp);
    bytes[0] = bytes[0]! ^ 0xff;
    await fs.writeFile(mp, bytes);

    const getRes = await app.inject({ method: "GET", url: `/api/kits/${digest}` });
    expect(getRes.statusCode).toBe(500);
    expect(getRes.json().error).toBe("kit_integrity_failure");

    const reloaded = new KitRegistry({ rootDir, durable: () => true });
    const list = await reloaded.list();
    expect(list.kits.find((k) => k.kitDigest === digest)).toBeUndefined();
    expect(reloaded.skipped).toContain(digest);

    await app.close();
  });

  it("service unit: KitRegistry.get throws KitIntegrityError on corrupted manifest bytes", async () => {
    const { registry, rootDir } = await mkRegistry();
    const result = await registry.publish(kit({ version: "1.1.05" }), "alice@kits.test");
    const mp = manifestFilePath(rootDir, result.kitDigest);
    const bytes = await fs.readFile(mp);
    bytes[0] = bytes[0]! ^ 0xff;
    await fs.writeFile(mp, bytes);

    const err = await registry.get(result.kitDigest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitIntegrityError);
    expect((err as KitIntegrityError).code).toBe("kit_integrity_failure");
  });

  it("refuses hash-valid but non-canonical manifest bytes (pretty-printed JSON)", async () => {
    const { registry, rootDir } = await mkRegistry();
    const manifest = normalizeKitManifest(kit({ version: "1.1.1" }));
    const prettyPrinted = JSON.stringify(manifest, null, 2);
    // Sanity: pretty-printing really does differ from the canonical form.
    expect(prettyPrinted).not.toBe(canonicalize(manifest));
    const digest = `sha256:${createHash("sha256").update(prettyPrinted, "utf8").digest("hex")}`;

    const mp = manifestFilePath(rootDir, digest);
    await fs.mkdir(path.dirname(mp), { recursive: true });
    await fs.writeFile(mp, prettyPrinted, "utf8");
    await writeRawPublication(rootDir, digest, {
      schema: "pcc.kit-publication.v1",
      kitDigest: digest,
      publisher: "attacker@kits.test",
      publishedAt: new Date(0).toISOString(),
    });

    const app = await buildApp(registry, "alice@kits.test");
    const getRes = await app.inject({ method: "GET", url: `/api/kits/${digest}` });
    expect(getRes.statusCode).toBe(500);
    expect(getRes.json().error).toBe("kit_integrity_failure");
    await app.close();
  });

  it("refuses another kit's valid, canonical manifest stored under this digest (kits K1, own review)", async () => {
    const { registry, rootDir } = await mkRegistry();
    const a = await registry.publish(kit({ version: "7.0.0" }), "alice@kits.test");
    const b = await registry.publish(kit({ version: "7.0.1" }), "alice@kits.test");
    // B's bytes are a valid canonical manifest, just not the one A's digest names.
    await fs.writeFile(manifestFilePath(rootDir, a.kitDigest), await fs.readFile(manifestFilePath(rootDir, b.kitDigest)));
    await expect(registry.get(a.kitDigest)).rejects.toBeInstanceOf(KitIntegrityError);
    const app = await buildApp(registry, "alice@kits.test");
    const res = await app.inject({ method: "GET", url: `/api/kits/${a.kitDigest}` });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("kit_integrity_failure");
    await app.close();
  });

  it("refuses a publication record naming another digest", async () => {
    const { registry, rootDir } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const res = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.1.2" }) });
    const digest = res.json().kitDigest;
    const otherDigest = H("9");

    // Overwrite the publication record stored AT `digest`'s path so its own
    // content claims a different digest entirely.
    await writeRawPublication(rootDir, digest, {
      schema: "pcc.kit-publication.v1",
      kitDigest: otherDigest,
      publisher: "alice@kits.test",
      publishedAt: res.json().publishedAt,
    });

    const getRes = await app.inject({ method: "GET", url: `/api/kits/${digest}` });
    expect(getRes.statusCode).toBe(500);
    expect(getRes.json().error).toBe("kit_integrity_failure");
    await app.close();
  });

  it("refuses a publication record whose manifest bytes are missing", async () => {
    const { registry, rootDir } = await mkRegistry();
    const digest = H("7");
    await writeRawPublication(rootDir, digest, {
      schema: "pcc.kit-publication.v1",
      kitDigest: digest,
      publisher: "alice@kits.test",
      publishedAt: new Date(0).toISOString(),
    });

    const app = await buildApp(registry, "alice@kits.test");
    const getRes = await app.inject({ method: "GET", url: `/api/kits/${digest}` });
    expect(getRes.statusCode).toBe(500);
    expect(getRes.json().error).toBe("kit_integrity_failure");
    await app.close();
  });
});

// ── Concurrency ───────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("same-instance: two concurrent first publishes of one digest yield exactly one created:true, one publication file, and publisherOf returns the winner", async () => {
    const { registry, rootDir } = await mkRegistry();
    const manifest = kit({ version: "1.2.0" });

    const [r1, r2] = await Promise.all([
      registry.publish(manifest, "alice@kits.test"),
      registry.publish(manifest, "bob@kits.test"),
    ]);

    expect([r1.created, r2.created].filter(Boolean)).toHaveLength(1);
    expect(r1.kitDigest).toBe(r2.kitDigest);
    expect(r1.publishedAt).toBe(r2.publishedAt);

    const digest = r1.kitDigest;
    const hex = digest.slice("sha256:".length);
    const files = await fs.readdir(path.join(rootDir, "publications", hex.slice(0, 2)));
    expect(files).toEqual([`${hex}.json`]);

    const winner = await registry.publisherOf(digest);
    expect(["alice@kits.test", "bob@kits.test"]).toContain(winner);
  });

  it("cross-instance: two separate KitRegistry instances on the same root concurrently publishing the same new digest still yield exactly one record", async () => {
    const rootDir = await mkTempRoot();
    const regA = new KitRegistry({ rootDir, durable: () => true });
    const regB = new KitRegistry({ rootDir, durable: () => true });
    const manifest = kit({ version: "1.2.1" });

    const [rA, rB] = await Promise.all([
      regA.publish(manifest, "alice@kits.test"),
      regB.publish(manifest, "bob@kits.test"),
    ]);

    expect([rA.created, rB.created].filter(Boolean)).toHaveLength(1);
    expect(rA.kitDigest).toBe(rB.kitDigest);
    expect(rA.publishedAt).toBe(rB.publishedAt);

    const digest = rA.kitDigest;
    const hex = digest.slice("sha256:".length);
    const files = await fs.readdir(path.join(rootDir, "publications", hex.slice(0, 2)));
    expect(files).toEqual([`${hex}.json`]);

    const winnerPublisher = rA.created ? "alice@kits.test" : "bob@kits.test";
    expect(await regA.publisherOf(digest)).toBe(winnerPublisher);
    expect(await regB.publisherOf(digest)).toBe(winnerPublisher);
  });
});

// ── Validation ────────────────────────────────────────────────────────────

describe("validation", () => {
  it("400 invalid_manifest and never echoes the manifest's description text", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const secretDescription = "TOP-SECRET-DESCRIPTION-MARKER-should-never-be-echoed";
    const bad = { ...kit({ version: "not-semver" }), description: secretDescription };

    const res = await app.inject({ method: "POST", url: "/api/kits", payload: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_manifest");
    expect(res.body).not.toContain(secretDescription);
    await app.close();
  });

  it("413 manifest_too_large when the canonical manifest exceeds 256 KiB", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const big = oversizedKit();

    const canonicalBytes = Buffer.byteLength(canonicalize(normalizeKitManifest(big)), "utf8");
    // Sanity: confirm the fixture is genuinely oversized before trusting a 413.
    expect(canonicalBytes).toBeGreaterThan(256 * 1024);

    const res = await app.inject({ method: "POST", url: "/api/kits", payload: big });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("manifest_too_large");
    await app.close();
  });

  it("422 incomplete_kit with the missing requirements", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const incomplete = kit({ version: "1.3.2", artifacts: [kit().artifacts[0]!] });

    const res = await app.inject({ method: "POST", url: "/api/kits", payload: incomplete });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("incomplete_kit");
    expect(res.json().missing).toEqual(
      expect.arrayContaining(["role:tests", "role:install-recipe", "role:provenance-recipe"]),
    );
    await app.close();
  });

  it("422 unknown_parent when parentKitDigest names no published kit", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const res = await app.inject({
      method: "POST",
      url: "/api/kits",
      payload: kit({ version: "1.3.3", parentKitDigest: H("9") }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_parent");
    await app.close();
  });

  it("fork 400 parent_mismatch when the manifest's parentKitDigest differs from the URL digest", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const resA = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.3.40" }) });
    const resB = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.3.41" }) });
    const digestA = resA.json().kitDigest;
    const digestB = resB.json().kitDigest;

    const forkManifest = kit({ version: "1.3.5", parentKitDigest: digestB, name: "mismatched fork" });
    const res = await app.inject({ method: "POST", url: `/api/kits/${digestA}/fork`, payload: forkManifest });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("parent_mismatch");
    await app.close();
  });

  it("fork 404 when the URL digest names no published kit", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const absentDigest = H("c");
    const forkManifest = kit({ version: "1.3.6", parentKitDigest: absentDigest, name: "fork of nothing" });

    const res = await app.inject({ method: "POST", url: `/api/kits/${absentDigest}/fork`, payload: forkManifest });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 invalid_digest on GET with a malformed digest", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const res = await app.inject({ method: "GET", url: "/api/kits/not-a-digest" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_digest");
    await app.close();
  });

  it("400 invalid_digest on fork with a malformed URL digest", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    const res = await app.inject({
      method: "POST",
      url: "/api/kits/not-a-digest/fork",
      payload: kit({ version: "1.3.7" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_digest");
    await app.close();
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("401 missing_identity on publish without a principal", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry);
    const res = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.4.0" }) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_identity");
    await app.close();
  });

  it("401 missing_identity on fork without a principal", async () => {
    const { registry } = await mkRegistry();
    const appAlice = await buildApp(registry, "alice@kits.test");
    const parentRes = await appAlice.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.4.1" }) });
    const parentDigest = parentRes.json().kitDigest;

    const appAnon = await buildApp(registry);
    const res = await appAnon.inject({
      method: "POST",
      url: `/api/kits/${parentDigest}/fork`,
      payload: kit({ version: "1.4.2", parentKitDigest: parentDigest, name: "anon fork attempt" }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_identity");

    await appAlice.close();
    await appAnon.close();
  });
});

// ── Privacy ───────────────────────────────────────────────────────────────

describe("privacy", () => {
  const PUBLISHER = "alice@kits.test";

  it("never leaks the publisher string in list, get, publish, fork, or error response bodies", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, PUBLISHER);

    const publishRes = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.5.0" }) });
    expect(publishRes.body).not.toContain(PUBLISHER);
    const digest = publishRes.json().kitDigest;

    const getRes = await app.inject({ method: "GET", url: `/api/kits/${digest}` });
    expect(getRes.body).not.toContain(PUBLISHER);

    const listRes = await app.inject({ method: "GET", url: "/api/kits" });
    expect(listRes.body).not.toContain(PUBLISHER);

    const forkRes = await app.inject({
      method: "POST",
      url: `/api/kits/${digest}/fork`,
      payload: kit({ version: "1.5.1", parentKitDigest: digest, name: "fork of dilution" }),
    });
    expect(forkRes.body).not.toContain(PUBLISHER);

    // Re-publish (created:false path) must also stay silent.
    const republishRes = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "1.5.0" }) });
    expect(republishRes.body).not.toContain(PUBLISHER);

    // Error paths (incomplete manifest) must also stay silent.
    const badRes = await app.inject({
      method: "POST",
      url: "/api/kits",
      payload: { ...kit({ version: "1.5.2" }), artifacts: [kit().artifacts[0]!] },
    });
    expect(badRes.body).not.toContain(PUBLISHER);

    await app.close();
  });
});

// ── Quota ─────────────────────────────────────────────────────────────────

describe("quota", () => {
  it("the 3rd new kit by one publisher in 24h gives 429; a re-publish doesn't count; another publisher is unaffected; the clock rolling 24h+1ms frees the window", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const { registry } = await mkRegistry({ dailyLimit: 2, now: () => clock });
    const appAlice = await buildApp(registry, "alice@kits.test");
    const appBob = await buildApp(registry, "bob@kits.test");

    const k1 = kit({ version: "2.0.0" });
    const k2 = kit({ version: "2.0.1" });
    const k3 = kit({ version: "2.0.2" });
    const k4 = kit({ version: "2.0.3" });

    const r1 = await appAlice.inject({ method: "POST", url: "/api/kits", payload: k1 });
    expect(r1.statusCode).toBe(201);
    const r2 = await appAlice.inject({ method: "POST", url: "/api/kits", payload: k2 });
    expect(r2.statusCode).toBe(201);

    // Re-publishing an existing digest must not count against the quota.
    const rRepublish = await appAlice.inject({ method: "POST", url: "/api/kits", payload: k1 });
    expect(rRepublish.statusCode).toBe(200);
    expect(rRepublish.json().created).toBe(false);

    const r3 = await appAlice.inject({ method: "POST", url: "/api/kits", payload: k3 });
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error).toBe("publish_quota");

    // Another publisher is unaffected by alice's quota, and may publish the
    // very digest alice was refused (it was never actually written).
    const rBob = await appBob.inject({ method: "POST", url: "/api/kits", payload: k3 });
    expect(rBob.statusCode).toBe(201);

    // Re-publishing an existing digest never counts against the re-publisher either:
    // bob is now at his cap of 2 (k3 above plus one more), yet re-publishing alice's k1 is 200.
    const rBob2 = await appBob.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "2.0.9" }) });
    expect(rBob2.statusCode).toBe(201);
    const rBobRepublish = await appBob.inject({ method: "POST", url: "/api/kits", payload: k1 });
    expect(rBobRepublish.statusCode).toBe(200);
    expect(rBobRepublish.json().created).toBe(false);
    expect(await registry.publisherOf(r1.json().kitDigest)).toBe("alice@kits.test");

    // Advance the injected clock 24h + 1ms: alice's first two publishes roll
    // out of the rolling window, freeing her to publish again.
    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000 + 1);
    const r4 = await appAlice.inject({ method: "POST", url: "/api/kits", payload: k4 });
    expect(r4.statusCode).toBe(201);

    await appAlice.close();
    await appBob.close();
  });
});

// ── Durability guard ───────────────────────────────────────────────────────

describe("durability guard", () => {
  it("503 registry_not_durable on publish when the root is not durable; GET and list still work", async () => {
    const { registry } = await mkRegistry({ durable: () => false });
    const app = await buildApp(registry, "alice@kits.test");

    const res = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "3.0.0" }) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("registry_not_durable");

    const listRes = await app.inject({ method: "GET", url: "/api/kits" });
    expect(listRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: `/api/kits/${H("d")}` });
    expect(getRes.statusCode).toBe(404);

    await app.close();
  });
});

describe("isDurableKitRoot", () => {
  const ENV_KEYS = ["NODE_ENV", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_KIT_REGISTRY_DIR"] as const;
  let saved: Record<string, string | undefined>;

  function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  afterEach(() => {
    for (const k of ENV_KEYS) setEnv(k, saved[k]);
  });

  function snapshot(): void {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  }

  it("is false in production with neither a volume mount nor an explicit registry dir", () => {
    snapshot();
    setEnv("NODE_ENV", "production");
    setEnv("RAILWAY_VOLUME_MOUNT_PATH", undefined);
    setEnv("PCC_KIT_REGISTRY_DIR", undefined);
    expect(isDurableKitRoot()).toBe(false);
  });

  it("is true in production with RAILWAY_VOLUME_MOUNT_PATH set", () => {
    snapshot();
    setEnv("NODE_ENV", "production");
    setEnv("RAILWAY_VOLUME_MOUNT_PATH", "/data");
    setEnv("PCC_KIT_REGISTRY_DIR", undefined);
    expect(isDurableKitRoot()).toBe(true);
  });

  it("is true in production with PCC_KIT_REGISTRY_DIR set", () => {
    snapshot();
    setEnv("NODE_ENV", "production");
    setEnv("RAILWAY_VOLUME_MOUNT_PATH", undefined);
    setEnv("PCC_KIT_REGISTRY_DIR", "/some/explicit/dir");
    expect(isDurableKitRoot()).toBe(true);
  });

  it("is true outside production regardless of volume/dir vars", () => {
    snapshot();
    setEnv("NODE_ENV", "development");
    setEnv("RAILWAY_VOLUME_MOUNT_PATH", undefined);
    setEnv("PCC_KIT_REGISTRY_DIR", undefined);
    expect(isDurableKitRoot()).toBe(true);
  });
});

// ── Lists ─────────────────────────────────────────────────────────────────

describe("list", () => {
  async function seedCorpus() {
    let clock = new Date("2026-02-01T00:00:00.000Z");
    const { registry } = await mkRegistry({ now: () => clock });
    const app = await buildApp(registry, "alice@kits.test");
    const specs = [
      {
        version: "4.0.0",
        name: "Liquid handling basics",
        csdUrl: "pcc://capabilities/liquid-handling/v1",
        deviceFamily: "opentrons-ot2",
        iface: "opentrons",
      },
      {
        version: "4.0.1",
        name: "CNC milling starter",
        csdUrl: "pcc://capabilities/cnc-milling/v1",
        deviceFamily: "shapeoko-pro",
        iface: "generic-http",
      },
      {
        version: "4.0.2",
        name: "Liquid handling advanced",
        csdUrl: "pcc://capabilities/liquid-handling/v1",
        deviceFamily: "hamilton-star",
        iface: "hamilton",
      },
    ];
    const published: Array<{ digest: string; publishedAt: string; name: string }> = [];
    for (const s of specs) {
      const manifest = kit({
        version: s.version,
        name: s.name,
        capabilities: [{ csdUrl: s.csdUrl, capabilityContractDigest: H("a") }],
        compatibility: { deviceFamilies: [s.deviceFamily], interfaces: [s.iface] },
      });
      const res = await app.inject({ method: "POST", url: "/api/kits", payload: manifest });
      published.push({ digest: res.json().kitDigest, publishedAt: res.json().publishedAt, name: s.name });
      clock = new Date(clock.getTime() + 60_000);
    }
    return { registry, app, published };
  }

  it("filters by csdUrl exactly", async () => {
    const { app } = await seedCorpus();
    const res = await app.inject({
      method: "GET",
      url: `/api/kits?csdUrl=${encodeURIComponent("pcc://capabilities/liquid-handling/v1")}`,
    });
    expect(res.statusCode).toBe(200);
    const names = res.json().kits.map((k: { name: string }) => k.name).sort();
    expect(names).toEqual(["Liquid handling advanced", "Liquid handling basics"]);
    await app.close();
  });

  it("filters by deviceFamily exactly", async () => {
    const { app } = await seedCorpus();
    const res = await app.inject({ method: "GET", url: "/api/kits?deviceFamily=hamilton-star" });
    expect(res.json().kits.map((k: { name: string }) => k.name)).toEqual(["Liquid handling advanced"]);
    await app.close();
  });

  it("filters by interface exactly", async () => {
    const { app } = await seedCorpus();
    const res = await app.inject({ method: "GET", url: "/api/kits?interface=generic-http" });
    expect(res.json().kits.map((k: { name: string }) => k.name)).toEqual(["CNC milling starter"]);
    await app.close();
  });

  it("filters by q, a case-insensitive substring of the name", async () => {
    const { app } = await seedCorpus();
    const res = await app.inject({ method: "GET", url: "/api/kits?q=LIQUID" });
    const names = res.json().kits.map((k: { name: string }) => k.name).sort();
    expect(names).toEqual(["Liquid handling advanced", "Liquid handling basics"]);
    await app.close();
  });

  it("filters by q, a case-insensitive substring of the description", async () => {
    const { registry } = await mkRegistry();
    const app = await buildApp(registry, "alice@kits.test");
    await app.inject({
      method: "POST",
      url: "/api/kits",
      payload: kit({ version: "4.2.0", name: "zzz", description: "Supports PIPETTE calibration" }),
    });
    const res = await app.inject({ method: "GET", url: "/api/kits?q=pipette" });
    expect(res.json().kits.map((k: { name: string }) => k.name)).toEqual(["zzz"]);
    await app.close();
  });

  it("orders by publishedAt descending, then kitDigest ascending; total reflects the full match count", async () => {
    const { app, published } = await seedCorpus();
    const res = await app.inject({ method: "GET", url: "/api/kits" });
    const body = res.json();
    expect(body.total).toBe(3);
    const expectedOrder = [...published].reverse().map((p) => p.digest);
    expect(body.kits.map((k: { kitDigest: string }) => k.kitDigest)).toEqual(expectedOrder);
    await app.close();
  });

  it("breaks publishedAt ties by kitDigest ascending", async () => {
    const fixedClock = new Date("2026-03-01T00:00:00.000Z");
    const { registry } = await mkRegistry({ now: () => fixedClock });
    const app = await buildApp(registry, "alice@kits.test");
    const resA = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "4.1.0", name: "tie A" }) });
    const resB = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "4.1.1", name: "tie B" }) });
    // Confirm this really is a tie before trusting the tie-break assertion.
    expect(resA.json().publishedAt).toBe(resB.json().publishedAt);

    const [dA, dB] = [resA.json().kitDigest, resB.json().kitDigest].sort();
    const res = await app.inject({ method: "GET", url: "/api/kits" });
    expect(res.json().kits.map((k: { kitDigest: string }) => k.kitDigest)).toEqual([dA, dB]);
    await app.close();
  });

  it("limit/offset paginate; total still reflects the full match count", async () => {
    const { app } = await seedCorpus();
    const page = await app.inject({ method: "GET", url: "/api/kits?limit=1&offset=1" });
    const full = await app.inject({ method: "GET", url: "/api/kits" });
    expect(page.json().total).toBe(3);
    expect(page.json().kits).toHaveLength(1);
    expect(page.json().kits[0].kitDigest).toBe(full.json().kits[1].kitDigest);
    await app.close();
  });

  it("400 on a bad query: limit 0, limit 101, offset -1, unknown param", async () => {
    const { app } = await seedCorpus();
    for (const qs of ["limit=0", "limit=101", "offset=-1", "bogus=1"]) {
      const res = await app.inject({ method: "GET", url: `/api/kits?${qs}` });
      expect(res.statusCode, `expected 400 for ?${qs}`).toBe(400);
    }
    await app.close();
  });
});

// ── Reload ────────────────────────────────────────────────────────────────

describe("reload", () => {
  it("a fresh KitRegistry on the same root lists the same kits in the same order", async () => {
    let clock = new Date("2026-04-01T00:00:00.000Z");
    const rootDir = await mkTempRoot();
    const registry1 = new KitRegistry({ rootDir, durable: () => true, now: () => clock });
    const app1 = await buildApp(registry1, "alice@kits.test");
    for (const v of ["5.0.0", "5.0.1", "5.0.2"]) {
      await app1.inject({ method: "POST", url: "/api/kits", payload: kit({ version: v }) });
      clock = new Date(clock.getTime() + 60_000);
    }
    const before = (await app1.inject({ method: "GET", url: "/api/kits" })).json();

    const registry2 = new KitRegistry({ rootDir, durable: () => true });
    const app2 = await buildApp(registry2, "alice@kits.test");
    const after = (await app2.inject({ method: "GET", url: "/api/kits" })).json();

    expect(after.total).toBe(before.total);
    expect(after.kits.map((k: { kitDigest: string }) => k.kitDigest)).toEqual(
      before.kits.map((k: { kitDigest: string }) => k.kitDigest),
    );

    await app1.close();
    await app2.close();
  });
});

// ── Audit ─────────────────────────────────────────────────────────────────

describe("audit", () => {
  it("writes exactly one kit.published entry per created publish, actor=publisher, resourceId=digest", async () => {
    const audit = vi.fn();
    const { registry } = await mkRegistry({ audit });
    const app = await buildApp(registry, "alice@kits.test");

    const res = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "6.0.0" }) });
    const digest = res.json().kitDigest;

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "kit.published",
        actor: "alice@kits.test",
        resourceType: "capability-kit",
        resourceId: digest,
      }),
    );
    await app.close();
  });

  it("writes kit.forked for a fork", async () => {
    const audit = vi.fn();
    const { registry } = await mkRegistry({ audit });
    const app = await buildApp(registry, "alice@kits.test");

    const parentRes = await app.inject({ method: "POST", url: "/api/kits", payload: kit({ version: "6.1.0" }) });
    const parentDigest = parentRes.json().kitDigest;
    audit.mockClear();

    const forkRes = await app.inject({
      method: "POST",
      url: `/api/kits/${parentDigest}/fork`,
      payload: kit({ version: "6.1.1", parentKitDigest: parentDigest, name: "forked kit" }),
    });
    const forkDigest = forkRes.json().kitDigest;

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "kit.forked",
        actor: "alice@kits.test",
        resourceType: "capability-kit",
        resourceId: forkDigest,
      }),
    );
    await app.close();
  });

  it("writes no audit entry for a re-publish of an existing digest", async () => {
    const audit = vi.fn();
    const { registry } = await mkRegistry({ audit });
    const app = await buildApp(registry, "alice@kits.test");
    const manifest = kit({ version: "6.2.0" });

    await app.inject({ method: "POST", url: "/api/kits", payload: manifest });
    audit.mockClear();
    const res = await app.inject({ method: "POST", url: "/api/kits", payload: manifest });

    expect(res.json().created).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    await app.close();
  });
});
