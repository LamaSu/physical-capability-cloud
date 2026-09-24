/**
 * WP-C (MUST-CLOSE 5) negative tests: an independently authorized assurance
 * ceiling, with owner-only heartbeat / announce / capability heartbeat, and an
 * admin-only marketplace verify.
 *
 * Driven end-to-end over HTTP through the REAL apiGate and real API keys, so
 * each identity is what production resolves (`operatorId ?? userId`). The
 * file deliberately imports none of the new WP-C modules. It exercises the
 * routes only, so it can run unchanged against the pre-change code to prove
 * polarity (every case marked [neg] fails there).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { buildEd25519RegistrationProof } from "@pcc/kernel-sdk";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { operatorStatusRoutes } from "../routes/operator-status.js";
import {
  kernelMarketplaceRoutes,
  _clearKernelRegistry,
  _setSmokeTestFetch,
} from "../routes/kernel-marketplace.js";
import { composeRoutes, _clearComposeForTests } from "../routes/compose.js";
import { _clearGraphSearchForTests } from "../routes/graph-search.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { getCapabilityFacade, getKernelFacade } from "../facades/index.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let ownerKey: string;
let attackerKey: string;
const OWNER = "wpc-operator-owner";
const ATTACKER = "wpc-operator-attacker";

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const asAttacker = () => ({ authorization: `Bearer ${attackerKey}` });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/** A fresh Ed25519 proof-of-possession for `kernelId` (what kernel-sdk sends). */
function ed25519Proof(kernelId: string) {
  const kp = nacl.sign.keyPair();
  return buildEd25519RegistrationProof(kernelId, {
    algorithm: "ed25519",
    privateKey: kp.secretKey,
    expectedPublicKey: Buffer.from(kp.publicKey).toString("hex"),
  });
}

/** Register a kernel as the owner; optionally with a proven signing key. */
async function registerKernel(
  id: string,
  extra: Record<string, unknown> = {},
  opts: { signed?: boolean } = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id, name: `Kernel ${id}`, ...(opts.signed ? ed25519Proof(id) : {}), ...extra },
  });
  return res;
}

/** Insert a raw (legacy-style) kernel row, bypassing every write path. */
function insertKernelRow(id: string, fields: Record<string, unknown> = {}) {
  getRepos().kernels.insert({
    id,
    name: `Row ${id}`,
    operatorAddress: OWNER,
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 3,
    publicKey: `0x${"00".repeat(32)}`,
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "0.1.0",
    ...fields,
  } as never);
}

/** Insert a raw (legacy-style) capability row claiming `tiers`. */
function insertCapabilityRow(id: string, kernelId: string, type: string, tiers: number[]) {
  getRepos().capabilities.insert({
    id,
    kernelId,
    type,
    name: `${type} on ${kernelId}`,
    description: "",
    materials: [],
    assuranceTiers: tiers,
    pricing: { currency: "USDC", baseCost: "10", minimum: "10" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
}

/** A trusted track record: ceiling 3 when the kernel also has a proven signer. */
const TRUSTED = {
  signingKeyAlgorithm: "secp256k1",
  signingAddress: "0x1234567890abcdef1234567890abcdef12345678",
  reputation: 900,
  totalJobsCompleted: 50,
};
/** Proven signer but a fresh record: ceiling 1. */
const SIGNED_FRESH = {
  signingKeyAlgorithm: "secp256k1",
  signingAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  reputation: 0,
  totalJobsCompleted: 0,
};

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  attackerKey = provisionApiKey({ operatorId: ATTACKER, scopes: ["operator"] }).rawKey;
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(capabilityRoutes);
  await app.register(operatorRelayRoutes);
  await app.register(operatorStatusRoutes);
  await app.register(kernelMarketplaceRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

// ── C1: register validates the claim; the DTO serves the ceiling ────────────

describe("WP-C register: the tier is a validated claim, served capped", () => {
  it("[neg] tier-3 claim with NO proven signer -> DTO shows 0", async () => {
    const id = uid("wpc-unsigned");
    const res = await registerKernel(id, { maxAssuranceTier: 3 });
    expect(res.statusCode).toBe(201);
    expect(res.json().kernel.maxAssuranceTier).toBe(0);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}`, headers: asOwner() });
    expect(get.json().kernel.maxAssuranceTier).toBe(0);
    const list = await app.inject({ method: "GET", url: "/api/kernels" });
    const row = list.json().kernels.find((k: { id: string }) => k.id === id);
    expect(row.maxAssuranceTier).toBe(0);
  });

  it("[neg] tier-3 claim WITH a proven signer but fresh reputation -> DTO <= 1", async () => {
    const id = uid("wpc-signed-fresh");
    const res = await registerKernel(id, { maxAssuranceTier: 3 }, { signed: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().kernel.signingKey?.algorithm).toBe("ed25519");
    expect(res.json().kernel.maxAssuranceTier).toBeLessThanOrEqual(1);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}`, headers: asOwner() });
    expect(get.json().kernel.maxAssuranceTier).toBeLessThanOrEqual(1);
  });

  it.each([
    ["5", 5],
    ["2.5", 2.5],
    ['"3" (string)', "3"],
  ])("[neg] invalid tier %s on CREATE -> 400, nothing stored", async (_label, tier) => {
    const id = uid("wpc-bad-create");
    const res = await registerKernel(id, { maxAssuranceTier: tier });
    expect(res.statusCode).toBe(400);
    expect(getRepos().kernels.findById(id)).toBeFalsy();
  });

  it.each([
    ["5", 5],
    ["2.5", 2.5],
    ['"3" (string)', "3"],
  ])("[neg] invalid tier %s on UPDATE -> 400, stored claim unchanged", async (_label, tier) => {
    const id = uid("wpc-bad-update");
    expect((await registerKernel(id, { maxAssuranceTier: 1 })).statusCode).toBe(201);
    const res = await registerKernel(id, { maxAssuranceTier: tier });
    expect(res.statusCode).toBe(400);
    expect(getRepos().kernels.findById(id)?.maxAssuranceTier).toBe(1);
  });
});

// ── C1: heartbeat is owner-only; inserted tiers are clamped ─────────────────

describe("WP-C heartbeat: owner-only, clamped", () => {
  it("[neg] non-owner heartbeat -> 403, no capability rows, status unchanged", async () => {
    const id = uid("wpc-hb-victim");
    expect((await registerKernel(id)).statusCode).toBe(201);
    const oldBeat = "2026-01-01T00:00:00.000Z";
    getRepos().kernels.update(id, { status: "offline", lastHeartbeat: oldBeat } as never);

    for (const url of [`/api/kernels/${id}/heartbeat`, "/api/operator/heartbeat"]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: asAttacker(),
        payload: {
          kernelId: id,
          status: "online",
          capabilities: [{ type: "wpc-injected", assuranceTiers: [3], pricing: { currency: "USDC", baseCost: "0", minimum: "0" } }],
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_kernel_owner");
    }

    expect(getRepos().capabilities.findById(`cap-${id}-wpc-injected`)).toBeFalsy();
    const row = getRepos().kernels.findById(id)!;
    expect(row.status).toBe("offline");
    expect(row.lastHeartbeat).toBe(oldBeat);
  });

  it("[neg] heartbeat for an UNKNOWN kernel -> 404 and inserts nothing", async () => {
    const id = uid("wpc-hb-ghost");
    const res = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/heartbeat`,
      headers: asOwner(),
      payload: { capabilities: [{ type: "ghost", assuranceTiers: [0] }] },
    });
    expect(res.statusCode).toBe(404);
    expect(getRepos().capabilities.findById(`cap-${id}-ghost`)).toBeFalsy();
  });

  it("[neg] heartbeat on a legacy UNOWNED placeholder kernel -> 403 not_kernel_owner (claim via register first)", async () => {
    const id = uid("wpc-hb-legacy");
    insertKernelRow(id, { operatorAddress: "0x0000000000000000000000000000000000000000" });
    const res = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/heartbeat`,
      headers: asOwner(),
      payload: { status: "online" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] owner heartbeat on an UNSIGNED kernel with tiers [0,1,2,3] -> stored and served [0]", async () => {
    const id = uid("wpc-hb-unsigned");
    expect((await registerKernel(id)).statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/heartbeat`,
      headers: asOwner(),
      payload: { capabilities: [{ type: "wpc-print", assuranceTiers: [0, 1, 2, 3] }] },
    });
    expect(res.statusCode).toBe(200);
    const capId = `cap-${id}-wpc-print`;
    expect(getRepos().capabilities.findById(capId)?.assuranceTiers).toEqual([0]);
    const served = await app.inject({ method: "GET", url: `/api/capabilities/${capId}` });
    expect(served.statusCode).toBe(200);
    expect(served.json().assuranceTiers ?? served.json().capability?.assuranceTiers).toEqual([0]);
  });

  it("[neg] owner heartbeat on a SIGNED fresh kernel -> tiers clamped to its ceiling (1), invalid values dropped", async () => {
    const id = uid("wpc-hb-signed");
    expect((await registerKernel(id, {}, { signed: true })).statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/heartbeat",
      headers: asOwner(),
      payload: { kernelId: id, capabilities: [{ type: "wpc-mill", assuranceTiers: [3, "2", 1, 0, 9] }] },
    });
    expect(res.statusCode).toBe(200);
    expect(getRepos().capabilities.findById(`cap-${id}-wpc-mill`)?.assuranceTiers).toEqual([1, 0]);
  });

  it("[neg] per-capability heartbeat by a NON-owner -> 403, TTL untouched", async () => {
    const id = uid("wpc-caphb");
    expect((await registerKernel(id)).statusCode).toBe(201);
    const capId = `cap-${id}-wpc-scan`;
    insertCapabilityRow(capId, id, "wpc-scan", [0]);
    const before = getRepos().capabilities.findById(capId)!;

    const res = await app.inject({
      method: "POST",
      url: `/api/capabilities/${capId}/heartbeat`,
      headers: asAttacker(),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const after = getRepos().capabilities.findById(capId)!;
    expect(after.validUntil ?? null).toBe(before.validUntil ?? null);
    expect(after.lastHeartbeatAt ?? null).toBe(before.lastHeartbeatAt ?? null);

    // The owner can still refresh it (positive control).
    const ok = await app.inject({
      method: "POST",
      url: `/api/capabilities/${capId}/heartbeat`,
      headers: asOwner(),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
  });
});

// ── C1: announce is owner-only and never writes tiers ───────────────────────

describe("WP-C announce: owner-only stub", () => {
  it("[neg] announce by a NON-owner -> 403", async () => {
    const id = uid("wpc-ann");
    expect((await registerKernel(id)).statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/capabilities`,
      headers: asAttacker(),
      payload: { capabilities: [{ type: "x", assuranceTiers: [3] }], devices: ["d1"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("owner announce claiming tier 3 -> effective tier unchanged, no capability rows (regression guard)", async () => {
    const id = uid("wpc-ann-owner");
    expect((await registerKernel(id, { maxAssuranceTier: 1 }, { signed: true })).statusCode).toBe(201);
    const before = (await app.inject({ method: "GET", url: `/api/kernels/${id}`, headers: asOwner() })).json()
      .kernel.maxAssuranceTier;

    const res = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/capabilities`,
      headers: asOwner(),
      payload: { maxAssuranceTier: 3, capabilities: [{ type: "wpc-ann-cap", assuranceTiers: [3] }] },
    });
    expect(res.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: `/api/kernels/${id}`, headers: asOwner() })).json()
      .kernel.maxAssuranceTier;
    expect(after).toBe(before);
    expect(getRepos().kernels.findById(id)?.maxAssuranceTier).toBe(1);
    expect(getRepos().capabilities.findById(`cap-${id}-wpc-ann-cap`)).toBeFalsy();
  });
});

// ── Extra (beyond the WP-C item list): POST /api/capabilities is owner-only ──
// apiGate lists "/api/capabilities" in PUBLIC_EXACT with no method guard, so a
// POST reaches the handler unauthenticated. Without an owner check anyone can
// list priced capabilities under someone else's kernel and inherit that
// kernel's ceiling. That is the catalog injection the heartbeat fix closes.

describe("WP-C (extra) capability publish: owner-only", () => {
  it("[neg] UNAUTHENTICATED POST /api/capabilities -> 401, nothing inserted", async () => {
    const id = uid("wpc-pub-victim");
    expect((await registerKernel(id)).statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      payload: { kernelId: id, type: "wpc-evil", id: `cap-${id}-evil`, assuranceTiers: [3] },
    });
    expect(res.statusCode).toBe(401);
    expect(getRepos().capabilities.findById(`cap-${id}-evil`)).toBeFalsy();
  });

  it("[neg] NON-owner POST /api/capabilities -> 403, nothing inserted", async () => {
    const id = uid("wpc-pub-victim2");
    expect((await registerKernel(id)).statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asAttacker(),
      payload: { kernelId: id, type: "wpc-evil", id: `cap-${id}-evil`, assuranceTiers: [3] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(getRepos().capabilities.findById(`cap-${id}-evil`)).toBeFalsy();
  });

  it("[neg] POST /api/capabilities for an UNKNOWN kernel -> 404, no orphan listing", async () => {
    const id = uid("wpc-pub-ghost");
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asOwner(),
      payload: { kernelId: id, type: "wpc-ghost", id: `cap-${id}-ghost` },
    });
    expect(res.statusCode).toBe(404);
    expect(getRepos().capabilities.findById(`cap-${id}-ghost`)).toBeFalsy();
  });

  it("the OWNER can publish; the served tiers are clamped to the kernel's ceiling", async () => {
    const id = uid("wpc-pub-owner");
    expect((await registerKernel(id)).statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asOwner(),
      payload: { kernelId: id, type: "wpc-legit", id: `cap-${id}-legit`, assuranceTiers: [0, 1, 2, 3] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().capability.assuranceTiers).toEqual([0]);
  });
});

// ── C2: reads / search / selection use the clamped tiers ────────────────────

describe("WP-C reads: tiers are served clamped to the owning kernel's ceiling", () => {
  it("[neg] search for assuranceTier 2 skips kernels whose ceiling is below 2, even when the row claims [0,1,2]", async () => {
    const type = uid("wpc-search-type");
    const trusted = uid("wpc-k-trusted");
    const fresh = uid("wpc-k-fresh");
    const unsigned = uid("wpc-k-unsigned");
    insertKernelRow(trusted, TRUSTED);
    insertKernelRow(fresh, SIGNED_FRESH);
    insertKernelRow(unsigned, { reputation: 950, totalJobsCompleted: 127 });
    for (const k of [trusted, fresh, unsigned]) insertCapabilityRow(`cap-${k}`, k, type, [0, 1, 2]);

    const res = await getCapabilityFacade().search({ type, assuranceTier: 2 }, {}, { limit: 50 });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.items.map((c) => c.kernelId)).toEqual([trusted]);

    // Tier 1 admits the fresh signer but still not the unsigned kernel.
    const t1 = await getCapabilityFacade().search({ type, assuranceTier: 1 }, {}, { limit: 50 });
    expect(t1.success && t1.data.items.map((c) => c.kernelId).sort()).toEqual([fresh, trusted].sort());
  });

  it("[neg] a LEGACY capability row is served clamped on every read surface", async () => {
    const kernelId = uid("wpc-legacy-k");
    insertKernelRow(kernelId, { reputation: 950, totalJobsCompleted: 127 }); // no signer -> ceiling 0
    const capId = `cap-${kernelId}-legacy`;
    insertCapabilityRow(capId, kernelId, uid("wpc-legacy-type"), [0, 1, 2, 3]);

    const detail = (await app.inject({ method: "GET", url: `/api/capabilities/${capId}` })).json();
    expect(detail.assuranceTiers ?? detail.capability?.assuranceTiers).toEqual([0]);

    const byKernel = (
      await app.inject({ method: "GET", url: `/api/capabilities/by-kernel/${kernelId}`, headers: asOwner() })
    ).json();
    expect(byKernel.capabilities.map((c: { assuranceTiers: number[] }) => c.assuranceTiers)).toEqual([[0]]);

    const td = (await app.inject({ method: "GET", url: `/api/capabilities/${capId}/td` })).json();
    expect(td["pcc:assuranceTiers"]).toEqual([0]);

    const status = (
      await app.inject({ method: "GET", url: `/api/operators/${OWNER}/status`, headers: asOwner() })
    ).json();
    const mine = status.capabilities.find((c: { id: string }) => c.id === capId);
    expect(mine.assuranceTiers).toEqual([0]);
  });

  it("[neg] the kernel list serves the capped tier for a legacy row claiming 3", async () => {
    const kernelId = uid("wpc-legacy-kernel");
    insertKernelRow(kernelId, { maxAssuranceTier: 3, reputation: 950, totalJobsCompleted: 127 });
    const list = await app.inject({ method: "GET", url: "/api/kernels" });
    const row = list.json().kernels.find((k: { id: string }) => k.id === kernelId);
    expect(row.maxAssuranceTier).toBe(0);
  });
});

describe("WP-C compose: selection uses the clamped tiers", () => {
  let composeApp: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_COMPOSE_USE_FACADE = "true";
    _clearComposeForTests();
    _clearGraphSearchForTests();
    composeApp = Fastify({ logger: false });
    await composeApp.register(composeRoutes);
    await composeApp.ready();
  });

  afterEach(async () => {
    delete process.env.PCC_COMPOSE_USE_FACADE;
    _clearComposeForTests();
    await composeApp.close();
  });

  async function seed(kernelId: string, type: string, signed: boolean) {
    const k = await getKernelFacade().register(
      { id: kernelId, name: kernelId, maxAssuranceTier: 3, ...(signed ? ed25519Proof(kernelId) : {}) },
      OWNER,
    );
    expect(k.success).toBe(true);
    const c = await getCapabilityFacade().create({
      id: `cap-${kernelId}`,
      kernelId,
      type,
      pricing: { currency: "USDC", baseCost: "5", minimum: "5" },
      assuranceTiers: [0, 1, 2, 3],
    });
    expect(c.success).toBe(true);
  }

  it("[neg] an UNSIGNED kernel claiming [0..3] is not selected at minAssuranceTier 1", async () => {
    const type = uid("wpc-compose-type");
    await seed(uid("wpc-compose-unsigned"), type, false);
    const res = await composeApp.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: type, budgetUSD: 100, minAssuranceTier: 1 },
    });
    expect(res.json().status).toBe("no_path_found");
  });

  it("a SIGNED fresh kernel is selectable at its ceiling (1) but not above it", async () => {
    const type = uid("wpc-compose-type");
    const kernelId = uid("wpc-compose-signed");
    await seed(kernelId, type, true);
    const t1 = (
      await composeApp.inject({
        method: "POST",
        url: "/api/compose",
        payload: { outcomeType: type, budgetUSD: 100, minAssuranceTier: 1 },
      })
    ).json();
    expect(t1.status).toBe("proposed");
    expect(t1.steps[0].kernelId).toBe(kernelId);
    expect(t1.steps[0].assuranceTier).toBe(1);

    const t2 = (
      await composeApp.inject({
        method: "POST",
        url: "/api/compose",
        payload: { outcomeType: type, budgetUSD: 100, minAssuranceTier: 2 },
      })
    ).json();
    expect(t2.status).toBe("no_path_found");
  });
});

// ── C1: marketplace verify / suspend are admin-only ─────────────────────────

// Admin authorization is the shared WP-A helper (auth/admin-key.ts):
// 401 admin_key_required (header missing), 403 admin_key_invalid (wrong key),
// 503 admin_key_unconfigured (no PCC_ADMIN_KEY outside NODE_ENV test/development).
// Every refusal leaves the manifest pending.
describe("WP-C marketplace: no self-verification, constant-time admin key", () => {
  const savedEnv = { admin: process.env.PCC_ADMIN_KEY, node: process.env.NODE_ENV };

  function manifest(kernelId: string, builderAgentId = "eip155:84532:0x1234567890abcdef1234567890abcdef12345678") {
    return {
      manifestVersion: "1.0.0",
      kernelId,
      name: "WPC digital kernel",
      description: "test",
      builder: { agentId: builderAgentId },
      capabilityType: "wpc-digital",
      workflowSteps: [{ stepId: "s", stepType: "transform", description: "d", dependsOn: [] }],
      pricing: { currency: "USDC", baseUSD: 1 },
      maxAssuranceTier: 3,
      endpointURL: "https://kernel.wpc.example/run",
      sessionKeyPolicy: { maxTTLSeconds: 60, allowedActions: ["evidence_submit"] },
    };
  }

  async function registerManifest(kernelId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels/register",
      headers: asAttacker(),
      payload: { manifest: manifest(kernelId) },
    });
    expect(res.statusCode).toBe(201);
  }

  async function statusOf(kernelId: string): Promise<string> {
    const res = await app.inject({
      method: "GET",
      url: `/api/kernels/marketplace/${kernelId}`,
      headers: asAttacker(),
    });
    return res.json().kernel.status;
  }

  beforeEach(() => {
    _clearKernelRegistry();
    _setSmokeTestFetch(async () => new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    _setSmokeTestFetch(null);
    if (savedEnv.admin === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = savedEnv.admin;
    if (savedEnv.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv.node;
  });

  it("[neg] spoofed X-Agent-Id, NO admin key configured, NODE_ENV=production -> 503 (fail closed), stays pending", async () => {
    const id = uid("wpc-mkt-prod");
    await registerManifest(id);
    delete process.env.PCC_ADMIN_KEY;
    process.env.NODE_ENV = "production";
    const res = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/verify`,
      headers: { ...asAttacker(), "x-agent-id": manifest(id).builder.agentId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("admin_key_unconfigured");
    expect(await statusOf(id)).toBe("pending");
  });

  it("[neg] spoofed X-Agent-Id with an admin key configured but not sent -> 401, stays pending", async () => {
    const id = uid("wpc-mkt-spoof");
    await registerManifest(id);
    process.env.PCC_ADMIN_KEY = "wpc-admin-secret";
    process.env.NODE_ENV = "production";
    const res = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/verify`,
      headers: { ...asAttacker(), "x-agent-id": manifest(id).builder.agentId },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("admin_key_required");
    expect(await statusOf(id)).toBe("pending");
  });

  it("[neg] no admin key configured and NODE_ENV UNSET -> verify and suspend fail closed (503)", async () => {
    const id = uid("wpc-mkt-unset");
    await registerManifest(id);
    delete process.env.PCC_ADMIN_KEY;
    delete process.env.NODE_ENV;
    const verify = await app.inject({ method: "POST", url: `/api/kernels/${id}/verify`, headers: asAttacker() });
    expect(verify.statusCode).toBe(503);
    const suspend = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/suspend`,
      headers: asAttacker(),
      payload: { reason: "x" },
    });
    expect(suspend.statusCode).toBe(503);
    expect(await statusOf(id)).toBe("pending");
  });

  // Contract, not polarity: the pre-change code also refused a wrong key (401).
  it("wrong admin key (same and different length) -> 403 on verify and suspend; the right key -> 200 verified", async () => {
    const id = uid("wpc-mkt-key");
    await registerManifest(id);
    process.env.PCC_ADMIN_KEY = "wpc-admin-secret";
    process.env.NODE_ENV = "production";
    for (const wrong of ["wpc-admin-secreT", "short", "wpc-admin-secret-and-more"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/kernels/${id}/verify`,
        headers: { ...asAttacker(), "x-admin-key": wrong },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("admin_key_invalid");
      const suspend = await app.inject({
        method: "POST",
        url: `/api/kernels/${id}/suspend`,
        headers: { ...asAttacker(), "x-admin-key": wrong },
        payload: { reason: "x" },
      });
      expect(suspend.statusCode).toBe(403);
      expect(await statusOf(id)).toBe("pending");
    }
    const ok = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/verify`,
      headers: { ...asAttacker(), "x-admin-key": "wpc-admin-secret" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("verified");
  });

  it("[neg] a verified self-declared tier-3 manifest is served at tier 0 without an authorized kernel", async () => {
    const id = uid("wpc-mkt-tier");
    await registerManifest(id);
    process.env.PCC_ADMIN_KEY = "wpc-admin-secret";
    const ok = await app.inject({
      method: "POST",
      url: `/api/kernels/${id}/verify`,
      headers: { ...asAttacker(), "x-admin-key": "wpc-admin-secret" },
    });
    expect(ok.statusCode).toBe(200);
    const list = (
      await app.inject({ method: "GET", url: "/api/kernels/marketplace?minAssuranceTier=1", headers: asAttacker() })
    ).json();
    expect(list.kernels.map((k: { kernelId: string }) => k.kernelId)).not.toContain(id);
    const single = (
      await app.inject({ method: "GET", url: `/api/kernels/marketplace/${id}`, headers: asAttacker() })
    ).json();
    expect(single.kernel.maxAssuranceTier).toBe(0);
  });
});
