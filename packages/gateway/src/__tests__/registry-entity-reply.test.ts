import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as Array<{
  id: string; operatorId: string; name: string; onchainStatus: string;
  onchainAgentId: string; onchainAttemptedAt: string | null; createdAt: string;
}> }));
const chain = vi.hoisted(() => ({
  agents: [
    {
      id: 7,
      owner: "0x7777777777777777777777777777777777777777",
      agentURI: "https://example.invalid/agent/7",
      summary: { count: 3n, summaryValue: 450n, summaryValueDecimals: 2 },
    },
    {
      id: 8,
      owner: "0x8888888888888888888888888888888888888888",
      agentURI: "https://example.invalid/agent/8",
      summary: { count: 1n, summaryValue: 90n, summaryValueDecimals: 2 },
    },
  ],
  clients: ["0x3333333333333333333333333333333333333333"],
}));
vi.mock("../db.js", () => ({ getRepos: () => ({ apiKeys: { listActive: () => db.rows } }) }));
vi.mock("@pcc/identity-8004", () => ({
  REGISTRY_ADDRESSES: {
    84532: { identityRegistry: "0x1111111111111111111111111111111111111111", reputationRegistry: "0x2222222222222222222222222222222222222222" },
  },
  IdentityRegistryClient: class {
    async ownerOf(agentId: bigint) {
      return chain.agents.find((agent) => agent.id === Number(agentId))!.owner;
    }
    async getAgentURI(agentId: bigint) {
      return chain.agents.find((agent) => agent.id === Number(agentId))!.agentURI;
    }
  },
  ReputationRegistryClient: class {
    async getClients() { return chain.clients; }
    async getSummary(agentId: bigint, _clients: string[]) {
      return chain.agents.find((agent) => agent.id === Number(agentId))!.summary;
    }
  },
}));

import { registryRoutes, resetRegistryClientsForTest } from "../routes/registry.js";

let app: FastifyInstance;
let savedChain: string | undefined;

beforeEach(async () => {
  savedChain = process.env.IDENTITY_REGISTRY_CHAIN_ID;
  process.env.IDENTITY_REGISTRY_CHAIN_ID = "84532";
  db.rows = [
    {
      id: "key-a", operatorId: "operator-a", name: "Alpha Workshop",
      onchainStatus: "written", onchainAgentId: "7",
      onchainAttemptedAt: "2026-10-01T10:00:00.000Z",
      createdAt: "2026-09-30T09:00:00.000Z",
    },
    {
      id: "key-b", operatorId: "operator-b", name: "Bravo Lab",
      onchainStatus: "written", onchainAgentId: "8",
      onchainAttemptedAt: null, createdAt: "2026-10-02T11:00:00.000Z",
    },
  ];
  resetRegistryClientsForTest();
  app = Fastify({ logger: false });
  await app.register(registryRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (savedChain === undefined) delete process.env.IDENTITY_REGISTRY_CHAIN_ID;
  else process.env.IDENTITY_REGISTRY_CHAIN_ID = savedChain;
  resetRegistryClientsForTest();
});

describe("N221 registry entity replies", () => {
  it("C1 the entity list carries the on-chain fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/registry/entities" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.entities.map((entity: { id: number }) => entity.id)).toEqual([7, 8]);
    for (const entity of body.entities) {
      expect(entity).not.toHaveProperty("name");
      expect(entity).not.toHaveProperty("registeredAt");
    }
    expect(res.body).not.toContain("Alpha Workshop");
    expect(res.body).not.toContain("Bravo Lab");
  });

  it("C2 each entity read carries the on-chain fields", async () => {
    for (const id of [7, 8]) {
      const res = await app.inject({ method: "GET", url: `/api/registry/entities/${id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entity).not.toHaveProperty("name");
      expect(body.entity).not.toHaveProperty("registeredAt");
      expect(res.body).not.toContain("Alpha Workshop");
      expect(res.body).not.toContain("Bravo Lab");
    }
  });

  it("C3 the leaderboard carries the on-chain fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/registry/reputation/leaderboard" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.leaderboard).toHaveLength(2);
    for (const row of body.leaderboard) {
      expect(row).not.toHaveProperty("name");
    }
    expect(res.body).not.toContain("Alpha Workshop");
    expect(res.body).not.toContain("Bravo Lab");
  });

  it("C4 the on-chain fields keep their values", async () => {
    const list = await app.inject({ method: "GET", url: "/api/registry/entities" });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(2);
    expect(body.entities).toHaveLength(2);
    for (const [index, agent] of chain.agents.entries()) {
      const expected = {
        id: agent.id,
        entityType: 0,
        entityTypeName: "Agent",
        owner: agent.owner,
        agentURI: agent.agentURI,
        metadataHash: null,
        status: 0,
        statusName: "Active",
        role: "agent",
        source: "onchain",
      };
      expect(body.entities[index]).toMatchObject(expected);
      const res = await app.inject({ method: "GET", url: `/api/registry/entities/${agent.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().entity).toMatchObject(expected);
    }
    const leaderboard = await app.inject({ method: "GET", url: "/api/registry/reputation/leaderboard" });
    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.json().leaderboard).toMatchObject([
      { entityId: 7, count: 3, summaryValue: "450", summaryValueDecimals: 2 },
      { entityId: 8, count: 1, summaryValue: "90", summaryValueDecimals: 2 },
    ]);
  });
});
