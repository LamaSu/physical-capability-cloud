import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { kitRoutes } from "../routes/kits.js";
import { provisionRoutes } from "../routes/provision.js";
import * as kitRegistry from "../services/kit-registry.js";
import { KitIntegrityError, KitRegistry, type KitListFilter } from "../services/kit-registry.js";

const publisher = "k1b-publisher@example.com";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const completeKit = () => ({
  schema: "pcc.capability-kit/v1",
  name: "OT-2 dye serial dilution",
  version: "1.0.0",
  parentKitDigest: null,
  capabilities: [{ csdUrl: "pcc://capabilities/liquid-handling/v1", capabilityContractDigest: digest("a") }],
  artifacts: [
    { role: "method", name: "serial-dilution.py", mediaType: "text/x-python", digest: digest("1") },
    { role: "tests", name: "checks.json", mediaType: "application/json", digest: digest("5") },
    { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: digest("6") },
    { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: digest("7") },
  ],
  economics: { spdxLicense: "Apache-2.0" },
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "kits-k1b-"));
  roots.push(root);
  return root;
}

function onRoot(rootDir: string, now?: () => Date): KitRegistry {
  return new KitRegistry({ rootDir, now, durable: () => true, audit: () => undefined });
}

function fileFor(root: string, area: "manifests" | "publications", kitDigest: string): string {
  const hex = kitDigest.slice("sha256:".length);
  return path.join(root, area, hex.slice(0, 2), `${hex}.json`);
}

// The index and verification count are deliberately inspected for the K1b performance/privacy contract.
function verificationSpy() {
  return vi.spyOn(KitRegistry.prototype as unknown as { readVerified: (digest: string) => Promise<unknown> }, "readVerified");
}

async function seeded(count = 1, now?: () => Date) {
  const root = await tempRoot();
  const registry = onRoot(root, now);
  const digests: string[] = [];
  for (let i = 0; i < count; i++) {
    digests.push((await registry.publish({ ...completeKit(), version: `1.0.${i}` }, publisher)).kitDigest);
  }
  await registry.list();
  return { root, registry, digests };
}

async function flipByte(file: string): Promise<void> {
  const bytes = await fs.readFile(file);
  bytes[10] = bytes[10]! ^ 1;
  await fs.writeFile(file, bytes);
}

describe("K1b public reads through the real gate and scope checker", () => {
  let app: FastifyInstance;
  let registry: KitRegistry;
  let kitDigest: string;

  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", ":memory:");
    for (const name of ["PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
      vi.stubEnv(name, "");
      delete process.env[name];
    }
    initStore({ seed: true });
    sc.__resetScopeCacheForTests();
    registry = onRoot(await tempRoot());
    kitDigest = (await registry.publish(completeKit(), publisher)).kitDigest;
    app = Fastify();
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(apiGate);
    await app.register(sc.scopeChecker);
    await app.register(provisionRoutes);
    await app.register(kitRoutes, { registry });
    app.get("/api/kits/:digest/anything", async () => ({ reached: true }));
    app.put("/api/kits/:digest", async () => ({ reached: true }));
    app.delete("/api/kits/:digest", async () => ({ reached: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    closeStore();
    sc.__resetScopeCacheForTests();
    vi.unstubAllEnvs();
  });

  it("P1: anonymous listing returns the published kit", async () => {
    const response = await app.inject({ method: "GET", url: "/api/kits" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, kits: [{ kitDigest, name: completeKit().name }] });
  });

  it("P1 HEAD: anonymous listing follows GET with an empty body", async () => {
    const response = await app.inject({ method: "HEAD", url: "/api/kits" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
  });

  it("P2: anonymous search combines name and csdUrl filters and enforces query bounds", async () => {
    const query = new URLSearchParams({ q: "DYE", csdUrl: completeKit().capabilities[0]!.csdUrl });
    const found = await app.inject({ method: "GET", url: `/api/kits?${query}` });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ total: 1, kits: [{ kitDigest }] });
    const absent = await app.inject({ method: "GET", url: "/api/kits?q=no-such-kit" });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ total: 0, kits: [] });
    const invalid = await app.inject({ method: "GET", url: "/api/kits?limit=0" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_query");
  });

  it("P3: anonymous detail verifies a kit, rejects malformed digests and returns 404 for absent ones", async () => {
    const response = await app.inject({ method: "GET", url: `/api/kits/${kitDigest}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kit: await registry.get(kitDigest) });
    const absent = await app.inject({ method: "GET", url: `/api/kits/${digest("0")}` });
    expect(absent.statusCode).toBe(404);
    expect(absent.json().error).toBe("not_found");
    const invalid = await app.inject({ method: "GET", url: "/api/kits/abc" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_digest");
  });

  it("P3 HEAD: anonymous detail follows GET with an empty body", async () => {
    const response = await app.inject({ method: "HEAD", url: `/api/kits/${kitDigest}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
  });

  it("P4: anonymous publish and fork are refused by apiGate without changing the registry", async () => {
    for (const url of ["/api/kits", `/api/kits/${kitDigest}/fork`]) {
      const response = await app.inject({ method: "POST", url, payload: completeKit() });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error, url).toBe("api_key_required");
      expect((await registry.list()).total).toBe(1);
    }
  });

  it("P5: deeper GET paths stay authenticated and never reach the stand-in", async () => {
    const response = await app.inject({ method: "GET", url: `/api/kits/${kitDigest}/anything` });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("api_key_required");
    expect(response.json()).not.toHaveProperty("reached");
  });

  it("P6: PUT and DELETE stay authenticated and never reach the stand-ins", async () => {
    for (const method of ["PUT", "DELETE"] as const) {
      const response = await app.inject({ method, url: `/api/kits/${kitDigest}` });
      expect(response.statusCode, method).toBe(401);
      expect(response.json().error, method).toBe("api_key_required");
      expect(response.json()).not.toHaveProperty("reached");
    }
  });

  it("P7: no P1-P3 body or header reveals the publisher to anonymous or operator:basic callers", async () => {
    const provision = await app.inject({ method: "POST", url: "/api/auth/provision", payload: { email: "kit-basic-operator@example.com" } });
    expect(provision.statusCode).toBe(201);
    expect(provision.json().scopes).toEqual(["operator:basic"]);
    const cases = [
      { method: "GET", url: "/api/kits" },
      { method: "HEAD", url: "/api/kits" },
      { method: "GET", url: `/api/kits?${new URLSearchParams({ q: "DYE", csdUrl: completeKit().capabilities[0]!.csdUrl })}` },
      { method: "GET", url: "/api/kits?q=no-such-kit" },
      { method: "GET", url: "/api/kits?limit=0" },
      { method: "GET", url: `/api/kits/${kitDigest}` },
      { method: "HEAD", url: `/api/kits/${kitDigest}` },
      { method: "GET", url: `/api/kits/${digest("0")}` },
      { method: "GET", url: "/api/kits/abc" },
    ] as const;
    for (const rawKey of [null, provision.json().api_key as string]) {
      for (const request of cases) {
        const response = await app.inject({ ...request, headers: rawKey ? { authorization: `Bearer ${rawKey}` } : {} });
        expect(response.body, `${request.method} ${request.url}`).not.toContain(publisher);
        expect(JSON.stringify(response.headers)).not.toContain(publisher);
      }
    }
  });
});

describe("K1b verified listing index on real files", () => {
  it("I1: a warm registry sees another process's next publication", async () => {
    const { root, registry, digests } = await seeded();
    const second = await onRoot(root).publish({ ...completeKit(), version: "2.0.0" }, publisher);
    expect((await registry.list()).kits.map((kit) => kit.kitDigest).sort()).toEqual([...digests, second.kitDigest].sort());
  });

  it("I2: a missing manifest is skipped; a missing publication is absent without being skipped", async () => {
    const { root, registry, digests } = await seeded(2);
    await fs.unlink(fileFor(root, "manifests", digests[0]!));
    expect((await registry.list()).kits.map((kit) => kit.kitDigest)).toEqual([digests[1]]);
    expect(registry.skipped).toContain(digests[0]);
    await fs.unlink(fileFor(root, "publications", digests[1]!));
    expect(await registry.list()).toEqual({ kits: [], total: 0 });
    expect(registry.skipped).toContain(digests[0]);
    expect(registry.skipped).not.toContain(digests[1]);
  });

  it("I3 part 1: a same-size corrupt rewrite evicts a warm kit and get still verifies", async () => {
    const { root, registry, digests } = await seeded();
    await delay(50);
    await flipByte(fileFor(root, "manifests", digests[0]!));
    expect(await registry.list()).toEqual({ kits: [], total: 0 });
    expect(registry.skipped).toContain(digests[0]);
    await expect(registry.get(digests[0]!)).rejects.toBeInstanceOf(KitIntegrityError);
    const spy = verificationSpy();
    expect(await registry.list()).toEqual({ kits: [], total: 0 });
    expect(spy).toHaveBeenCalledWith(digests[0]);
  });

  it("I3 part 2: ctime detects a same-size corrupt rewrite even with restored atime and mtime", async () => {
    const { root, registry, digests } = await seeded();
    const file = fileFor(root, "manifests", digests[0]!);
    // Set an exactly representable mtime before warming, so utimes restores it without rounding drift.
    const time = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(file, time, time);
    await registry.list();
    const before = await fs.stat(file);
    await delay(50);
    await flipByte(file);
    await fs.utimes(file, before.atime, before.mtime);
    const after = await fs.stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    expect(await registry.list()).toEqual({ kits: [], total: 0 });
    expect(registry.skipped).toContain(digests[0]);
  });

  it("I4: a publication symlink evicts a warm kit", async () => {
    const { root, registry, digests } = await seeded();
    const file = fileFor(root, "publications", digests[0]!);
    const copy = path.join(root, "publication-copy.json");
    await fs.copyFile(file, copy);
    await fs.unlink(file);
    await fs.symlink(copy, file);
    expect(await registry.list()).toEqual({ kits: [], total: 0 });
    expect(registry.skipped).toContain(digests[0]);
  });

  it("I4 C1: a symlinked manifests shard evicts a warm kit even when file fingerprints are unchanged", async () => {
    const { root, registry, digests } = await seeded();
    const shard = path.dirname(fileFor(root, "manifests", digests[0]!));
    const moved = path.join(root, "moved-manifests-shard");
    await fs.rename(shard, moved);
    await fs.symlink(moved, shard);
    expect(await registry.list()).toEqual({ kits: [], total: 0 });
    expect(registry.skipped).toContain(digests[0]);
    await expect(registry.get(digests[0]!)).rejects.toBeInstanceOf(KitIntegrityError);
  });

  it("I5: unchanged kits are reused and only a changed manifest is verified", async () => {
    const { root, registry, digests } = await seeded(3);
    const spy = verificationSpy();
    await registry.list();
    expect(spy).toHaveBeenCalledTimes(0);
    const file = fileFor(root, "manifests", digests[1]!);
    await delay(50);
    await fs.writeFile(file, await fs.readFile(file));
    await registry.list();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(digests[1]);
  });

  it("I6: indexed values hold no publisher or publication record", async () => {
    const { registry } = await seeded(2);
    const listed = (registry as unknown as { listed: Map<string, unknown> }).listed;
    expect(listed).toBeInstanceOf(Map);
    expect(listed.size).toBe(2);
    for (const value of listed.values()) {
      const json = JSON.stringify(value);
      expect(json).not.toContain(publisher);
      expect(json).not.toContain('"record"');
    }
  });

  it("I7: the injected clock forces a full pass at exactly ten minutes", async () => {
    let clock = new Date("2026-11-07T00:00:00.000Z");
    const start = clock.getTime();
    const { registry } = await seeded(2, () => clock);
    // Namespace lookup lets this new test reproduce against the unchanged source without an import error.
    const interval = Reflect.get(kitRegistry, "KIT_LIST_FULL_PASS_MS") as number;
    expect(interval).toBe(10 * 60 * 1000);
    const spy = verificationSpy();
    clock = new Date(start + interval - 1);
    await registry.list();
    expect(spy).toHaveBeenCalledTimes(0);
    clock = new Date(start + interval);
    await registry.list();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("I8: both file fingerprints precede opening the changed manifest", async () => {
    const { root, registry, digests } = await seeded();
    const manifest = fileFor(root, "manifests", digests[0]!);
    const publication = fileFor(root, "publications", digests[0]!);
    await delay(50);
    await fs.writeFile(manifest, await fs.readFile(manifest));
    const order: string[] = [];
    const lstat = fs.lstat;
    const open = fs.open;
    vi.spyOn(fs, "lstat").mockImplementation((...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === publication || String(args[0]) === manifest) order.push(`lstat:${String(args[0])}`);
      return lstat(...args);
    });
    vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === manifest) order.push("open:manifest");
      return open(...args);
    });
    await registry.list();
    const pubAt = order.indexOf(`lstat:${publication}`);
    const manifestAt = order.indexOf(`lstat:${manifest}`);
    const openAt = order.indexOf("open:manifest");
    expect(pubAt).toBeGreaterThanOrEqual(0);
    expect(manifestAt).toBeGreaterThan(pubAt);
    expect(openAt).toBeGreaterThan(manifestAt);
  });

  it("I9: warm filters, ties, ordering, totals and pagination equal a fresh registry", async () => {
    let clock = new Date("2026-02-01T00:00:00.000Z");
    const root = await tempRoot();
    const registry = onRoot(root, () => clock);
    const specs = [
      { name: "Liquid handling basics", family: "opentrons-ot2", iface: "opentrons", csd: "liquid-handling" },
      { name: "CNC milling starter", family: "shapeoko-pro", iface: "generic-http", csd: "cnc-milling" },
      { name: "Liquid handling advanced", family: "hamilton-star", iface: "hamilton", csd: "liquid-handling" },
    ];
    for (const [i, spec] of specs.entries()) {
      await registry.publish({
        ...completeKit(), name: spec.name, version: `4.0.${i}`,
        capabilities: [{ csdUrl: `pcc://capabilities/${spec.csd}/v1`, capabilityContractDigest: digest("a") }],
        compatibility: { deviceFamilies: [spec.family], interfaces: [spec.iface] },
      }, publisher);
      clock = new Date(clock.getTime() + 60_000);
    }
    const tieA = await registry.publish({ ...completeKit(), name: "tie A", version: "4.1.0" }, publisher);
    const tieB = await registry.publish({ ...completeKit(), name: "tie B", version: "4.1.1" }, publisher);
    expect(tieA.publishedAt).toBe(tieB.publishedAt);
    await registry.publish({ ...completeKit(), name: "zzz", description: "Supports PIPETTE calibration", version: "4.2.0" }, publisher);
    await registry.list();
    const filters: KitListFilter[] = [
      {}, { csdUrl: "pcc://capabilities/liquid-handling/v1" }, { deviceFamily: "hamilton-star" },
      { interface: "generic-http" }, { q: "LIQUID" }, { q: "pipette" }, { q: "tie" },
      { limit: 1 }, { limit: 1, offset: 1 }, { offset: 2 }, { q: "absent" },
    ];
    for (const filter of filters) {
      expect(await registry.list(filter), JSON.stringify(filter)).toEqual(await onRoot(root).list(filter));
    }
    expect((await registry.list({ q: "tie" })).kits.map((kit) => kit.kitDigest)).toEqual([tieA.kitDigest, tieB.kitDigest].sort());
  });

  it("I10: changing a returned summary cannot change the index", async () => {
    const { registry } = await seeded();
    const expected = structuredClone(await registry.list());
    const returned = await registry.list();
    returned.kits[0]!.csdUrls.push("pcc://caller-injected");
    returned.kits[0]!.name = "caller-injected";
    expect(await registry.list()).toEqual(expected);
  });
});
