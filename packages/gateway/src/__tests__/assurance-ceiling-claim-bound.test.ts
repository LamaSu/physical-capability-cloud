/**
 * WP-C, astra pack 90 finding F1 (MEDIUM): discovery can offer a tier that
 * contracting necessarily rejects.
 *
 * Contracting (JobFacade.submit) holds a job to effectiveMaxAssuranceTier(kernel)
 * = min(the kernel's claimed maxAssuranceTier, its authorized ceiling). Capability
 * search and DTOs, the nl-query and operator-status reads, graph search, both
 * compose providers and the marketplace bounded what they serve by the
 * authorized ceiling ALONE and ignored a lower claim. A proven kernel (valid
 * signer, reputation 900, 50 completed jobs: ceiling 3) that claims tier 1 and
 * publishes a capability at [0,1,2,3] was therefore found by a tier-3 search,
 * while a tier-3 job on it is refused with assurance_tier_not_authorized.
 *
 * The rule (decided, the same one served for accepted-deal servedTiers):
 *   served tiers = clampAssuranceTiers(declared, effectiveMaxAssuranceTier(kernel))
 *
 * Kernel rows are seeded directly with known claims and ceilings. Every surface
 * is measured the same way, the HIGHEST tier it serves for a kernel's listing,
 * and must equal the highest tier contracting accepts for that kernel. The file
 * imports only modules that exist at 30a339b5 (plus a fixture), so it runs
 * unchanged there: every [neg] case fails there.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { composeRoutes, _clearComposeForTests, _registerCandidateForTests } from "../routes/compose.js";
import { graphSearchRoutes, _clearGraphSearchForTests, _seedGraphSearchForTests } from "../routes/graph-search.js";
import { nlQueryRoutes } from "../routes/nl-query.js";
import { operatorStatusRoutes } from "../routes/operator-status.js";
import { requestRoutes, _setLLMClientForTests } from "../routes/requests.js";
import {
  kernelMarketplaceRoutes,
  _clearKernelRegistry,
  _setSmokeTestFetch,
} from "../routes/kernel-marketplace.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { getCapabilityFacade, getJobFacade } from "../facades/index.js";
import {
  ensureKernelRow,
  SIGNED_FRESH_KERNEL_FIELDS,
  TRUSTED_KERNEL_FIELDS,
  UNSIGNED_KERNEL_FIELDS,
} from "./fixtures/authorized-kernels.js";

const OWNER = "n85-f1-owner@x.test";
const BUYER = "n85-f1-buyer@x.test";
const ADMIN_SECRET = "n85-f1-admin-secret";
const savedAdminKey = process.env.PCC_ADMIN_KEY;

let app: FastifyInstance;
let ownerKey = "";
const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

type Tier = 0 | 1 | 2 | 3;

/** One kernel row with a KNOWN claim and authorized ceiling, and what it must be served at. */
interface Fx {
  label: string;
  fields: Record<string, unknown>;
  claim: number;
  /** min(normalizeClaim(claim), authorized ceiling): what contracting accepts. */
  expected: Tier;
  /** The capability type. A distinctive word: the request matcher matches tokens on a shared 4-character prefix. */
  word: string;
  kernelId: string;
  capType: string;
  capId: string;
  graphType: string;
  candidateType: string;
}

const FIXTURE_SPECS: Array<Omit<Fx, "kernelId" | "capType" | "capId" | "graphType" | "candidateType">> = [
  { label: "proven (ceiling 3), claims 1 (astra's case)", fields: TRUSTED_KERNEL_FIELDS, claim: 1, expected: 1, word: "alphaq" },
  { label: "proven (ceiling 3), claims 2", fields: TRUSTED_KERNEL_FIELDS, claim: 2, expected: 2, word: "bravoq" },
  { label: "proven (ceiling 3), claims 3 (control: the claim column is read)", fields: TRUSTED_KERNEL_FIELDS, claim: 3, expected: 3, word: "charlq" },
  { label: "proven (ceiling 3), claims 0", fields: TRUSTED_KERNEL_FIELDS, claim: 0, expected: 0, word: "deltaq" },
  { label: "proven (ceiling 3), malformed claim 7", fields: TRUSTED_KERNEL_FIELDS, claim: 7, expected: 0, word: "echoqq" },
  { label: "signed but fresh (ceiling 1), claims 3 (the ceiling binds)", fields: SIGNED_FRESH_KERNEL_FIELDS, claim: 3, expected: 1, word: "foxtrq" },
  { label: "unsigned (ceiling 0), claims 3", fields: UNSIGNED_KERNEL_FIELDS, claim: 3, expected: 0, word: "golfqq" },
];

let fixtures: Fx[] = [];

function pricing() {
  return { currency: "USDC", baseCost: "10", minimum: "10" };
}

/** Seed one kernel with its listing on every surface (all claiming tier 3). */
function seedFixture(spec: (typeof FIXTURE_SPECS)[number]): Fx {
  const kernelId = uid("kernel-f1");
  const capType = spec.word;
  const fx: Fx = {
    ...spec,
    kernelId,
    capType,
    capId: `cap-${kernelId}-${capType}`,
    graphType: `${capType}-g`,
    candidateType: `${capType}-c`,
  };
  ensureKernelRow(kernelId, { operatorAddress: OWNER, ...spec.fields, maxAssuranceTier: spec.claim });
  // The capability facade / DTO / nl-query / operator-status / compose-facade surface.
  getRepos().capabilities.insert({
    id: fx.capId,
    kernelId,
    type: capType,
    // "cnc" puts the listing in the fabrication domain of the request decomposer,
    // whose evidence depth is tier-dependent: completion_event from tier 1,
    // inspection_report from tier 2, multi_verifier_attestation at tier 3.
    name: `F1 cnc ${capType}`,
    description: "",
    materials: [],
    assuranceTiers: [0, 1, 2, 3],
    pricing: pricing(),
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
  // The graph-search surface (also the compose graph fallback).
  _seedGraphSearchForTests({
    nodes: [
      {
        capabilityId: uid("f1-node"),
        capabilityType: fx.graphType,
        kernelId,
        operatorAddress: OWNER,
        estimatedPriceUSD: 10,
        estimatedDurationMs: 1_000,
        assuranceTier: 3,
        reputation: 500,
        available: true,
        outputTypes: [fx.graphType],
      } as never,
    ],
  });
  // The default (in-memory) compose provider.
  _registerCandidateForTests({
    capabilityId: uid("f1-cand"),
    kernelId,
    operatorAddress: OWNER,
    capabilityType: fx.candidateType,
    estimatedPriceUSD: 10,
    estimatedDurationMs: 1_000,
    assuranceTier: 3,
    reputation: 500,
    available: true,
  } as never);
  return fx;
}

// ── Measurement: the HIGHEST tier each surface serves for a fixture ─────────

/** Highest tier contracting accepts for the kernel (0 is always accepted). */
async function contractMax(fx: Fx): Promise<number> {
  let max = -1;
  for (const tier of [0, 1, 2, 3]) {
    const res = await getJobFacade().submit(
      { jobId: uid("f1-job"), stepId: uid("f1-step"), kernelId: fx.kernelId, capabilityId: fx.capId, assuranceTier: tier },
      BUYER,
    );
    if (res.success) max = tier;
  }
  return max;
}

const maxOf = (tiers: unknown): number =>
  Array.isArray(tiers) && tiers.length > 0 ? Math.max(...(tiers as number[])) : -1;

async function dtoMax(fx: Fx): Promise<number> {
  const res = await app.inject({ method: "GET", url: `/api/capabilities/${fx.capId}`, headers: asOwner() });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  return maxOf(body.assuranceTiers ?? body.capability?.assuranceTiers);
}

/** Highest t for which a tier-t search returns the capability. */
async function searchMax(fx: Fx): Promise<number> {
  let max = -1;
  for (const tier of [0, 1, 2, 3]) {
    const res = await getCapabilityFacade().search({ type: fx.capType, assuranceTier: tier }, {}, { limit: 50 });
    if (res.success && res.data.items.some((c) => c.id === fx.capId)) max = tier;
  }
  return max;
}

async function graphMax(fx: Fx): Promise<number> {
  let max = -1;
  for (const tier of [0, 1, 2, 3]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/graph-search",
      payload: { outcomeType: fx.graphType, budgetUSD: 1_000, minAssuranceTier: tier },
    });
    expect(res.statusCode, res.body).toBe(201);
    if (res.json().options.length > 0) max = tier;
  }
  return max;
}

/** Run `fn` with the facade compose provider on or off, restoring the flag after. */
async function withProvider<T>(facade: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PCC_COMPOSE_USE_FACADE;
  if (facade) process.env.PCC_COMPOSE_USE_FACADE = "true";
  else delete process.env.PCC_COMPOSE_USE_FACADE;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PCC_COMPOSE_USE_FACADE;
    else process.env.PCC_COMPOSE_USE_FACADE = saved;
  }
}

async function composeMax(outcomeType: string, facade: boolean): Promise<number> {
  return withProvider(facade, async () => {
    let max = -1;
    for (const tier of [0, 1, 2, 3]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/compose",
        headers: asOwner(),
        payload: { outcomeType, budgetUSD: 1_000, minAssuranceTier: tier },
      });
      if (res.json().status === "proposed") max = tier;
    }
    return max;
  });
}

async function nlMax(fx: Fx): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/api/query",
    headers: asOwner(),
    payload: { query: `find a ${fx.capType} for me` },
  });
  expect(res.statusCode, res.body).toBe(200);
  const row = (res.json().data as Array<{ id: string; assuranceTiers: number[] }>).find((r) => r.id === fx.capId);
  return maxOf(row?.assuranceTiers);
}

async function operatorStatusMax(fx: Fx): Promise<number> {
  const res = await app.inject({ method: "GET", url: `/api/operators/${OWNER}/status`, headers: asOwner() });
  expect(res.statusCode, res.body).toBe(200);
  const cap = (res.json().capabilities as Array<{ id: string; assuranceTiers: number[] }>).find((c) => c.id === fx.capId);
  return maxOf(cap?.assuranceTiers);
}

/**
 * The request matcher (POST /api/requests, agentic decomposition with a stub
 * planner): the matched node's evidence depth is derived from the SERVED max
 * tier of the matched listing, so it reveals the tier the matcher saw.
 */
async function requestsMax(fx: Fx): Promise<number> {
  _setLLMClientForTests({
    planSteps: async () => [
      { name: "Make it", description: "make it", searchQuery: fx.capType, capabilityTypeHint: fx.capType, kind: "make" as const },
    ],
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: asOwner(),
      payload: { title: `f1 request ${fx.capType}`, description: `f1 ${fx.capType}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    const node = res.json().decomposition.nodes[0] as { matchedCapabilityId?: string; evidenceRequirements: string[] };
    expect(node.matchedCapabilityId, JSON.stringify(node)).toBe(fx.capId);
    const ev = node.evidenceRequirements;
    return ev.includes("multi_verifier_attestation") ? 3 : ev.includes("inspection_report") ? 2 : ev.includes("completion_event") ? 1 : 0;
  } finally {
    _setLLMClientForTests(undefined);
  }
}

/** Register and verify a digital-kernel manifest claiming tier 3 for the fixture's kernel, then read its served tier. */
async function marketplaceMax(fx: Fx): Promise<number> {
  const manifest = {
    manifestVersion: "1.0.0",
    kernelId: fx.kernelId,
    name: "f1 digital kernel",
    description: "f1",
    builder: { agentId: "eip155:84532:0x1234567890abcdef1234567890abcdef12345678" },
    capabilityType: `${fx.capType}-m`,
    workflowSteps: [{ stepId: "s", stepType: "transform", description: "d", dependsOn: [] }],
    pricing: { currency: "USDC", baseUSD: 1 },
    maxAssuranceTier: 3,
    endpointURL: "https://kernel.f1.example/run",
    sessionKeyPolicy: { maxTTLSeconds: 60, allowedActions: ["evidence_submit"] },
  };
  const reg = await app.inject({ method: "POST", url: "/api/kernels/register", headers: asOwner(), payload: { manifest } });
  expect(reg.statusCode, reg.body).toBe(201);
  const verify = await app.inject({
    method: "POST",
    url: `/api/kernels/${fx.kernelId}/verify`,
    headers: { ...asOwner(), "x-admin-key": ADMIN_SECRET },
  });
  expect(verify.statusCode, verify.body).toBe(200);
  const served = await app.inject({ method: "GET", url: `/api/kernels/marketplace/${fx.kernelId}`, headers: asOwner() });
  expect(served.statusCode, served.body).toBe(200);
  return served.json().kernel.maxAssuranceTier as number;
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  _clearComposeForTests();
  _clearGraphSearchForTests();
  _clearKernelRegistry();
  _setSmokeTestFetch(async () => new Response("{}", { status: 200 }));
  fixtures = FIXTURE_SPECS.map(seedFixture);

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(capabilityRoutes);
  await app.register(composeRoutes);
  await app.register(graphSearchRoutes);
  await app.register(nlQueryRoutes);
  await app.register(operatorStatusRoutes);
  await app.register(requestRoutes);
  await app.register(kernelMarketplaceRoutes);
  await app.ready();
});

afterAll(async () => {
  _setSmokeTestFetch(null);
  _clearKernelRegistry();
  _clearComposeForTests();
  _clearGraphSearchForTests();
  await app?.close();
  closeStore();
  if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedAdminKey;
});

// ── The reproduction, as astra wrote it ─────────────────────────────────────

describe("astra pack 90 F1: a kernel that claims less than its authorized ceiling is not discoverable above its claim", () => {
  it("[neg] astra's reproduction: proven kernel (rep 900, 50 jobs) claiming tier 1, capability published at [0,1,2,3]: a tier-3 search must not return it, and the tier-3 job is refused", async () => {
    const kernelId = uid("kernel-f1-astra");
    ensureKernelRow(kernelId, { operatorAddress: OWNER, ...TRUSTED_KERNEL_FIELDS, maxAssuranceTier: 1 });
    const type = uid("f1-astra-type");
    const pub = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asOwner(),
      payload: { kernelId, type, assuranceTiers: [0, 1, 2, 3], pricing: pricing() },
    });
    expect(pub.statusCode, pub.body).toBe(201);
    const capId = pub.json().capability.id as string;

    // Contracting refuses tier 3 (and 2): the served tier is 1.
    for (const tier of [2, 3]) {
      const res = await getJobFacade().submit(
        { jobId: uid("f1-astra-job"), stepId: uid("f1-astra-step"), kernelId, capabilityId: capId, assuranceTier: tier },
        BUYER,
      );
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe("assurance_tier_not_authorized");
    }

    // Discovery must agree: the tier-3 and tier-2 searches do not offer it; tier 1 and 0 do.
    const found = async (tier: number) => {
      const res = await getCapabilityFacade().search({ type, assuranceTier: tier }, {}, { limit: 50 });
      return res.success && res.data.items.some((c) => c.id === capId);
    };
    expect({ 0: await found(0), 1: await found(1), 2: await found(2), 3: await found(3) }).toEqual({
      0: true,
      1: true,
      2: false,
      3: false,
    });
    // ... and the published listing itself serves [0, 1], never [0, 1, 2, 3].
    expect(pub.json().capability.assuranceTiers).toEqual([0, 1]);
  });

  it("control: the served tiers follow the claim. Once the owner raises it to 3 the same listing serves [0,1,2,3] and a tier-3 job is accepted", async () => {
    const kernelId = uid("kernel-f1-raise");
    ensureKernelRow(kernelId, { operatorAddress: OWNER, ...TRUSTED_KERNEL_FIELDS, maxAssuranceTier: 1 });
    const type = uid("f1-raise-type");
    const pub = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: asOwner(),
      payload: { kernelId, type, assuranceTiers: [0, 1, 2, 3], pricing: pricing() },
    });
    const capId = pub.json().capability.id as string;
    getRepos().kernels.update(kernelId, { maxAssuranceTier: 3 } as never);

    const dto = await app.inject({ method: "GET", url: `/api/capabilities/${capId}`, headers: asOwner() });
    expect((dto.json().assuranceTiers ?? dto.json().capability?.assuranceTiers) as number[]).toEqual([0, 1, 2, 3]);
    const res = await getCapabilityFacade().search({ type, assuranceTier: 3 }, {}, { limit: 50 });
    expect(res.success && res.data.items.some((c) => c.id === capId)).toBe(true);
    const job = await getJobFacade().submit(
      { jobId: uid("f1-raise-job"), stepId: uid("f1-raise-step"), kernelId, capabilityId: capId, assuranceTier: 3 },
      BUYER,
    );
    expect(job.success).toBe(true);
  });
});

// ── Every surface serves the tier contracting accepts ───────────────────────

describe("every discovery and selection surface serves min(claim, authorized ceiling): the highest tier contracting accepts", () => {
  it("control (the rule itself): contracting accepts exactly up to effectiveMaxAssuranceTier for every fixture", async () => {
    const mismatches: string[] = [];
    for (const fx of fixtures) {
      const got = await contractMax(fx);
      if (got !== fx.expected) mismatches.push(`${fx.label}: contracting accepts ${got}, expected ${fx.expected}`);
    }
    expect(mismatches).toEqual([]);
  });

  const SURFACES: Array<{ name: string; measure: (fx: Fx) => Promise<number> }> = [
    { name: "the capability DTO (GET /api/capabilities/:id)", measure: dtoMax },
    { name: "capability facade search (assuranceTier filter)", measure: searchMax },
    { name: "graph search (POST /api/capabilities/graph-search)", measure: graphMax },
    { name: "the default in-memory compose provider", measure: (fx) => composeMax(fx.candidateType, false) },
    { name: "the facade compose provider (PCC_COMPOSE_USE_FACADE)", measure: (fx) => composeMax(fx.capType, true) },
    { name: "the graph fallback of /api/compose", measure: (fx) => composeMax(fx.graphType, true) },
    { name: "the natural-language query (find_capability)", measure: nlMax },
    { name: "operator status (GET /api/operators/:slug/status)", measure: operatorStatusMax },
    { name: "the request matcher (POST /api/requests, evidence depth)", measure: requestsMax },
    { name: "the kernel marketplace manifest", measure: marketplaceMax },
  ];

  it.each(SURFACES)("[neg] $name serves each kernel at the tier contracting accepts", async ({ measure }) => {
    const mismatches: string[] = [];
    for (const fx of fixtures) {
      const got = await measure(fx);
      if (got !== fx.expected) mismatches.push(`${fx.label}: served ${got}, contracting accepts ${fx.expected}`);
    }
    expect(mismatches).toEqual([]);
  });
});
