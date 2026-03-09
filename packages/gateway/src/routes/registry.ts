import type { FastifyInstance } from "fastify";

/**
 * ERC-8004 Identity/Reputation/Validation Registry routes.
 *
 * Currently serves mock data. When contracts are deployed,
 * switch to on-chain reads via chain-client (same pattern as escrow routes).
 */

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockEntities = [
  {
    id: 1,
    entityType: 0,
    entityTypeName: "Agent",
    owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    metadataHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    status: 0,
    statusName: "Active",
    registeredAt: "2026-02-15T10:00:00Z",
    updatedAt: "2026-02-15T10:00:00Z",
    name: "User Agent #1",
    role: "user",
  },
  {
    id: 2,
    entityType: 1,
    entityTypeName: "Machine",
    owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    metadataHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    status: 0,
    statusName: "Active",
    registeredAt: "2026-02-20T14:30:00Z",
    updatedAt: "2026-03-01T09:00:00Z",
    name: "Prusa MK4 #001",
    role: "fdm_printer",
  },
  {
    id: 3,
    entityType: 2,
    entityTypeName: "Operator",
    owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    metadataHash: "0x567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234",
    status: 0,
    statusName: "Active",
    registeredAt: "2026-01-10T08:00:00Z",
    updatedAt: "2026-03-05T16:00:00Z",
    name: "Brooklyn Maker Hub",
    role: "operator",
  },
  {
    id: 4,
    entityType: 3,
    entityTypeName: "Verifier",
    owner: "0xcccccccccccccccccccccccccccccccccccccccc",
    metadataHash: "0x890abcdef1234567890abcdef1234567890abcdef1234567890abcdef123456",
    status: 0,
    statusName: "Active",
    registeredAt: "2026-02-01T12:00:00Z",
    updatedAt: "2026-02-01T12:00:00Z",
    name: "Verifier Guild Member #7",
    role: "verifier",
  },
];

const mockReputations: Record<number, {
  entityId: number;
  score: number;
  totalJobs: number;
  successfulJobs: number;
  disputesWon: number;
  disputesLost: number;
  lastUpdated: string;
}> = {
  1: { entityId: 1, score: 520, totalJobs: 5, successfulJobs: 5, disputesWon: 0, disputesLost: 0, lastUpdated: "2026-03-08T10:00:00Z" },
  2: { entityId: 2, score: 780, totalJobs: 45, successfulJobs: 43, disputesWon: 1, disputesLost: 1, lastUpdated: "2026-03-09T08:30:00Z" },
  3: { entityId: 3, score: 850, totalJobs: 120, successfulJobs: 118, disputesWon: 2, disputesLost: 0, lastUpdated: "2026-03-09T14:00:00Z" },
  4: { entityId: 4, score: 600, totalJobs: 0, successfulJobs: 0, disputesWon: 0, disputesLost: 0, lastUpdated: "2026-02-01T12:00:00Z" },
};

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
  },
  {
    id: 2,
    subjectId: 3,
    validator: "0xcccccccccccccccccccccccccccccccccccccccc",
    claimHash: "0xbbb222333444555666777888999000aaabbbcccdddeeefffaaa111222333444",
    claimType: "certification",
    claimDetail: "ISO 9001:2015 Quality Management System",
    issuedAt: "2026-01-15T10:00:00Z",
    expiresAt: "2027-01-15T10:00:00Z",
    revoked: false,
  },
  {
    id: 3,
    subjectId: 4,
    validator: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    claimHash: "0xccc333444555666777888999000aaabbbcccdddeeefffaaa111222333444555",
    claimType: "tier_authorization",
    claimDetail: "Authorized for Assurance Tier 2 verification",
    issuedAt: "2026-02-01T12:00:00Z",
    expiresAt: "2026-08-01T12:00:00Z",
    revoked: false,
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
      let results = [...mockEntities];
      if (req.query.type) {
        const t = parseInt(req.query.type, 10);
        results = results.filter((e) => e.entityType === t);
      }
      if (req.query.owner) {
        results = results.filter((e) => e.owner.toLowerCase() === req.query.owner!.toLowerCase());
      }
      return { entities: results, total: results.length };
    },
  );

  app.get<{ Params: { entityId: string } }>(
    "/api/registry/entities/:entityId",
    async (req, reply) => {
      const id = parseInt(req.params.entityId, 10);
      const entity = mockEntities.find((e) => e.id === id);
      if (!entity) return reply.status(404).send({ error: "Entity not found" });

      const reputation = mockReputations[id];
      const attestations = mockAttestations.filter((a) => a.subjectId === id);

      return { entity, reputation, attestations };
    },
  );

  // ── Reputation ──────────────────────────────────────────────────────

  app.get<{ Params: { entityId: string } }>(
    "/api/registry/reputation/:entityId",
    async (req, reply) => {
      const id = parseInt(req.params.entityId, 10);
      const rep = mockReputations[id];
      if (!rep) return reply.status(404).send({ error: "Reputation not found" });
      return { reputation: rep };
    },
  );

  app.get("/api/registry/reputation/leaderboard", async () => {
    const sorted = Object.values(mockReputations)
      .sort((a, b) => b.score - a.score)
      .map((rep) => {
        const entity = mockEntities.find((e) => e.id === rep.entityId);
        return { ...rep, name: entity?.name, entityTypeName: entity?.entityTypeName };
      });
    return { leaderboard: sorted };
  });

  // ── Validation / Attestations ───────────────────────────────────────

  app.get<{ Querystring: { subjectId?: string; claimType?: string } }>(
    "/api/registry/attestations",
    async (req) => {
      let results = [...mockAttestations];
      if (req.query.subjectId) {
        results = results.filter((a) => a.subjectId === parseInt(req.query.subjectId!, 10));
      }
      if (req.query.claimType) {
        results = results.filter((a) => a.claimType === req.query.claimType);
      }
      return { attestations: results, total: results.length };
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
    return {
      totalEntities: mockEntities.length,
      byType: {
        agents: mockEntities.filter((e) => e.entityType === 0).length,
        machines: mockEntities.filter((e) => e.entityType === 1).length,
        operators: mockEntities.filter((e) => e.entityType === 2).length,
        verifiers: mockEntities.filter((e) => e.entityType === 3).length,
      },
      totalAttestations: mockAttestations.length,
      activeAttestations: mockAttestations.filter((a) => !a.revoked).length,
      averageReputation: Math.round(
        Object.values(mockReputations).reduce((s, r) => s + r.score, 0) / Object.values(mockReputations).length,
      ),
    };
  });
}
