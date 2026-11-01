import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as Array<{
  id: string; operatorId: string; name: string; onchainStatus: string;
  onchainAgentId: string; onchainAttemptedAt: string | null; createdAt: string;
}> }));
vi.mock("../db.js", () => ({ getRepos: () => ({ apiKeys: { listActive: () => db.rows } }) }));
vi.mock("@pcc/identity-8004", () => ({
  REGISTRY_ADDRESSES: {
    84532: { identityRegistry: "0x1111111111111111111111111111111111111111", reputationRegistry: "0x2222222222222222222222222222222222222222" },
  },
  IdentityRegistryClient: class {
    async ownerOf() { return "0x1234567890123456789012345678901234567890"; }
    async getAgentURI() { return "https://example.invalid/agent/2"; }
  },
  ReputationRegistryClient: class {
    async getClients() { return []; }
  },
}));

import { registryRoutes, resetRegistryClientsForTest } from "../routes/registry.js";

const REGISTRY_NOT_CONFIGURED = {
  error: "registry_not_configured",
  message: "No ERC-8004 identity registry is known for this gateway's chain, so no entity was read.",
};
const ATTESTATIONS_NOT_AVAILABLE = {
  error: "not_available",
  message: "Registry attestations are not read on this gateway. Only a built-in example exists, and it is not served.",
  see: [],
};
const minted = {
  id: "n34-key", operatorId: "n34-operator", name: "N34 agent",
  onchainStatus: "written", onchainAgentId: "2", onchainAttemptedAt: null,
  createdAt: "2026-10-21T12:00:00.000Z",
};

let app: FastifyInstance;
let savedFlag: string | undefined;
let savedChain: string | undefined;

beforeEach(async () => {
  savedFlag = process.env.PCC_DEMO_ROUTES;
  savedChain = process.env.IDENTITY_REGISTRY_CHAIN_ID;
  delete process.env.PCC_DEMO_ROUTES;
  process.env.IDENTITY_REGISTRY_CHAIN_ID = "84532";
  db.rows = [];
  resetRegistryClientsForTest();
  app = Fastify({ logger: false });
  await app.register(registryRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (savedFlag === undefined) delete process.env.PCC_DEMO_ROUTES;
  else process.env.PCC_DEMO_ROUTES = savedFlag;
  if (savedChain === undefined) delete process.env.IDENTITY_REGISTRY_CHAIN_ID;
  else process.env.IDENTITY_REGISTRY_CHAIN_ID = savedChain;
  resetRegistryClientsForTest();
});

describe("N34 registry reads", () => {
  it("C1 marks unread attestations unavailable and returns no fixture claims", async () => {
    const res = await app.inject({ method: "GET", url: "/api/registry/entities/2" });
    expect(res.statusCode).toBe(200);
    expect(res.json().attestations).toEqual({ state: "not_available", reason: "no_validation_registry_reader" });
    for (const value of ["0xaaa111222333", "0xcccccccc", "FDM printing"]) {
      expect(res.body).not.toContain(value);
    }
  });

  it("C2 refuses an entity read on an unknown registry chain", async () => {
    process.env.IDENTITY_REGISTRY_CHAIN_ID = "999999";
    const res = await app.inject({ method: "GET", url: "/api/registry/entities/2" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(REGISTRY_NOT_CONFIGURED);
  });

  it("C3 refuses a DB-known entity list on an unknown registry chain", async () => {
    process.env.IDENTITY_REGISTRY_CHAIN_ID = "999999";
    db.rows = [minted];
    const res = await app.inject({ method: "GET", url: "/api/registry/entities" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(REGISTRY_NOT_CONFIGURED);
  });

  it("C3 can truthfully list no minted agents without a registry read", async () => {
    process.env.IDENTITY_REGISTRY_CHAIN_ID = "999999";
    const res = await app.inject({ method: "GET", url: "/api/registry/entities" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entities: [], total: 0 });
  });

  it.each([0, 1])("C4 describes its DB-only summary with %i minted agents", async (count) => {
    db.rows = count === 0 ? [] : [minted];
    const res = await app.inject({ method: "GET", url: "/api/registry/summary" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalEntities).toBe(count);
    expect(body.byType).toEqual({ agents: count });
    expect(body.source.entities).toBe("db");
    expect(body.totalAttestations).toBeNull();
    expect(body.activeAttestations).toBeNull();
    expect(body.source.attestations).toBe("not_read");
    expect(body.averageReputation).toBeNull();
  });

  for (const url of ["/api/registry/attestations", "/api/registry/attestations/1"]) {
    for (const method of ["GET", "HEAD"] as const) {
      it(`C5 flag off gates ${method} ${url}`, async () => {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(501);
        if (method === "HEAD") expect(res.body).toBe("");
        else expect(res.json()).toEqual(ATTESTATIONS_NOT_AVAILABLE);
      });
      it(`C5 flag 1 preserves ${method} ${url}`, async () => {
        process.env.PCC_DEMO_ROUTES = "1";
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(200);
        if (method === "HEAD") expect(res.body).toBe("");
        else if (url.endsWith("/1")) expect(res.json().attestation.id).toBe(1);
        else {
          expect(res.json().source).toBe("mock");
          expect(res.json().attestations[0].id).toBe(1);
        }
      });
    }
  }
});
