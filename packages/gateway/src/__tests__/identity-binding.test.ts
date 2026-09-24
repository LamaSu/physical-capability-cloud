/**
 * WP-A fold F3 (operator-ux #2389 -> board N2): identity binding on the
 * unverified email paths.
 *
 * Ownership checks compare a key's operatorId with a resource's recorded owner
 * (shop_kernels.operator_address, a job offer's poster, ...), and those owner
 * ids are public. POST /api/auth/provision {email} and POST
 * /api/contributors/quickstart minted a key for ANY typed email — so anyone
 * could mint a key AS an existing operator and pass that operator's ownership
 * checks. Now an operatorId that is already claimed (an unrevoked key, or a
 * kernel / machine registration / job offer it owns) is refused with 409
 * `identity_claimed`, unless the caller is authenticated AS that operatorId —
 * and then the extra key is no wider than the caller's own. Matching is
 * trimmed + case-insensitive; the refusal never says which resource matched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { contributorRoutes } from "../routes/contributors.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { provisionApiKey, generateApiKey } from "../auth/api-key-auth.js";
import { initJobOffersStore, _resetJobOffersStoreForTests } from "../services/job-offers-store.js";
import { ADMIN_IDENTITY_ALLOWLIST_ENV_VARS } from "../auth/reserved-identities.js";

vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

const QUICKSTART_SCOPES = ["contributor:read", "contributor:write", "schedule:read", "schedule:publish"];

let app: FastifyInstance;
let seq = 0;
/** A fresh, never-used identity per test (the store is shared by the file). */
const fresh = (tag: string) => `${tag}-${Date.now().toString(36)}-${++seq}@x.test`;

beforeAll(async () => {
  for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) delete process.env[name];
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  _resetJobOffersStoreForTests();
  initJobOffersStore({}); // in-memory offers, as in tests / memory-only deploys
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  await app.register(contributorRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  _resetJobOffersStoreForTests();
});

const provision = (email: string, bearer?: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/provision",
    payload: { email },
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

const quickstart = (email: string, bearer?: string) =>
  app.inject({
    method: "POST",
    url: "/api/contributors/quickstart",
    payload: { email, role: "model-author", ratePercent: 1 },
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

/** Active keys stored for an identity, compared case-insensitively. */
function keysOf(id: string): Array<{ operatorId: string; scopes: string[] }> {
  const needle = id.trim().toLowerCase();
  return getRepos()
    .apiKeys.listActive()
    .filter((k) => k.operatorId.trim().toLowerCase() === needle)
    .map((k) => ({ operatorId: k.operatorId, scopes: JSON.parse(k.scopes) as string[] }));
}

function seedKernel(owner: string): void {
  getRepos().kernels.insert({
    id: `kernel-${++seq}`,
    name: "Victim kernel",
    operatorAddress: owner,
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Test St",
    maxAssuranceTier: 2,
    publicKey: "pk",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "1.0.0",
  } as never);
}

function seedRegistration(opts: { tenantId?: string; walletAddress?: string; email?: string }): void {
  getRepos().registrations.insert({
    id: `reg-${++seq}`,
    name: "Victim machine",
    category: "fdm",
    manufacturer: "Acme",
    model: "X",
    photos: [],
    capabilities: [] as never,
    spaceRequirements: {} as never,
    pricing: { baseCost: "0", minimum: "0", currency: "USDC" } as never,
    operator: {
      walletAddress: opts.walletAddress ?? "0x0",
      displayName: "Op",
      certifications: [],
      trainingAcknowledgments: {},
      ...(opts.email ? { email: opts.email } : {}),
    } as never,
    tenantId: opts.tenantId,
    status: "submitted",
    createdAt: new Date().toISOString(),
  });
}

async function seedOffer(poster: string): Promise<void> {
  const { getJobOffersStore } = await import("../services/job-offers-store.js");
  const r = await getJobOffersStore().create({
    capabilityType: "courier.dispatch",
    requirements: {},
    pricing: { amount: 7, currency: "USD", model: "fixed" },
    posterDid: poster,
  });
  expect(r.ok).toBe(true);
}

/** Insert a key row directly (e.g. a legacy wildcard key, which can no longer be minted). */
function seedRawKey(operatorId: string, scopes: string[]): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(scopes),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

describe("F3 — provision {email}: an identity that already exists cannot be claimed", () => {
  it("victim HAS A KEY -> 409 identity_claimed, and nothing is minted", async () => {
    const victim = fresh("victim-key");
    expect((await provision(victim)).statusCode).toBe(201);
    const res = await provision(victim);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("identity_claimed");
    expect(res.json().api_key).toBeUndefined();
    expect(keysOf(victim)).toHaveLength(1);
  });

  it("victim OWNS A KERNEL (no key) -> 409", async () => {
    const victim = fresh("victim-kernel");
    seedKernel(victim);
    const res = await provision(victim);
    expect(res.statusCode).toBe(409);
    expect(keysOf(victim)).toHaveLength(0);
  });

  it("victim OWNS A MACHINE REGISTRATION (tenant or operator.email) -> 409", async () => {
    const byTenant = fresh("victim-reg-tenant");
    seedRegistration({ tenantId: byTenant });
    expect((await provision(byTenant)).statusCode).toBe(409);
    const byEmail = fresh("victim-reg-email");
    seedRegistration({ email: byEmail });
    expect((await provision(byEmail)).statusCode).toBe(409);
  });

  it("victim POSTED A JOB OFFER -> 409", async () => {
    const victim = fresh("victim-offer");
    await seedOffer(victim);
    expect((await provision(victim)).statusCode).toBe(409);
  });

  it("CASE and WHITESPACE variants of a claimed identity -> 409", async () => {
    const victim = fresh("victim-variants");
    expect((await provision(victim)).statusCode).toBe(201);
    for (const variant of [victim.toUpperCase(), `  ${victim}  `, `\t${victim.replace("victim", "VICTIM")}\n`]) {
      const res = await provision(variant);
      expect(res.statusCode, JSON.stringify(variant)).toBe(409);
    }
    expect(keysOf(victim)).toHaveLength(1);
  });

  it("the refusal is IDENTICAL whichever resource matched (reveals nothing)", async () => {
    const a = fresh("which-key");
    const b = fresh("which-kernel");
    const c = fresh("which-offer");
    await provision(a);
    seedKernel(b);
    await seedOffer(c);
    const bodies = await Promise.all([a, b, c].map(async (id) => (await provision(id)).body));
    expect(new Set(bodies).size).toBe(1);
  });

  it("someone ELSE's valid key does not unlock the victim's identity -> 409", async () => {
    const victim = fresh("victim-other");
    await provision(victim);
    const attacker = fresh("attacker");
    const attackerKey = (await provision(attacker)).json().api_key as string;
    const res = await provision(victim, attackerKey);
    expect(res.statusCode).toBe(409);
    expect(keysOf(victim)).toHaveLength(1);
  });

  it("the victim's OWN Bearer -> 201, same operatorId, never wider than the caller's key", async () => {
    const victim = fresh("victim-self");
    const first = await provision(victim);
    const ownKey = first.json().api_key as string;
    const res = await provision(victim.toUpperCase(), ownKey);
    expect(res.statusCode).toBe(201);
    expect(res.json().operator_id).toBe(victim); // canonical stored form, not the variant
    expect(res.json().scopes).toEqual(["operator"]);
    expect(keysOf(victim)).toHaveLength(2);
  });

  // WP-A repair R3. Old assertion: a "*" key may add an ["operator"] key for
  // itself -> 201 ["operator"]. New: 403 insufficient_scope, nothing minted.
  // Why: "*" no longer passes the /api/operator/** write floor, so an
  // ["operator"] key would be WIDER than the caller (e-stop, approvals, policy)
  // — and one call would turn a leaked wildcard key back into that authority.
  it("a legacy wildcard key can NOT mint an [operator] key for itself (\"*\" is not operator-control authority)", async () => {
    const victim = fresh("victim-wild");
    const wildKey = seedRawKey(victim, ["*"]);
    const res = await provision(victim, wildKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
    expect(res.json().api_key).toBeUndefined();
    expect(keysOf(victim)).toHaveLength(1);
    expect(keysOf(victim)[0].scopes).toEqual(["*"]);
  });

  it("an explicit operator scope held alongside \"*\" may still add an [operator] key", async () => {
    const victim = fresh("victim-wild-op");
    const key = seedRawKey(victim, ["*", "operator"]);
    const res = await provision(victim, key);
    expect(res.statusCode).toBe(201);
    expect(res.json().scopes).toEqual(["operator"]);
  });

  it("a key holding none of the minted scopes cannot delegate them -> 403 insufficient_scope", async () => {
    const victim = fresh("victim-narrow");
    const narrowKey = seedRawKey(victim, ["contributor:read"]);
    const res = await provision(victim, narrowKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
    expect(keysOf(victim)).toHaveLength(1);
  });

  it("a FRESH email -> 201 with [\"operator\"] (the normal signup still works)", async () => {
    const res = await provision(fresh("newcomer"));
    expect(res.statusCode).toBe(201);
    expect(res.json().scopes).toEqual(["operator"]);
  });

  it("a fresh email typed with surrounding whitespace is stored trimmed (201)", async () => {
    const id = fresh("spacey");
    const res = await provision(`  ${id} `);
    expect(res.statusCode).toBe(201);
    expect(res.json().operator_id).toBe(id);
  });

  it("only UNREVOKED keys claim an identity (a fully revoked, resource-less id is free again)", async () => {
    const id = fresh("revoked");
    const first = await provision(id);
    getRepos().apiKeys.revoke(first.json().key_id);
    expect((await provision(id)).statusCode).toBe(201);
  });
});

describe("F3 — contributors quickstart: the same binding", () => {
  it("victim HAS A KEY -> 409 before any wallet or key is created", async () => {
    const victim = fresh("qs-victim");
    await provision(victim);
    const res = await quickstart(victim);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("identity_claimed");
    expect(res.json().walletAddress).toBeUndefined();
    expect(keysOf(victim)).toHaveLength(1);
  });

  it("victim OWNS A KERNEL -> 409; whitespace/case variant -> 409", async () => {
    const victim = fresh("qs-kernel");
    seedKernel(victim);
    expect((await quickstart(victim)).statusCode).toBe(409);
    expect((await quickstart(` ${victim.toUpperCase()} `)).statusCode).toBe(409);
  });

  it("the victim's OWN quickstart key -> 201 with the same contributor scopes", async () => {
    const victim = fresh("qs-self");
    const first = await quickstart(victim);
    expect(first.statusCode).toBe(201);
    const res = await quickstart(victim, first.json().apiKey as string);
    expect(res.statusCode).toBe(201);
    const keys = keysOf(victim);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.scopes).toEqual(QUICKSTART_SCOPES);
  });

  it("a legacy wildcard key may still add a contributor key for itself (\"*\" carries contributor scopes)", async () => {
    const victim = fresh("qs-wild");
    const wildKey = seedRawKey(victim, ["*"]);
    const res = await quickstart(victim, wildKey);
    expect(res.statusCode).toBe(201);
    const minted = keysOf(victim).filter((k) => !k.scopes.includes("*"));
    expect(minted).toHaveLength(1);
    expect(minted[0].scopes).toEqual(QUICKSTART_SCOPES);
  });

  it("the victim's OWN [operator] key cannot mint contributor scopes it lacks -> 403", async () => {
    const victim = fresh("qs-operator");
    const opKey = (await provision(victim)).json().api_key as string;
    const res = await quickstart(victim, opKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
  });

  it("a FRESH email -> 201", async () => {
    const res = await quickstart(fresh("qs-new"));
    expect(res.statusCode).toBe(201);
  });
});

describe("F3 — fail closed", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("an unanswerable ownership lookup refuses (409), it does not mint", async () => {
    const reserved = await import("../auth/reserved-identities.js");
    const db = await import("../db.js");
    const spy = vi.spyOn(db, "getStore").mockImplementation(() => {
      throw new Error("db down");
    });
    try {
      expect(reserved.isClaimedIdentity(fresh("anyone"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("provisionApiKey still refuses a wildcard (A6 unchanged)", () => {
    expect(() => provisionApiKey({ operatorId: fresh("w"), scopes: ["*"] })).toThrow();
  });
});
