/**
 * WP-C R1 (review round 2, HIGH): /api/compose and graph-search clamp at
 * SEARCH time.
 *
 * Before R1, graph-search filtered, ranked and returned each node at the tier
 * its registrant claimed, and the default compose provider did the same for its
 * candidate pool. /api/compose falls back to graph-search whenever its direct
 * provider finds nothing, and always for `outcomeChain`, so a kernel with an
 * authorized ceiling of 0 could be proposed at tier 3 even in facade mode
 * (reviewer probes P5 and P7). Any key could also register such a node or
 * candidate for ANY kernel through the `_dev/*` endpoints.
 *
 * Driven over HTTP through the REAL apiGate and real API keys. The file imports
 * only modules that exist on the pre-R1 code (plus a test fixture), so it runs
 * unchanged against the pre-R1 graph-search.ts / compose.ts to prove polarity:
 * every [neg] case fails there.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { buildEd25519RegistrationProof } from "@pcc/kernel-sdk";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { composeRoutes, _clearComposeForTests } from "../routes/compose.js";
import {
  graphSearchRoutes,
  _clearGraphSearchForTests,
  _seedGraphSearchForTests,
} from "../routes/graph-search.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, initStore } from "../db.js";
import {
  ensureKernelRow,
  TRUSTED_KERNEL_FIELDS,
} from "./fixtures/authorized-kernels.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

let app: FastifyInstance;
/** The same routes with NO apiGate: the handlers must refuse on their own. */
let bare: FastifyInstance;
let ownerKey: string;
let attackerKey: string;
const OWNER = "r1-search-owner";
const ATTACKER = "r1-search-attacker";

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const asAttacker = () => ({ authorization: `Bearer ${attackerKey}` });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/** Register a kernel as OWNER through the real write path (optionally signed: ceiling 1). */
async function ownedKernel(prefix: string, opts: { signed?: boolean } = {}): Promise<string> {
  const id = uid(prefix);
  let proof = {};
  if (opts.signed) {
    const kp = nacl.sign.keyPair();
    proof = buildEd25519RegistrationProof(id, {
      algorithm: "ed25519",
      privateKey: kp.secretKey,
      expectedPublicKey: Buffer.from(kp.publicKey).toString("hex"),
    });
  }
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id, name: `R1 ${id}`, maxAssuranceTier: 3, ...proof },
  });
  expect(res.statusCode).toBe(201);
  return id;
}

/** A kernel row owned by OWNER with the maximum authorized ceiling (3). */
function trustedKernel(prefix: string): string {
  const id = uid(prefix);
  ensureKernelRow(id, { operatorAddress: OWNER, ...TRUSTED_KERNEL_FIELDS });
  return id;
}

function nodeBody(kernelId: string, type: string, over: Record<string, unknown> = {}) {
  return {
    capabilityId: uid("r1-node"),
    capabilityType: type,
    kernelId,
    estimatedPriceUSD: 10,
    estimatedDurationMs: 1_000,
    assuranceTier: 3,
    reputation: 500,
    outputTypes: [type],
    ...over,
  };
}

function candidateBody(kernelId: string, type: string, over: Record<string, unknown> = {}) {
  return {
    capabilityId: uid("r1-cand"),
    kernelId,
    operatorAddress: OWNER,
    capabilityType: type,
    estimatedPriceUSD: 10,
    estimatedDurationMs: 1_000,
    assuranceTier: 3,
    ...over,
  };
}

async function registerNode(body: Record<string, unknown>, headers = asOwner(), on = app) {
  return on.inject({
    method: "POST",
    url: "/api/capabilities/graph/_dev/register-node",
    headers,
    payload: body,
  });
}

async function registerCandidate(body: Record<string, unknown>, headers = asOwner(), on = app) {
  return on.inject({
    method: "POST",
    url: "/api/compose/_dev/register-candidate",
    headers,
    payload: body,
  });
}

async function graphSearch(outcomeType: string, minAssuranceTier: number, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/capabilities/graph-search",
    payload: { outcomeType, budgetUSD: 1_000, minAssuranceTier, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    options: Array<{
      minAssuranceTier: number;
      steps: Array<{ capabilityId: string; kernelId: string; assuranceTier: number }>;
    }>;
  };
}

async function compose(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/compose",
    headers: asOwner(),
    payload: { budgetUSD: 1_000, ...payload },
  });
  return res.json() as {
    status: string;
    effectiveAssuranceTier: number;
    steps: Array<{ kernelId: string; capabilityId: string; assuranceTier: number; operatorAddress: string }>;
  };
}

/** Run `fn` with the facade provider on or off, restoring the flag after. */
async function withProvider(facade: boolean, fn: () => Promise<void>) {
  const saved = process.env.PCC_COMPOSE_USE_FACADE;
  if (facade) process.env.PCC_COMPOSE_USE_FACADE = "true";
  else delete process.env.PCC_COMPOSE_USE_FACADE;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.PCC_COMPOSE_USE_FACADE;
    else process.env.PCC_COMPOSE_USE_FACADE = saved;
  }
}

beforeAll(async () => {
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  attackerKey = provisionApiKey({ operatorId: ATTACKER, scopes: ["operator"] }).rawKey;
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(capabilityRoutes);
  await app.register(composeRoutes);
  await app.register(graphSearchRoutes);
  await app.ready();

  bare = Fastify({ logger: false });
  await bare.register(composeRoutes);
  await bare.register(graphSearchRoutes);
  await bare.ready();
});

afterAll(async () => {
  await app.close();
  await bare.close();
  closeStore();
});

beforeEach(() => {
  _clearComposeForTests();
  _clearGraphSearchForTests();
});

// ── graph-search: served tier = min(claim, kernel ceiling) ──────────────────

describe("R1 graph-search serves each node at min(claimed tier, its kernel's ceiling)", () => {
  it("[neg] a node claiming 3 on an UNSIGNED kernel is not returned at minAssuranceTier 1, and is served at 0", async () => {
    const kernelId = await ownedKernel("r1-gs-unsigned");
    const type = uid("r1-gs-type");
    expect((await registerNode(nodeBody(kernelId, type))).statusCode).toBe(201);

    for (const tier of [1, 2, 3]) {
      expect((await graphSearch(type, tier)).options).toEqual([]);
    }
    const t0 = await graphSearch(type, 0);
    expect(t0.options).toHaveLength(1);
    expect(t0.options[0].steps[0].kernelId).toBe(kernelId);
    expect(t0.options[0].steps[0].assuranceTier).toBe(0);
    expect(t0.options[0].minAssuranceTier).toBe(0);
  });

  it("[neg] a node claiming 3 on a SIGNED fresh kernel (ceiling 1) is served at 1, never above", async () => {
    const kernelId = await ownedKernel("r1-gs-signed", { signed: true });
    const type = uid("r1-gs-type");
    expect((await registerNode(nodeBody(kernelId, type))).statusCode).toBe(201);

    expect((await graphSearch(type, 2)).options).toEqual([]);
    const t1 = await graphSearch(type, 1);
    expect(t1.options).toHaveLength(1);
    expect(t1.options[0].steps[0].assuranceTier).toBe(1);
  });

  it("[neg] a node whose kernel has NO row is served at 0", async () => {
    const type = uid("r1-gs-type");
    // Seeded directly: the HTTP endpoint refuses an unknown kernel (404).
    _seedGraphSearchForTests({ nodes: [nodeBody(uid("r1-no-such-kernel"), type) as never] });
    expect((await graphSearch(type, 1)).options).toEqual([]);
    expect((await graphSearch(type, 0)).options[0].steps[0].assuranceTier).toBe(0);
  });

  it("[neg] optimizeFor=quality ranks by the SERVED tier: a trusted claim of 2 beats an unsigned claim of 3", async () => {
    const trusted = trustedKernel("r1-gs-q-trusted");
    const unsigned = await ownedKernel("r1-gs-q-unsigned");
    const type = uid("r1-gs-type");
    const trustedNode = nodeBody(trusted, type, { assuranceTier: 2 });
    expect((await registerNode(trustedNode)).statusCode).toBe(201);
    expect((await registerNode(nodeBody(unsigned, type, { assuranceTier: 3 }))).statusCode).toBe(201);

    const res = await graphSearch(type, 0, { optimizeFor: "quality" });
    expect(res.options).toHaveLength(2);
    expect(res.options[0].steps[0].capabilityId).toBe(trustedNode.capabilityId);
    expect(res.options[0].steps[0].assuranceTier).toBe(2);
    expect(res.options[1].steps[0].assuranceTier).toBe(0);
  });

  it("a TRUSTED kernel (ceiling 3) keeps its claimed tier 3 (positive control)", async () => {
    const kernelId = trustedKernel("r1-gs-trusted");
    const type = uid("r1-gs-type");
    expect((await registerNode(nodeBody(kernelId, type))).statusCode).toBe(201);
    const t3 = await graphSearch(type, 3);
    expect(t3.options).toHaveLength(1);
    expect(t3.options[0].steps[0].assuranceTier).toBe(3);
  });
});

// ── _dev endpoints: owner-only, and open only in test/development ───────────

describe("R1 _dev/register-node and _dev/register-candidate: owner-only, dev-or-admin", () => {
  const saved = { admin: process.env.PCC_ADMIN_KEY, node: process.env.NODE_ENV };

  afterEach(() => {
    if (saved.admin === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = saved.admin;
    if (saved.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.node;
  });

  it("[neg] a NON-owner cannot register a graph node or a compose candidate for someone else's kernel: 403, nothing stored", async () => {
    const victim = trustedKernel("r1-dev-victim");
    const type = uid("r1-dev-type");
    const node = await registerNode(nodeBody(victim, type), asAttacker());
    expect(node.statusCode).toBe(403);
    expect(node.json().error).toBe("not_kernel_owner");
    const cand = await registerCandidate(candidateBody(victim, type), asAttacker());
    expect(cand.statusCode).toBe(403);
    expect(cand.json().error).toBe("not_kernel_owner");

    expect((await graphSearch(type, 0)).options).toEqual([]);
    await withProvider(false, async () => {
      expect((await compose({ outcomeType: type, minAssuranceTier: 0 })).status).toBe("no_path_found");
    });
  });

  it("[neg] an UNKNOWN kernel -> 404 kernel_not_found for both endpoints, nothing stored", async () => {
    const ghost = uid("r1-dev-ghost");
    const type = uid("r1-dev-type");
    const node = await registerNode(nodeBody(ghost, type));
    expect(node.statusCode).toBe(404);
    expect(node.json().error).toBe("kernel_not_found");
    const cand = await registerCandidate(candidateBody(ghost, type));
    expect(cand.statusCode).toBe(404);
    expect((await graphSearch(type, 0)).options).toEqual([]);
  });

  it("[neg] NO actor at the handler (apiGate absent) -> 401 for both endpoints", async () => {
    const kernelId = trustedKernel("r1-dev-noactor");
    const type = uid("r1-dev-type");
    expect((await registerNode(nodeBody(kernelId, type), {} as never, bare)).statusCode).toBe(401);
    expect((await registerCandidate(candidateBody(kernelId, type), {} as never, bare)).statusCode).toBe(401);
    expect((await graphSearch(type, 0)).options).toEqual([]);
  });

  it("[neg] outside test/development the endpoints need the admin key, even for the owner", async () => {
    const kernelId = trustedKernel("r1-dev-prod");
    const type = uid("r1-dev-type");
    process.env.NODE_ENV = "production";

    // No PCC_ADMIN_KEY configured: disabled (fail closed).
    delete process.env.PCC_ADMIN_KEY;
    expect((await registerNode(nodeBody(kernelId, type))).statusCode).toBe(503);
    expect((await registerCandidate(candidateBody(kernelId, type))).statusCode).toBe(503);
    const edge = await app.inject({
      method: "POST",
      url: "/api/capabilities/graph/_dev/register-edge",
      headers: asOwner(),
      payload: { fromCapabilityId: "a", toCapabilityId: "b", capabilityTypeFlow: "x" },
    });
    expect(edge.statusCode).toBe(503);

    // Configured but not sent: 401.
    process.env.PCC_ADMIN_KEY = "r1-admin-secret";
    expect((await registerNode(nodeBody(kernelId, type))).statusCode).toBe(401);
    expect((await registerCandidate(candidateBody(kernelId, type))).statusCode).toBe(401);
    process.env.NODE_ENV = saved.node ?? "test";
    expect((await graphSearch(type, 0)).options).toEqual([]);

    // The right key, sent by the owner: accepted.
    process.env.NODE_ENV = "production";
    const ok = await registerNode(nodeBody(kernelId, type), { ...asOwner(), "x-admin-key": "r1-admin-secret" } as never);
    expect(ok.statusCode).toBe(201);
  });

  it("[neg] a candidate's operatorAddress is the authenticated owner, never the body value", async () => {
    const kernelId = trustedKernel("r1-dev-op");
    const type = uid("r1-dev-type");
    const res = await registerCandidate(candidateBody(kernelId, type, { operatorAddress: "someone-else@evil.test" }));
    expect(res.statusCode).toBe(201);
    await withProvider(false, async () => {
      const plan = await compose({ outcomeType: type, minAssuranceTier: 1 });
      expect(plan.status).toBe("proposed");
      expect(plan.steps[0].operatorAddress).toBe(OWNER);
    });
  });
});

// ── /api/compose: both provider modes and outcomeChain ──────────────────────

describe("R1 /api/compose selects with the served tier (both providers, outcomeChain)", () => {
  it("[neg] default in-memory provider: a candidate claiming 3 on an UNSIGNED kernel is not selected at minAssuranceTier >= 1 (probe P5)", async () => {
    const kernelId = await ownedKernel("r1-c-mem-unsigned");
    const type = uid("r1-c-type");
    expect((await registerCandidate(candidateBody(kernelId, type))).statusCode).toBe(201);
    await withProvider(false, async () => {
      for (const tier of [1, 3]) {
        expect((await compose({ outcomeType: type, minAssuranceTier: tier })).status).toBe("no_path_found");
      }
      const t0 = await compose({ outcomeType: type, minAssuranceTier: 0 });
      expect(t0.status).toBe("proposed");
      expect(t0.steps[0].assuranceTier).toBe(0);
      expect(t0.effectiveAssuranceTier).toBe(0);
    });
  });

  it("[neg] facade provider: when the facade finds nothing, the graph fallback does not select the unsigned kernel's node at tier 3 (probe P7)", async () => {
    const kernelId = await ownedKernel("r1-c-facade-unsigned");
    const type = uid("r1-c-type");
    const pub = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asOwner(),
      payload: {
        kernelId,
        type,
        assuranceTiers: [0, 1, 2, 3],
        pricing: { currency: "USDC", baseCost: "5", minimum: "5" },
      },
    });
    expect(pub.statusCode).toBe(201);
    expect(pub.json().capability.assuranceTiers).toEqual([0]); // the facade path is clamped
    expect((await registerNode(nodeBody(kernelId, type))).statusCode).toBe(201);

    await withProvider(true, async () => {
      for (const tier of [1, 3]) {
        const plan = await compose({ outcomeType: type, minAssuranceTier: tier });
        expect(plan.status).toBe("no_path_found");
      }
    });
  });

  it("[neg] a SIGNED fresh kernel (ceiling 1) is proposed at 1 through the graph fallback, not at its claim of 3", async () => {
    const kernelId = await ownedKernel("r1-c-facade-signed", { signed: true });
    const type = uid("r1-c-type");
    expect((await registerNode(nodeBody(kernelId, type))).statusCode).toBe(201);
    await withProvider(true, async () => {
      expect((await compose({ outcomeType: type, minAssuranceTier: 2 })).status).toBe("no_path_found");
      const t1 = await compose({ outcomeType: type, minAssuranceTier: 1 });
      expect(t1.status).toBe("proposed");
      expect(t1.steps[0].kernelId).toBe(kernelId);
      expect(t1.steps[0].assuranceTier).toBe(1);
      expect(t1.effectiveAssuranceTier).toBe(1);
    });
  });

  it("[neg] outcomeChain: a chain claiming 3 on an UNSIGNED kernel gives no_path_found at minAssuranceTier 1, in BOTH provider modes", async () => {
    const kernelId = await ownedKernel("r1-c-chain-unsigned");
    const a = uid("r1-chain-a");
    const b = uid("r1-chain-b");
    const nodeA = nodeBody(kernelId, a, { outputTypes: [a] });
    const nodeB = nodeBody(kernelId, b, { inputTypes: [a], outputTypes: [b] });
    expect((await registerNode(nodeA)).statusCode).toBe(201);
    expect((await registerNode(nodeB)).statusCode).toBe(201);
    const edge = await app.inject({
      method: "POST",
      url: "/api/capabilities/graph/_dev/register-edge",
      headers: asOwner(),
      payload: { fromCapabilityId: nodeA.capabilityId, toCapabilityId: nodeB.capabilityId, capabilityTypeFlow: a },
    });
    expect(edge.statusCode).toBe(201);

    for (const facade of [false, true]) {
      await withProvider(facade, async () => {
        const plan = await compose({ outcomeType: b, outcomeChain: [a, b], minAssuranceTier: 1 });
        expect(plan.status).toBe("no_path_found");
        const t0 = await compose({ outcomeType: b, outcomeChain: [a, b], minAssuranceTier: 0 });
        expect(t0.status).toBe("proposed");
        expect(t0.steps.map((s) => s.assuranceTier)).toEqual([0, 0]);
      });
    }
  });

  it("outcomeChain on a TRUSTED kernel is proposed at its claimed tier (positive control)", async () => {
    const kernelId = trustedKernel("r1-c-chain-trusted");
    const a = uid("r1-chain-a");
    const b = uid("r1-chain-b");
    const nodeA = nodeBody(kernelId, a, { outputTypes: [a] });
    const nodeB = nodeBody(kernelId, b, { inputTypes: [a], outputTypes: [b], assuranceTier: 2 });
    expect((await registerNode(nodeA)).statusCode).toBe(201);
    expect((await registerNode(nodeB)).statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/api/capabilities/graph/_dev/register-edge",
      headers: asOwner(),
      payload: { fromCapabilityId: nodeA.capabilityId, toCapabilityId: nodeB.capabilityId, capabilityTypeFlow: a },
    });
    for (const facade of [false, true]) {
      await withProvider(facade, async () => {
        const plan = await compose({ outcomeType: b, outcomeChain: [a, b], minAssuranceTier: 2 });
        expect(plan.status).toBe("proposed");
        expect(plan.steps.map((s) => s.assuranceTier)).toEqual([3, 2]);
        expect(plan.effectiveAssuranceTier).toBe(2);
      });
    }
  });
});
