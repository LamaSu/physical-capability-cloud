import type { FastifyInstance } from "fastify";
import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import {
  IdentityRegistryClient,
  ReputationRegistryClient,
  REGISTRY_ADDRESSES,
} from "@pcc/identity-8004";
import { getRepos } from "../db.js";

/**
 * ERC-8004 Identity/Reputation/Validation Registry routes.
 *
 * Identity + Reputation route through @pcc/identity-8004 to the Daydreams
 * canonical singletons on Base Sepolia. Per-agent reads hit chain directly;
 * "list" endpoints iterate the gateway's own minted-agent DB rows (the only
 * agentIds we have a reliable list of without an indexer).
 *
 * Attestation / Validation reads remain mocked (the validation-registry
 * surface needs a per-requestHash key path, not a flat list) — they're
 * tagged `source: "mock"` until the indexer or a typed reader lands.
 *
 * Env vars (resolved lazily):
 *   IDENTITY_REGISTRY_CHAIN_ID — default 84532 (Base Sepolia)
 *   BASE_SEPOLIA_RPC / PCC_RPC_URL — default https://sepolia.base.org
 */

// ---------------------------------------------------------------------------
// Lazy client init
// ---------------------------------------------------------------------------

let _publicClient: PublicClient | undefined;
let _identityClient: IdentityRegistryClient | undefined;
let _reputationClient: ReputationRegistryClient | undefined;

function resolveChainId(): number {
  const raw = process.env.IDENTITY_REGISTRY_CHAIN_ID;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return 84532;
}

function resolveRpcUrl(): string {
  return (
    process.env.BASE_SEPOLIA_RPC ??
    process.env.PCC_RPC_URL ??
    "https://sepolia.base.org"
  );
}

function getPublicClient(): PublicClient {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(resolveRpcUrl()),
  }) as PublicClient;
  return _publicClient;
}

function getIdentityClient(): IdentityRegistryClient {
  if (_identityClient) return _identityClient;
  const chainId = resolveChainId();
  const known = REGISTRY_ADDRESSES[chainId];
  if (!known) {
    throw new Error(
      `No ERC-8004 identity registry known for chain ${chainId}. Supported: ${Object.keys(REGISTRY_ADDRESSES).join(", ")}`,
    );
  }
  _identityClient = new IdentityRegistryClient({
    publicClient: getPublicClient(),
    registryAddress: known.identityRegistry,
  });
  return _identityClient;
}

function getReputationClient(): ReputationRegistryClient {
  if (_reputationClient) return _reputationClient;
  const chainId = resolveChainId();
  const known = REGISTRY_ADDRESSES[chainId];
  if (!known) {
    throw new Error(
      `No ERC-8004 reputation registry known for chain ${chainId}. Supported: ${Object.keys(REGISTRY_ADDRESSES).join(", ")}`,
    );
  }
  _reputationClient = new ReputationRegistryClient({
    publicClient: getPublicClient(),
    registryAddress: known.reputationRegistry,
  });
  return _reputationClient;
}

/** For test isolation — drop cached clients. */
export function resetRegistryClientsForTest(): void {
  _publicClient = undefined;
  _identityClient = undefined;
  _reputationClient = undefined;
}

// ---------------------------------------------------------------------------
// DB-known agents (entries the gateway minted with onchainStatus="written")
// ---------------------------------------------------------------------------

interface DbKnownAgent {
  agentId: bigint;
  apiKeyId: string;
  operatorId: string;
  name: string | null;
  registeredAt: string | null;
}

function dbKnownAgents(): DbKnownAgent[] {
  const rows = getRepos().apiKeys.listActive();
  const out: DbKnownAgent[] = [];
  for (const row of rows) {
    if (
      row.onchainStatus === "written" &&
      row.onchainAgentId &&
      /^\d+$/.test(row.onchainAgentId)
    ) {
      out.push({
        agentId: BigInt(row.onchainAgentId),
        apiKeyId: row.id,
        operatorId: row.operatorId,
        name: row.name ?? null,
        registeredAt: row.onchainAttemptedAt ?? row.createdAt,
      });
    }
  }
  return out;
}

async function readEntity(agentId: bigint, dbHint?: DbKnownAgent) {
  const client = getIdentityClient();
  try {
    const [owner, agentURI] = await Promise.all([
      client.ownerOf(agentId),
      client.getAgentURI(agentId),
    ]);
    return {
      id: Number(agentId),
      entityType: 0,
      entityTypeName: "Agent",
      owner,
      agentURI,
      metadataHash: null as string | null,
      status: 0,
      statusName: "Active",
      registeredAt: dbHint?.registeredAt ?? null,
      name: dbHint?.name ?? null,
      role: "agent",
      source: "onchain" as const,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Attestations — still mocked (validation-registry needs per-requestHash key)
// ---------------------------------------------------------------------------

const mockAttestations = [
  {
    id: 1,
    subjectId: 2,
    validator: "0xcccccccccccccccccccccccccccccccccccccccc",
    claimHash: "0xaaa111222333444555666777888999000aaabbbcccdddeeefffaaa111222333",
    claimType: "capability",
    claimDetail: "FDM printing — PLA/PETG, 0.1mm-0.3mm layers, 256x256x256mm",
    issuedAt: "2026-02-20T15:00:00Z",
    expiresAt: "2027-02-20T15:00:00Z",
    revoked: false,
    source: "mock" as const,
  },
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registryRoutes(app: FastifyInstance) {
  // ── Identity ────────────────────────────────────────────────────────

  app.get<{ Querystring: { type?: string; owner?: string } }>(
    "/api/registry/entities",
    async (req) => {
      // We don't have a server-side indexer; list from DB-known minted agents.
      const known = dbKnownAgents();
      const entities = (
        await Promise.all(
          known.map((k) => readEntity(k.agentId, k)),
        )
      ).filter((e): e is NonNullable<typeof e> => e !== null);

      let results = entities;
      // entityType filter: only "Agent" is supported on-chain, so non-0 → empty.
      if (req.query.type) {
        const t = parseInt(req.query.type, 10);
        results = results.filter((e) => e.entityType === t);
      }
      if (req.query.owner) {
        const o = req.query.owner.toLowerCase();
        results = results.filter((e) => e.owner.toLowerCase() === o);
      }
      return { entities: results, total: results.length };
    },
  );

  app.get<{ Params: { entityId: string } }>(
    "/api/registry/entities/:entityId",
    async (req, reply) => {
      const raw = req.params.entityId;
      if (!/^\d+$/.test(raw)) {
        return reply
          .status(400)
          .send({ error: "Entity ID must be a positive integer" });
      }
      const agentId = BigInt(raw);
      // DB hint provides off-chain context (name, operator, registeredAt).
      const dbHint = dbKnownAgents().find((k) => k.agentId === agentId);
      const entity = await readEntity(agentId, dbHint);
      if (!entity) {
        return reply.status(404).send({ error: "Entity not found on-chain" });
      }

      // Reputation summary (filtered by DB-known clients only — we don't
      // have a way to enumerate every address that ever submitted feedback).
      let reputation: {
        entityId: number;
        count: number;
        summaryValue: string;
        summaryValueDecimals: number;
        source: "onchain";
      } | null = null;
      try {
        const rep = getReputationClient();
        const clients = await rep.getClients(agentId);
        if (clients.length > 0) {
          const summary = await rep.getSummary(agentId, clients);
          reputation = {
            entityId: Number(agentId),
            count: Number(summary.count),
            summaryValue: summary.summaryValue.toString(),
            summaryValueDecimals: summary.summaryValueDecimals,
            source: "onchain",
          };
        }
      } catch {
        // Reputation read failure is non-fatal — entity may have no feedback yet.
      }

      const attestations = mockAttestations.filter(
        (a) => a.subjectId === Number(agentId),
      );

      return { entity, reputation, attestations };
    },
  );

  // ── Reputation ──────────────────────────────────────────────────────

  app.get<{ Params: { entityId: string } }>(
    "/api/registry/reputation/:entityId",
    async (req, reply) => {
      const raw = req.params.entityId;
      if (!/^\d+$/.test(raw)) {
        return reply
          .status(400)
          .send({ error: "Entity ID must be a positive integer" });
      }
      const agentId = BigInt(raw);
      try {
        const rep = getReputationClient();
        const clients = await rep.getClients(agentId);
        if (clients.length === 0) {
          return reply
            .status(404)
            .send({ error: "No feedback on-chain for this agent" });
        }
        const summary = await rep.getSummary(agentId, clients);
        return {
          reputation: {
            entityId: Number(agentId),
            count: Number(summary.count),
            summaryValue: summary.summaryValue.toString(),
            summaryValueDecimals: summary.summaryValueDecimals,
            clients,
            source: "onchain" as const,
          },
        };
      } catch (err) {
        return reply.status(502).send({
          error: "Reputation read failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get("/api/registry/reputation/leaderboard", async () => {
    const known = dbKnownAgents();
    const rows = await Promise.all(
      known.map(async (k) => {
        try {
          const rep = getReputationClient();
          const clients = await rep.getClients(k.agentId);
          if (clients.length === 0) return null;
          const summary = await rep.getSummary(k.agentId, clients);
          return {
            entityId: Number(k.agentId),
            name: k.name,
            count: Number(summary.count),
            summaryValue: summary.summaryValue.toString(),
            summaryValueDecimals: summary.summaryValueDecimals,
          };
        } catch {
          return null;
        }
      }),
    );
    const sorted = rows
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => {
        // Compare summaryValue/decimals — bigger first.
        const av = BigInt(a.summaryValue);
        const bv = BigInt(b.summaryValue);
        if (av === bv) return 0;
        return av > bv ? -1 : 1;
      });
    return { leaderboard: sorted, source: "onchain" as const };
  });

  // ── Validation / Attestations (mock — pending indexer) ──────────────

  app.get<{ Querystring: { subjectId?: string; claimType?: string } }>(
    "/api/registry/attestations",
    async (req) => {
      let results = [...mockAttestations];
      if (req.query.subjectId) {
        const sid = parseInt(req.query.subjectId, 10);
        if (Number.isFinite(sid)) {
          results = results.filter((a) => a.subjectId === sid);
        }
      }
      if (req.query.claimType) {
        results = results.filter((a) => a.claimType === req.query.claimType);
      }
      return { attestations: results, total: results.length, source: "mock" };
    },
  );

  app.get<{ Params: { attestationId: string } }>(
    "/api/registry/attestations/:attestationId",
    async (req, reply) => {
      const id = parseInt(req.params.attestationId, 10);
      const att = mockAttestations.find((a) => a.id === id);
      if (!att) return reply.status(404).send({ error: "Attestation not found" });
      return { attestation: att };
    },
  );

  // ── Summary ─────────────────────────────────────────────────────────

  app.get("/api/registry/summary", async () => {
    const known = dbKnownAgents();
    return {
      totalEntities: known.length,
      byType: {
        agents: known.length, // Only Agents on the IdentityRegistry surface.
        machines: 0,
        operators: 0,
        verifiers: 0,
      },
      totalAttestations: mockAttestations.length,
      activeAttestations: mockAttestations.filter((a) => !a.revoked).length,
      averageReputation: null as number | null, // requires per-agent summary fetch
      source: { entities: "db+onchain", attestations: "mock" } as const,
    };
  });
}
