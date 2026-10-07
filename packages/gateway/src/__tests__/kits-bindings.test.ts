import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "@pcc/store";
import { canonicalize, MAX_AS_OF_SKEW_MS, OperatorBindingDTOSchema } from "@pcc/spec";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { KitRegistry, KitIntegrityError, type KitBindingRecord } from "../services/kit-registry.js";
import { presenceOf, lastSeenAt, availabilityOf, listPriceOf } from "../services/kit-bindings.js";
import { STALE_HEARTBEAT_MS } from "../facades/populators/staleness.js";
import { kitRoutes } from "../routes/kits.js";
import { operatorBindingRoutes } from "../routes/operator-binding.js";

const OWNER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const OTHER = "0x1111111111111111111111111111111111111111";
const CSD = "pcc://capabilities/liquid-handling/v1";
const H = (c: string) => `sha256:${c.repeat(64)}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const body = { csdUrl: CSD, kernelId: "kernel-a", capabilityId: "cap-a" };
const roots: string[] = [];
const apps: FastifyInstance[] = [];
let now: Date;

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  now = new Date();
  initStore({ seed: false });
  kernel("kernel-a", OWNER);
  capability("cap-a", "kernel-a");
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  closeStore();
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function kernel(id: string, operatorAddress = OWNER, overrides: Record<string, unknown> = {}) {
  return getRepos().kernels.insert({
    id, name: id, operatorAddress, location: { lat: 0, lng: 0 }, physicalAddress: "1 Test St",
    maxAssuranceTier: 3, publicKey: "pk", status: "online", registeredAt: now.toISOString(),
    lastHeartbeat: now.toISOString(), version: "1.0.0", ...overrides,
  } as never);
}

function capability(id: string, kernelId: string, overrides: Record<string, unknown> = {}) {
  return getRepos().capabilities.insert({
    id, kernelId, type: "lab.liquid-handling", name: id, materials: [], assuranceTiers: [0, 1, 2, 3],
    pricing: { currency: "USD", baseCost: "25", minimum: "25", perMinute: "0.5" },
    availability: { mode: "always" }, location: { lat: 0, lng: 0 }, ...overrides,
  } as never);
}

async function fixture(options: ConstructorParameters<typeof KitRegistry>[0] = {}, csdUrl = CSD) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-bindings-"));
  roots.push(rootDir);
  const audit = vi.fn();
  const registry = new KitRegistry({ rootDir, durable: () => true, now: () => now, audit, ...options });
  const { kitDigest } = await registry.publish({
    schema: "pcc.capability-kit/v1", name: "Liquid handling kit", version: "1.0.0", parentKitDigest: null,
    capabilities: [{ csdUrl, capabilityContractDigest: H("a") }],
    artifacts: [
      { role: "method", name: "method.py", mediaType: "text/x-python", digest: H("1") },
      { role: "tests", name: "tests.json", mediaType: "application/json", digest: H("2") },
      { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: H("3") },
      { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: H("4") },
    ], economics: { spdxLicense: "Apache-2.0" }, declaredAssuranceTiers: [3],
  }, "publisher@kits.test");
  return { registry, rootDir, kitDigest, audit };
}

async function appFor(registry: KitRegistry, identity: Record<string, string> = { userId: OWNER }) {
  const app = Fastify({ logger: false });
  for (const field of ["userId", "operatorId", "apiKeyId", "provenWallet"]) app.decorateRequest(field, null);
  app.addHook("onRequest", async (req) => Object.assign(req, identity));
  await app.register(kitRoutes, { registry });
  await app.register(operatorBindingRoutes, { registry });
  await app.ready();
  apps.push(app);
  return app;
}

const bind = (app: FastifyInstance, digest: string, payload: unknown = body) =>
  app.inject({ method: "POST", url: `/api/kits/${digest}/bindings`, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
const withdraw = (app: FastifyInstance, digest: string, bindingId: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/kits/${digest}/bindings/${bindingId}/withdraw`,
    ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) }) });
const hosts = (app: FastifyInstance, digest: string, query = "") => app.inject(`/api/kits/${digest}/operators${query}`);
const me = (app: FastifyInstance) => app.inject("/api/operators/me/binding");
function record(kitDigest: string, overrides: Partial<KitBindingRecord> = {}): KitBindingRecord {
  return { schema: "pcc.kit-binding.v0", bindingId: `kb_${randomUUID().replaceAll("-", "")}`, kitDigest,
    csdUrl: CSD, target: { kind: "kernel", kernelId: "kernel-a", capabilityId: "cap-a" },
    identityStatus: "proven", boundBy: hash(OWNER), boundAt: now.toISOString(), ...overrides };
}
function file(root: string, area: string, id: string) { return path.join(root, area, id.slice(3, 5), `${id}.json`); }

// Test-only access to the private raw create: seed historical duplicates and explicit ids
// without applying the production path's tuple idempotency or quota.
function seedBinding(registry: KitRegistry, binding: KitBindingRecord) {
  return registry["createBinding"](binding);
}

describe("kit binding writes", () => {
  it("accepts a manifest CSD longer than the kernel and capability id bounds", async () => {
    const csdUrl = `pcc://capabilities/${"a".repeat(201)}/v1`;
    const f = await fixture({}, csdUrl); const app = await appFor(f.registry);
    expect((await bind(app, f.kitDigest, { ...body, csdUrl })).statusCode).toBe(201);
  });

  it.each([
    [{ userId: OWNER }, "proven"],
    [{ apiKeyId: "key-a", operatorId: OWNER, userId: OTHER }, "self_asserted"],
    [{ apiKeyId: "key-a", operatorId: OTHER, provenWallet: OWNER }, "proven"],
  ] as const)("creates with the recorded identity tier %j", async (identity, status) => {
    const f = await fixture(); const app = await appFor(f.registry, identity);
    const res = await bind(app, f.kitDigest);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: true, binding: { identityStatus: status, boundAt: now.toISOString() } });
    expect(res.json().binding.bindingId).toMatch(/^kb_[0-9a-f]{32}$/);
    expect(res.json().binding).not.toHaveProperty("boundBy");
    const stored = await f.registry.readBinding(res.json().binding.bindingId);
    expect(stored?.binding.boundBy).toBe(hash(OWNER));
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "kit.bound", actor: OWNER,
      resourceType: "kit-binding", resourceId: res.json().binding.bindingId,
      metadata: { kitDigest: f.kitDigest, ...body, identityStatus: status } }));
  });

  it("is idempotent without spending quota", async () => {
    const f = await fixture({ bindDailyLimit: 1 }); const app = await appFor(f.registry);
    const first = await bind(app, f.kitDigest);
    expect(first.statusCode).toBe(201);
    const second = await bind(app, f.kitDigest);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ...first.json(), created: false });
    expect(await fs.readdir(path.join(f.rootDir, "binding-quota", hash(OWNER)))).toEqual(["0.json"]);
    expect(f.audit.mock.calls.filter(([entry]) => entry.eventType === "kit.bound")).toHaveLength(1);
  });

  it("serializes concurrent identical binds without spending a second quota claim", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const responses = await Promise.all([bind(app, f.kitDigest), bind(app, f.kitDigest)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    const results = responses.map((response) => response.json());
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].binding.bindingId).toBe(results[1].binding.bindingId);
    expect(await fs.readdir(path.join(f.rootDir, "binding-quota", hash(OWNER)))).toEqual(["0.json"]);
    expect(f.audit.mock.calls.filter(([entry]) => entry.eventType === "kit.bound")).toHaveLength(1);
    expect((await withdraw(app, f.kitDigest, results[1].binding.bindingId)).statusCode).toBe(200);
    expect((await hosts(app, f.kitDigest)).json()).toMatchObject({ total: 0, hosts: [] });
  });

  it("records the bound kit digest in the quota claim", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    expect((await bind(app, f.kitDigest)).statusCode).toBe(201);
    const claim = JSON.parse(await fs.readFile(path.join(f.rootDir, "binding-quota", hash(OWNER), "0.json"), "utf8"));
    expect(claim.kitDigest).toBe(f.kitDigest);
  });

  it("checks identity before a bad digest and bad body", async () => {
    const f = await fixture(); const app = await appFor(f.registry, {});
    const r = await bind(app, "bad", { payTo: "address" });
    expect(r.statusCode).toBe(401); expect(r.json().error).toBe("authentication_required");
  });
  it("an API key with an empty operatorId has no identity", async () => {
    const f = await fixture(); const app = await appFor(f.registry, { apiKeyId: "key", operatorId: "", userId: OWNER });
    expect((await bind(app, f.kitDigest)).statusCode).toBe(401);
  });
  it("checks digest before body, and body before kit existence", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const badDigest = await bind(app, "bad", {});
    expect(badDigest.statusCode).toBe(400); expect(badDigest.json().error).toBe("invalid_digest");
    const badBody = await bind(app, H("f"), {});
    expect(badBody.statusCode).toBe(400); expect(badBody.json().error).toBe("invalid_body");
    const absent = await bind(app, H("f"));
    expect(absent.statusCode).toBe(404); expect(absent.json().error).toBe("kit_not_found");
  });
  it.each(["payTo", "payoutAddress", "operatorId", "pricing", "availability"])("refuses an unknown body key %s", async (key) => {
    const f = await fixture(); const app = await appFor(f.registry);
    const r = await bind(app, f.kitDigest, { ...body, [key]: "value" });
    expect(r.statusCode).toBe(400); expect(r.json().error).toBe("invalid_body");
  });
  it.each([{}, null, [], { ...body, kernelId: "" }, { ...body, capabilityId: "a".repeat(201) }])("refuses malformed bodies %j", async (payload) => {
    const f = await fixture(); const app = await appFor(f.registry);
    const r = await bind(app, f.kitDigest, payload);
    expect(r.statusCode).toBe(400); expect(r.json().error).toBe("invalid_body");
  });
  it("checks CSD, kernel, owner, and capability in order", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const cases = [
      [{ ...body, csdUrl: "pcc://capabilities/other/v1", kernelId: "missing" }, 422, "csd_not_in_kit"],
      [{ ...body, kernelId: "missing", capabilityId: "missing" }, 404, "kernel_not_found"],
      [{ ...body, kernelId: "kernel-other", capabilityId: "missing" }, 403, "not_kernel_owner"],
      [{ ...body, capabilityId: "missing" }, 422, "capability_not_on_kernel"],
      [{ ...body, capabilityId: "cap-other" }, 422, "capability_not_on_kernel"],
    ] as const;
    kernel("kernel-other", OTHER); capability("cap-other", "kernel-other");
    for (const [payload, status, code] of cases) {
      const r = await bind(app, f.kitDigest, payload);
      expect(r.statusCode).toBe(status); expect(r.json().error).toBe(code);
    }
  });
  it("enforces rolling bind quota and frees a slot older than 24 hours", async () => {
    const f = await fixture({ bindDailyLimit: 1 }); const app = await appFor(f.registry);
    expect((await bind(app, f.kitDigest)).statusCode).toBe(201);
    capability("cap-second", "kernel-a");
    const denied = await bind(app, f.kitDigest, { ...body, capabilityId: "cap-second" });
    expect(denied.statusCode).toBe(429); expect(denied.json().error).toBe("bind_quota");
    now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect((await bind(app, f.kitDigest, { ...body, capabilityId: "cap-second" })).statusCode).toBe(201);
  });
  it("uses PCC_KIT_BIND_DAILY_LIMIT", async () => {
    vi.stubEnv("PCC_KIT_BIND_DAILY_LIMIT", "0");
    const f = await fixture(); const app = await appFor(f.registry);
    const r = await bind(app, f.kitDigest);
    expect(r.statusCode).toBe(429); expect(r.json().error).toBe("bind_quota");
  });
  it("refuses writes in production without a durable configured root", async () => {
    const f = await fixture();
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PCC_KIT_REGISTRY_DIR", ""); vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
    const registry = new KitRegistry({ rootDir: f.rootDir }); const app = await appFor(registry);
    const r = await bind(app, f.kitDigest);
    expect(r.statusCode).toBe(503); expect(r.json().error).toBe("registry_not_durable");
  });
});

describe("withdrawal", () => {
  it("requires identity and the current owner, and is idempotent", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const id = (await bind(app, f.kitDigest)).json().binding.bindingId;
    const anonymous = await appFor(f.registry, {});
    expect((await withdraw(anonymous, f.kitDigest, id)).statusCode).toBe(401);
    const other = await appFor(f.registry, { userId: OTHER });
    expect((await withdraw(other, f.kitDigest, id)).statusCode).toBe(403);
    getRepos().kernels.update("kernel-a", { operatorAddress: OTHER });
    const denied = await withdraw(app, f.kitDigest, id);
    expect(denied.statusCode).toBe(403); expect(denied.json().error).toBe("not_kernel_owner");
    const first = await withdraw(other, f.kitDigest, id, {});
    expect(first.statusCode).toBe(200); expect(first.json()).toEqual({ bindingId: id, withdrawnAt: now.toISOString(), created: true });
    now = new Date(now.getTime() + 1000);
    expect((await withdraw(other, f.kitDigest, id)).json()).toEqual({ ...first.json(), created: false });
    expect((await f.registry.readBinding(id))?.withdrawal).toMatchObject({ withdrawnBy: hash(OTHER), identityStatus: "proven" });
    expect(f.audit.mock.calls.filter(([e]) => e.eventType === "kit.unbound")).toHaveLength(1);
  });
  it("returns binding_not_found for an absent binding or digest mismatch", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const id = (await bind(app, f.kitDigest)).json().binding.bindingId;
    for (const [digest, bindingId] of [[H("f"), id], [f.kitDigest, `kb_${"0".repeat(32)}`], [f.kitDigest, "bad"]]) {
      const r = await withdraw(app, digest, bindingId);
      expect(r.statusCode).toBe(404); expect(r.json().error).toBe("binding_not_found");
    }
  });
  it("refuses a missing current kernel", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const r = record(f.kitDigest, { target: { kind: "kernel", kernelId: "missing", capabilityId: "missing" } });
    await seedBinding(f.registry, r);
    const res = await withdraw(app, f.kitDigest, r.bindingId);
    expect(res.statusCode).toBe(403); expect(res.json().error).toBe("not_kernel_owner");
  });
  it.each([{ payTo: "wallet" }, [], "body", null])("requires an empty body %j", async (payload) => {
    const f = await fixture(); const app = await appFor(f.registry);
    const id = (await bind(app, f.kitDigest)).json().binding.bindingId;
    expect((await withdraw(app, f.kitDigest, id, payload)).statusCode).toBe(400);
  });
  it("removes withdrawn capacity from both views and creates a fresh id on rebind", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const id = (await bind(app, f.kitDigest)).json().binding.bindingId;
    expect((await me(app)).json().bindings).toHaveLength(1);
    await withdraw(app, f.kitDigest, id);
    expect((await hosts(app, f.kitDigest)).json()).toMatchObject({ total: 0, hosts: [] });
    expect((await me(app)).json().bindings).toEqual([]);
    expect((await me(app)).json().unmappedCapacity).toHaveLength(1);
    const rebound = await bind(app, f.kitDigest);
    expect(rebound.statusCode).toBe(201); expect(rebound.json().binding.bindingId).not.toBe(id);
  });
});

describe("presence and public summaries", () => {
  it.each(["offline", "maintenance", "suspended", "expired"])("reports status %s offline", (status) => {
    expect(presenceOf({ status, lastHeartbeat: now.toISOString() }, {}, now)).toBe("offline");
  });
  it("uses the heartbeat threshold, future skew and expiries", () => {
    const k = { status: "online", lastHeartbeat: now.toISOString() };
    expect(presenceOf(k, {}, now)).toBe("online");
    expect(presenceOf({ ...k, lastHeartbeat: new Date(now.getTime() - STALE_HEARTBEAT_MS).toISOString() }, {}, now)).toBe("online");
    expect(presenceOf({ ...k, lastHeartbeat: new Date(now.getTime() - STALE_HEARTBEAT_MS - 1).toISOString() }, {}, now)).toBe("unknown");
    for (const lastHeartbeat of [undefined, "", "bad", new Date(now.getTime() + MAX_AS_OF_SKEW_MS + 1).toISOString()]) {
      expect(presenceOf({ ...k, lastHeartbeat }, {}, now)).toBe("unknown");
      expect(lastSeenAt({ lastHeartbeat }, now)).toBeNull();
    }
    expect(presenceOf({ ...k, status: "new-status" }, {}, now)).toBe("unknown");
    expect(presenceOf({ ...k, validUntil: new Date(now.getTime() - 1).toISOString() }, {}, now)).toBe("offline");
    expect(presenceOf(k, { validUntil: new Date(now.getTime() - 1).toISOString() }, now)).toBe("offline");
    expect(lastSeenAt({ lastHeartbeat: "2026-01-01T01:00:00+01:00" }, now)).toBe("2026-01-01T00:00:00.000Z");
  });
  it("projects only valid summary availability from objects or JSON strings", () => {
    for (const availability of [{ mode: "always", agentEndpoint: "https://agent.test", payTo: OWNER }, JSON.stringify({ mode: "always", agentEndpoint: "https://agent.test" })]) {
      expect(availabilityOf({ availability })).toEqual({ mode: "always" });
    }
    for (const availability of [{ mode: "delegate-to-agent" }, { mode: "bad" }, "bad", [], { mode: "always", describe: "https://agent.test" }, { mode: "windows", windows: [{ start: "09:00", end: "17:00", agentEndpoint: "https://agent.test" }] }]) {
      expect(availabilityOf({ availability })).toBeNull();
    }
  });
  it("returns only recorded string prices without defaults or coercion", () => {
    const pricing = { currency: "USDC", baseCost: "0.123456", minimum: "1", perGram: "9999999999999999.999999" };
    expect(listPriceOf({ pricing })).toEqual({ basis: "capability_record", ...pricing });
    for (const invalid of [{ ...pricing, baseCost: 1 }, { ...pricing, minimum: "01" }, { ...pricing, baseCost: "1.0000000" }, { ...pricing, perMinute: "-1" }, { ...pricing, currency: "usd" }, { currency: "USD", baseCost: "1" }, { ...pricing, perCm3: "10000000000000000" }, null]) {
      expect(listPriceOf({ pricing: invalid })).toBeNull();
    }
  });
});

describe("kit hosts", () => {
  it("returns safe hosts, filters, deduplicates, sorts and pages", async () => {
    const f = await fixture(); const app = await appFor(f.registry, {});
    const ids = ["kb_" + "1".repeat(32), "kb_" + "2".repeat(32), "kb_" + "3".repeat(32), "kb_" + "4".repeat(32)];
    for (const [i, status, heartbeat] of [[0, "online", now.toISOString()], [1, "online", new Date(now.getTime() - STALE_HEARTBEAT_MS - 1).toISOString()], [2, "online", ""], [3, "offline", now.toISOString()]] as const) {
      kernel(`host-${i}`, OWNER, { status, lastHeartbeat: heartbeat });
      capability(`host-cap-${i}`, `host-${i}`, { availability: { mode: "always", agentEndpoint: "https://agent.test" } });
      await seedBinding(f.registry, record(f.kitDigest, { bindingId: ids[i], target: { kind: "kernel", kernelId: `host-${i}`, capabilityId: `host-cap-${i}` } }));
    }
    await seedBinding(f.registry, record(f.kitDigest, { bindingId: "kb_" + "a".repeat(32), target: { kind: "kernel", kernelId: "host-0", capabilityId: "host-cap-0" }, boundAt: new Date(now.getTime() + 1).toISOString() }));
    const response = (await hosts(app, f.kitDigest)).json();
    expect(response).toMatchObject({ kitDigest: f.kitDigest, asOf: now.toISOString(), total: 4 });
    expect(response.hosts.map((h: { bindingId: string }) => h.bindingId)).toEqual(ids);
    expect(response.hosts.map((h: { presence: string }) => h.presence)).toEqual(["online", "unknown", "unknown", "offline"]);
    for (const host of response.hosts) {
      expect(host.assuranceTierCap).toBe(0); expect(host.availability).toEqual({ mode: "always" });
      expect(host.listPrice).toMatchObject({ basis: "capability_record", currency: "USD", baseCost: "25" });
    }
    const serialized = JSON.stringify(response);
    for (const secret of [OWNER, hash(OWNER), "boundBy", "operatorAddress", "operatorId", "principal", "agentEndpoint"]) expect(serialized).not.toContain(secret);
    expect((await hosts(app, f.kitDigest, "?presence=online")).json()).toMatchObject({ total: 1, hosts: [{ bindingId: ids[0] }] });
    expect((await hosts(app, f.kitDigest, "?limit=1&offset=2")).json()).toMatchObject({ total: 4, hosts: [{ bindingId: ids[2] }] });
  });
  it("breaks boundAt and lastSeenAt ties by bindingId", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    const low = record(f.kitDigest, { bindingId: "kb_" + "0".repeat(32) });
    await seedBinding(f.registry, record(f.kitDigest, { bindingId: "kb_" + "f".repeat(32) }));
    await seedBinding(f.registry, low);
    capability("cap-b", "kernel-a");
    await seedBinding(f.registry, record(f.kitDigest, { bindingId: "kb_" + "1".repeat(32), target: { kind: "kernel", kernelId: "kernel-a", capabilityId: "cap-b" } }));
    expect((await hosts(app, f.kitDigest)).json().hosts.map((h: { bindingId: string }) => h.bindingId)).toEqual([low.bindingId, "kb_" + "1".repeat(32)]);
    expect((await me(app)).json().bindings).toHaveLength(2);
  });
  it("sorts lastSeenAt descending within each presence", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    for (const [id, age] of [["a", 2000], ["b", 1000]] as const) {
      kernel(id, OWNER, { lastHeartbeat: new Date(now.getTime() - age).toISOString() }); capability(id, id);
      await seedBinding(f.registry, record(f.kitDigest, { target: { kind: "kernel", kernelId: id, capabilityId: id } }));
    }
    expect((await hosts(app, f.kitDigest)).json().hosts.map((h: { kernelId: string }) => h.kernelId)).toEqual(["b", "a"]);
  });
  it("omits absent and moved targets from both views", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    for (const [kernelId, capabilityId] of [["missing", "cap-a"], ["kernel-a", "missing"], ["kernel-a", "cap-moved"]]) {
      await seedBinding(f.registry, record(f.kitDigest, { target: { kind: "kernel", kernelId, capabilityId } }));
    }
    kernel("kernel-b"); capability("cap-moved", "kernel-b");
    expect((await hosts(app, f.kitDigest)).json().hosts).toEqual([]);
    expect((await me(app)).json().bindings).toEqual([]);
  });
  it("projects far-future heartbeat as unknown with lastSeenAt null", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    await bind(app, f.kitDigest);
    getRepos().kernels.update("kernel-a", { lastHeartbeat: new Date(now.getTime() + MAX_AS_OF_SKEW_MS + 1).toISOString() });
    expect((await hosts(app, f.kitDigest)).json().hosts[0]).toMatchObject({ presence: "unknown", lastSeenAt: null });
  });
  it.each(["?presence=bad", "?limit=0", "?limit=101", "?limit=1.5", "?limit=", "?offset=-1", "?offset=10001", "?offset=1.1", "?offset=", "?limit=1e1", "?unknown=x"])("refuses query %s", async (query) => {
    const f = await fixture(); const app = await appFor(f.registry);
    const r = await hosts(app, f.kitDigest, query);
    expect(r.statusCode).toBe(400); expect(r.json().error).toBe("invalid_query");
  });
  it("returns 404 for an absent kit", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    expect((await hosts(app, H("f"))).statusCode).toBe(404);
  });
});

describe("operator binding projection", () => {
  it.each([
    ["empty", ""],
    ["overlong", "x".repeat(121)],
  ])("omits an unbound capability with an %s type from the DTO", async (_label, type) => {
    const f = await fixture(); const app = await appFor(f.registry);
    capability("invalid-type", "kernel-a", { type });
    const r = await me(app);
    expect(r.statusCode).toBe(200);
    expect(r.json().unmappedCapacity).toEqual([{ kind: "kernel", id: "kernel-a", legacyType: "lab.liquid-handling" }]);
    expect(OperatorBindingDTOSchema.safeParse(r.json()).success).toBe(true);
  });

  it("validates the DTO and derives claim rights and unbound capacity", async () => {
    const f = await fixture(); const app = await appFor(f.registry, { apiKeyId: "key", operatorId: OWNER });
    capability("unbound", "kernel-a"); kernel("someone-else", OTHER); capability("other-cap", "someone-else");
    await bind(app, f.kitDigest);
    const r = await me(app); expect(r.statusCode).toBe(200);
    expect(OperatorBindingDTOSchema.safeParse(r.json()).success).toBe(true);
    expect(r.json()).toMatchObject({ principal: { operatorId: OWNER, identityStatus: "self_asserted" }, executorKinds: ["machine"],
      moneyAuthority: "none", payee: null, executionAuthority: { canClaimCapabilityTypes: [CSD] },
      unmappedCapacity: [{ kind: "kernel", id: "kernel-a", legacyType: "lab.liquid-handling" }],
      bindings: [{ kind: "kernel", id: "kernel-a", capabilityType: CSD, kitDigest: f.kitDigest, assuranceTierCap: 0 }] });
  });
  it("returns empty arrays for a caller with no kernels", async () => {
    const f = await fixture(); const app = await appFor(f.registry, { userId: OTHER });
    const r = await me(app); expect(OperatorBindingDTOSchema.safeParse(r.json()).success).toBe(true);
    expect(r.json()).toMatchObject({ executorKinds: [], bindings: [], unmappedCapacity: [], executionAuthority: { canClaimCapabilityTypes: [] } });
  });
  it("requires identity", async () => {
    const f = await fixture(); const app = await appFor(f.registry, {});
    const r = await me(app); expect(r.statusCode).toBe(401); expect(r.json().error).toBe("authentication_required");
  });
  it("caps unmapped capacity at 500", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    for (let i = 0; i < 501; i++) capability(`unmapped-${i}`, "kernel-a");
    const r = await me(app); expect(r.statusCode).toBe(200); expect(r.json().unmappedCapacity).toHaveLength(500);
  });
  it("fails invalid projections with only the error code", async () => {
    const f = await fixture(); const app = await appFor(f.registry);
    now = new Date(Date.now() + MAX_AS_OF_SKEW_MS + 60_000);
    const r = await me(app); expect(r.statusCode).toBe(500); expect(r.json()).toEqual({ error: "binding_projection_invalid" });
  });
  it("bind and withdrawal leave financial and availability records unchanged", async () => {
    const f = await fixture(); const repos = getRepos();
    repos.apiKeys.insert({ id: "key-a", keyHash: "hash", keyPrefix: "pcc_", operatorId: OWNER, scopes: '["operator"]', rateLimit: "100", createdAt: now.toISOString() });
    const policy = JSON.stringify({ mode: "manual", pricingRules: { multiplier: "2" } });
    getStore().db.run(sql`INSERT INTO operator_policies (kernel_id, policy, updated_at, updated_by) VALUES ('kernel-a', ${policy}, ${now.toISOString()}, ${OWNER})`);
    const beforeKey = repos.apiKeys.findById("key-a"); const beforeCap = repos.capabilities.findById("cap-a");
    const beforePolicy = getStore().db.get(sql`SELECT * FROM operator_policies WHERE kernel_id = 'kernel-a'`);
    const app = await appFor(f.registry, { apiKeyId: "key-a", operatorId: OWNER });
    const id = (await bind(app, f.kitDigest)).json().binding.bindingId;
    expect((await withdraw(app, f.kitDigest, id)).statusCode).toBe(200);
    expect(repos.apiKeys.findById("key-a")).toEqual(beforeKey);
    expect(repos.capabilities.findById("cap-a")).toEqual(beforeCap);
    expect(getStore().db.get(sql`SELECT * FROM operator_policies WHERE kernel_id = 'kernel-a'`)).toEqual(beforePolicy);
  });
});

describe("binding file integrity and append-only storage", () => {
  it("keeps kit listing skips separate from binding scan skips", async () => {
    const f = await fixture(); const r = record(f.kitDigest);
    await seedBinding(f.registry, r);
    await fs.appendFile(path.join(f.rootDir, "publications", f.kitDigest.slice(7, 9), `${f.kitDigest.slice(7)}.json`), "\n");
    await fs.appendFile(file(f.rootDir, "bindings", r.bindingId), "\n");
    expect((await f.registry.list()).kits).toEqual([]);
    expect(f.registry.skipped).toEqual([f.kitDigest]);
    expect(await f.registry.listBindings()).toEqual([]);
    expect(f.registry.skipped).toEqual([f.kitDigest]);
    expect(f.registry.skippedBindings).toEqual([r.bindingId]);
  });

  it("refuses a second create of the same bindingId", async () => {
    const f = await fixture(); const r = record(f.kitDigest);
    await seedBinding(f.registry, r);
    await expect(seedBinding(f.registry, r)).rejects.toMatchObject({ status: 409, code: "binding_exists" });
    expect((await f.registry.readBinding(r.bindingId))?.binding).toEqual(r);
  });
  it.each(["noncanonical", "wrong-id", "invalid-utf8", "unknown-key", "bom"])("skips and reports a corrupt record: %s", async (corruption) => {
    const f = await fixture(); const r = record(f.kitDigest); await seedBinding(f.registry, r);
    const text = corruption === "noncanonical" ? JSON.stringify(r, null, 2) : corruption === "wrong-id" ? canonicalize({ ...r, bindingId: `kb_${"0".repeat(32)}` }) : corruption === "unknown-key" ? canonicalize({ ...r, payTo: OWNER }) : corruption === "bom" ? `\uFEFF${canonicalize(r)}` : Buffer.from([0xff]);
    await fs.writeFile(file(f.rootDir, "bindings", r.bindingId), text);
    expect(await f.registry.listBindings()).toEqual([]); expect(f.registry.skippedBindings).toContain(r.bindingId);
    await expect(f.registry.readBinding(r.bindingId)).rejects.toBeInstanceOf(KitIntegrityError);
    const app = await appFor(f.registry); const res = await withdraw(app, f.kitDigest, r.bindingId);
    expect(res.statusCode).toBe(500); expect(res.json().error).toBe("kit_integrity_failure");
  });
  it("verifies withdrawal records on scans and individual reads", async () => {
    const f = await fixture(); const r = record(f.kitDigest); await seedBinding(f.registry, r);
    await f.registry.withdrawBinding({ bindingId: r.bindingId, identityStatus: "proven", withdrawnBy: hash(OWNER) });
    await fs.appendFile(file(f.rootDir, "binding-withdrawals", r.bindingId), "\n");
    expect(await f.registry.listBindings()).toEqual([]); expect(f.registry.skippedBindings).toContain(r.bindingId);
    await expect(f.registry.readBinding(r.bindingId)).rejects.toBeInstanceOf(KitIntegrityError);
  });
  it("reads fresh records and filters by kit digest and kernel ids", async () => {
    const f = await fixture(); const second = new KitRegistry({ rootDir: f.rootDir, durable: () => true });
    expect(await second.listBindings()).toEqual([]);
    const r = record(f.kitDigest); await seedBinding(f.registry, r);
    expect(await second.listBindings({ kitDigest: f.kitDigest, kernelIds: ["kernel-a"] })).toEqual([{ binding: r, withdrawal: null }]);
    expect(await second.listBindings({ kitDigest: H("f") })).toEqual([]);
    expect(await second.listBindings({ kernelIds: [] })).toEqual([]);
  });
  it("refuses a symlinked bindings directory", async () => {
    const f = await fixture(); const outside = await fs.mkdtemp(path.join(os.tmpdir(), "kit-bindings-outside-")); roots.push(outside);
    await fs.symlink(outside, path.join(f.rootDir, "bindings"));
    await expect(seedBinding(f.registry, record(f.kitDigest))).rejects.toBeInstanceOf(KitIntegrityError);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("applies durability and filesystem guards to every binding write", async () => {
    const f = await fixture(); const r = record(f.kitDigest);
    await seedBinding(f.registry, r);
    const guarded = new KitRegistry({ rootDir: f.rootDir, durable: () => false });
    await expect(seedBinding(guarded, record(f.kitDigest))).rejects.toMatchObject({ status: 503 });
    await expect(guarded.createBindingIfAbsent(record(f.kitDigest, { csdUrl: "pcc://capabilities/other/v1" }), OWNER, now)).rejects.toMatchObject({ status: 503 });
    await expect(guarded.withdrawBinding({ bindingId: r.bindingId, identityStatus: "proven", withdrawnBy: hash(OWNER) })).rejects.toMatchObject({ status: 503 });
    const unsupported = new KitRegistry({ rootDir: f.rootDir, durable: () => true, noFollowFlag: 0 });
    await expect(seedBinding(unsupported, record(f.kitDigest))).rejects.toMatchObject({ status: 503 });
    await expect(unsupported.createBindingIfAbsent(record(f.kitDigest, { csdUrl: "pcc://capabilities/other/v1" }), OWNER, now)).rejects.toMatchObject({ status: 503 });
    await expect(unsupported.withdrawBinding({ bindingId: r.bindingId, identityStatus: "proven", withdrawnBy: hash(OWNER) })).rejects.toMatchObject({ status: 503 });
  });
});
