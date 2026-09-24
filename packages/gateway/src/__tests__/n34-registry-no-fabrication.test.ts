/**
 * No fixture in production (board N34, the server side of PX-3), family "registry".
 *
 * The ERC-8004 registry routes read identity and reputation from chain (real), but the
 * attestation reads had no source: one invented attestation (a validator 0xcccc…, a claim
 * hash 0xaaa111…, "FDM printing — PLA/PETG …") was served as the registry's content.
 *
 * Now, unless PCC_DEMO_ROUTES=true:
 *  - GET /attestations and /attestations/:id answer 501 not_available (SERVED-MOCK);
 *  - GET /entities/:entityId keeps the chain-read entity and reputation and gives
 *    attestations: null, unavailable: ["attestations"] (MIXED);
 *  - GET /summary keeps the DB entity counts and gives null attestation counts, named in
 *    `unavailable` (MIXED).
 * In demo the old answers stay, marked mock/demo. The REAL routes (GET /entities,
 * /reputation/:entityId, /reputation/leaderboard) are unchanged.
 *
 * The chain is mocked: tests make no network calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const chain = vi.hoisted(() => ({
  /** agentId -> owner; an absent id reverts like a nonexistent token. */
  owners: new Map<bigint, `0x${string}`>(),
  /** agentId -> addresses that left feedback. */
  clients: new Map<bigint, `0x${string}`[]>(),
}));

vi.mock("@pcc/identity-8004", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  class IdentityRegistryClient {
    async ownerOf(agentId: bigint) {
      const owner = chain.owners.get(agentId);
      if (!owner) throw new Error("ERC721NonexistentToken (test chain)");
      return owner;
    }
    async getAgentURI(agentId: bigint) {
      return `ipfs://n34-agent-${agentId}`;
    }
  }
  class ReputationRegistryClient {
    async getClients(agentId: bigint) {
      return chain.clients.get(agentId) ?? [];
    }
    async getSummary(_agentId: bigint, clients: `0x${string}`[]) {
      return { count: BigInt(clients.length), summaryValue: 8750n, summaryValueDecimals: 2 };
    }
  }
  return { ...real, IdentityRegistryClient, ReputationRegistryClient };
});

import { registryRoutes, resetRegistryClientsForTest } from "../routes/registry.js";
import { initStore, closeStore, getRepos } from "../db.js";

const OWNER_2 = "0x00000000000000000000000000000000000000a2" as const;
const OWNER_5 = "0x00000000000000000000000000000000000000a5" as const;
const CLIENT = "0x00000000000000000000000000000000000000c1" as const;

/** Values only the attestation fixture contains. None may reach a non-demo answer. */
const FIXTURE = /0x(?:c){40}|0xaaa111222333|FDM printing|claimHash|claimDetail|2027-02-20|"source":"mock"/;

let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};
const ENV = ["PCC_DEMO_ROUTES", "IDENTITY_REGISTRY_CHAIN_ID"];

/** A key the gateway minted an ERC-8004 identity for: the DB half of a real entity. */
function seedMintedAgent(id: string, agentId: bigint, name: string) {
  const repos = getRepos();
  repos.apiKeys.insert({
    id,
    keyHash: `n34-hash-${id}`,
    keyPrefix: "pcc_n34",
    operatorId: `op-${id}`,
    name,
    scopes: JSON.stringify(["*"]),
    rateLimit: "100",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  repos.apiKeys.recordOnchainSuccess(id, {
    agentId,
    txHash: "0x" + "ab".repeat(32),
    registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    chainId: 84532,
  });
}

beforeAll(async () => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  seedMintedAgent("n34-key-2", 2n, "N34 agent two");
  seedMintedAgent("n34-key-5", 5n, "N34 agent five");
  chain.owners.set(2n, OWNER_2);
  chain.owners.set(5n, OWNER_5);
  chain.clients.set(2n, [CLIENT]);
  resetRegistryClientsForTest();

  app = Fastify({ logger: false });
  await app.register(registryRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  resetRegistryClientsForTest();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  delete process.env.PCC_DEMO_ROUTES;
});

const get = (url: string) => app.inject({ method: "GET", url });

const REFUSAL = {
  error: "not_available",
  message: "Validation attestations are not recorded on this gateway, so nothing is returned rather than an example.",
  see: ["/api/registry/entities/:entityId", "/api/registry/reputation/:entityId"],
};

describe("SERVED-MOCK: the attestation routes", () => {
  const URLS = [
    "/api/registry/attestations",
    "/api/registry/attestations?subjectId=2&claimType=capability",
    "/api/registry/attestations/1",
  ];

  for (const url of URLS) {
    it(`demo off: GET ${url} -> 501 not_available, no fixture value`, async () => {
      const res = await get(url);
      expect(res.statusCode, res.body).toBe(501);
      expect(res.json()).toEqual(REFUSAL);
      expect(res.body).not.toMatch(FIXTURE);
    });
  }

  it("demo off: an unknown attestation id is 501 too (the refusal does not reveal which ids exist)", async () => {
    const res = await get("/api/registry/attestations/999");
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
  });

  it("demo on: GET /attestations -> 200, the fixture, marked mock/demo", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    const res = await get("/api/registry/attestations");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 1, source: "mock", mock: true, demo: true });
    expect(body.attestations).toHaveLength(1);
    expect(body.attestations[0]).toMatchObject({ id: 1, subjectId: 2, claimType: "capability" });
  });

  it("demo on: GET /attestations/1 -> 200, marked mock/demo", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    const res = await get("/api/registry/attestations/1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attestation: { id: 1, subjectId: 2 }, mock: true, demo: true });
  });

  it("demo on: an unknown attestation id is the old 404, marked", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    const res = await get("/api/registry/attestations/999");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Attestation not found", mock: true, demo: true });
  });
});

describe("MIXED: GET /api/registry/entities/:entityId", () => {
  it("demo off: the chain entity and reputation, attestations null and named unavailable", async () => {
    const res = await get("/api/registry/entities/2");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.entity).toMatchObject({
      id: 2,
      owner: OWNER_2,
      agentURI: "ipfs://n34-agent-2",
      name: "N34 agent two",
      source: "onchain",
    });
    expect(body.reputation).toEqual({
      entityId: 2,
      count: 1,
      summaryValue: "8750",
      summaryValueDecimals: 2,
      source: "onchain",
    });
    expect(body.attestations).toBeNull();
    expect(body.unavailable).toEqual(["attestations"]);
    expect(body).not.toHaveProperty("mock");
    expect(body).not.toHaveProperty("demo");
    expect(res.body).not.toMatch(FIXTURE);
  });

  it("demo on: the same real fields plus the fixture attestations, marked", async () => {
    const off = (await get("/api/registry/entities/2")).json();
    process.env.PCC_DEMO_ROUTES = "true";
    const res = await get("/api/registry/entities/2");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ mock: true, demo: true });
    expect(body.entity).toEqual(off.entity);
    expect(body.reputation).toEqual(off.reputation);
    expect(body.attestations).toHaveLength(1);
    expect(body.attestations[0]).toMatchObject({ id: 1, subjectId: 2 });
    expect(body).not.toHaveProperty("unavailable");
  });

  it("an entity with no feedback keeps reputation null in both modes", async () => {
    const off = (await get("/api/registry/entities/5")).json();
    expect(off).toMatchObject({ reputation: null, attestations: null, unavailable: ["attestations"] });
    process.env.PCC_DEMO_ROUTES = "true";
    const on = (await get("/api/registry/entities/5")).json();
    expect(on).toMatchObject({ reputation: null, attestations: [], mock: true, demo: true });
  });

  it("the real error answers are unchanged and unmarked in both modes (400 bad id, 404 not on chain)", async () => {
    for (const demo of [false, true]) {
      if (demo) process.env.PCC_DEMO_ROUTES = "true";
      const bad = await get("/api/registry/entities/abc");
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ error: "Entity ID must be a positive integer" });
      const missing = await get("/api/registry/entities/999");
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "Entity not found on-chain" });
    }
  });
});

describe("MIXED: GET /api/registry/summary", () => {
  const ENTITIES = {
    totalEntities: 2,
    byType: { agents: 2, machines: 0, operators: 0, verifiers: 0 },
  };

  it("demo off: the DB entity counts, attestation counts null and named unavailable", async () => {
    const res = await get("/api/registry/summary");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ...ENTITIES,
      totalAttestations: null,
      activeAttestations: null,
      averageReputation: null,
      source: { entities: "db+onchain", attestations: null },
      unavailable: ["totalAttestations", "activeAttestations"],
    });
  });

  it("demo on: the old answer with the fixture counts, marked", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    const res = await get("/api/registry/summary");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ...ENTITIES,
      totalAttestations: 1,
      activeAttestations: 1,
      averageReputation: null,
      source: { entities: "db+onchain", attestations: "mock" },
      mock: true,
      demo: true,
    });
  });
});

describe("REAL: identity and reputation reads are unchanged by the flag", () => {
  /** Same status and body with the flag off and on, and never marked. */
  async function sameInBothModes(url: string) {
    const off = await get(url);
    process.env.PCC_DEMO_ROUTES = "true";
    const on = await get(url);
    delete process.env.PCC_DEMO_ROUTES;
    expect(on.statusCode).toBe(off.statusCode);
    expect(on.json()).toEqual(off.json());
    expect(off.json()).not.toHaveProperty("mock");
    expect(off.json()).not.toHaveProperty("demo");
    return off;
  }

  it("GET /api/registry/entities lists the DB-known agents read from chain", async () => {
    const res = await sameInBothModes("/api/registry/entities");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.entities.map((e: { id: number }) => e.id).sort()).toEqual([2, 5]);
    expect(body.entities.every((e: { source: string }) => e.source === "onchain")).toBe(true);
  });

  it("GET /api/registry/reputation/:entityId reads the chain summary", async () => {
    const res = await sameInBothModes("/api/registry/reputation/2");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reputation: {
        entityId: 2,
        count: 1,
        summaryValue: "8750",
        summaryValueDecimals: 2,
        clients: [CLIENT],
        source: "onchain",
      },
    });
  });

  it("GET /api/registry/reputation/:entityId with no feedback is the old 404", async () => {
    const res = await sameInBothModes("/api/registry/reputation/5");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "No feedback on-chain for this agent" });
  });

  it("GET /api/registry/reputation/leaderboard ranks the DB-known agents with feedback", async () => {
    const res = await sameInBothModes("/api/registry/reputation/leaderboard");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      leaderboard: [
        { entityId: 2, name: "N34 agent two", count: 1, summaryValue: "8750", summaryValueDecimals: 2 },
      ],
      source: "onchain",
    });
  });
});
