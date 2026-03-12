import type { FastifyInstance } from "fastify";
import type { EncryptedEvidenceBundle, AccessGrant, Address } from "@pcc/spec";
import { encryptionService } from "../services.js";

// In-memory stores (production: database)
const encryptedBundles = new Map<string, EncryptedEvidenceBundle>();
const grants: AccessGrant[] = [];

// Seed demo data
encryptedBundles.set("bun_001", {
  id: "enc_001",
  bundleId: "bun_001",
  bundleHash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" as any,
  ciphertext: "bW9ja19lbmNyeXB0ZWRfZXZpZGVuY2VfYnVuZGxlX2RhdGE=",
  iv: "bW9ja19pdl8xMjM=",
  authTag: "bW9ja19hdXRoX3RhZw==",
  encryptedAt: new Date(Date.now() - 600_000).toISOString(),
  capsules: [
    { id: "cap_001", recipientAddress: "0x1234567890abcdef1234567890abcdef12345678" as Address, encryptedKey: "bW9ja19lbmNyeXB0ZWRfa2V5XzE=", ephemeralPublicKey: "bW9ja19lcGhlbWVyYWxfMQ==", accessLevel: "full" },
    { id: "cap_002", recipientAddress: "0xabcdef1234567890abcdef1234567890abcdef12" as Address, encryptedKey: "bW9ja19lbmNyeXB0ZWRfa2V5XzI=", ephemeralPublicKey: "bW9ja19lcGhlbWVyYWxfMg==", accessLevel: "selective" },
  ],
});
encryptedBundles.set("bun_002", {
  id: "enc_002",
  bundleId: "bun_002",
  bundleHash: "sha256:f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5" as any,
  ciphertext: "bW9ja19lbmNyeXB0ZWRfYnVuZGxlXzI=",
  iv: "bW9ja19pdl80NTY=",
  authTag: "bW9ja19hdXRoX3RhZ18y",
  encryptedAt: new Date(Date.now() - 1_200_000).toISOString(),
  capsules: [
    { id: "cap_003", recipientAddress: "0x9876543210fedcba9876543210fedcba98765432" as Address, encryptedKey: "bW9ja19lbmNyeXB0ZWRfa2V5XzM=", ephemeralPublicKey: "bW9ja19lcGhlbWVyYWxfMw==", accessLevel: "full" },
  ],
});

export async function evidenceEncryptedRoutes(app: FastifyInstance) {
  // Get encrypted evidence bundle
  app.get<{ Params: { bundleId: string } }>("/api/evidence/encrypted/:bundleId", async (req) => {
    const bundle = encryptedBundles.get(req.params.bundleId);
    if (!bundle) return { error: "not_found" };
    return { bundle };
  });

  // Get key capsule for authenticated user
  app.get<{ Params: { bundleId: string }; Querystring: { address?: string } }>(
    "/api/evidence/encrypted/:bundleId/capsule",
    async (req) => {
      const bundle = encryptedBundles.get(req.params.bundleId);
      if (!bundle) return { error: "not_found" };

      const address = req.query.address as Address | undefined;
      if (!address) return { error: "address_required" };

      const capsule = bundle.capsules.find((c) => c.recipientAddress === address);
      if (!capsule) return { error: "no_access" };

      return { capsule };
    },
  );

  // Grant access to new recipient
  app.post<{ Params: { bundleId: string }; Body: { recipientAddress: string; accessLevel?: string } }>(
    "/api/evidence/encrypted/:bundleId/grant",
    async (req, reply) => {
      const bundle = encryptedBundles.get(req.params.bundleId);
      if (!bundle) return reply.code(404).send({ error: "not_found" });

      const body = req.body as { recipientAddress: Address; accessLevel?: "full" | "selective" | "summary_only" };
      const grant = await encryptionService.grantAccess(
        req.params.bundleId,
        new Uint8Array(32), // mock key — in production, retrieve from secure store
        body.recipientAddress,
        body.accessLevel ?? "full",
      );
      grants.push(grant);
      return { grant };
    },
  );

  // List all grants for an address
  app.get<{ Params: { address: string } }>("/api/evidence/grants/:address", async (req) => {
    const filtered = grants.filter((g) => g.grantedTo === req.params.address);
    return { grants: filtered };
  });

  // Get IPFS CIDs for a bundle
  app.get<{ Params: { bundleId: string } }>("/api/evidence/:bundleId/ipfs", async (req, reply) => {
    const bundle = encryptedBundles.get(req.params.bundleId);
    if (!bundle) return reply.code(404).send({ error: "not_found" });

    if (!bundle.ipfsCid) {
      return reply.code(404).send({ error: "not_archived", message: "Bundle has not been archived to IPFS" });
    }

    return {
      bundleId: req.params.bundleId,
      cid: bundle.ipfsCid,
      metadataCid: bundle.ipfsMetadataCid ?? null,
      filecoinDealId: bundle.filecoinDealId ?? null,
    };
  });
}
