import type { FastifyInstance } from "fastify";
import type { Address } from "@pcc/spec";
import { encryptionService, litEncryptionService, getEvidenceStorage } from "../services.js";
import { auditService } from "../services/audit-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import type { LitAuthSig } from "@pcc/kernel";
import { kernelKeyStore } from "@pcc/kernel";
import { getRepos } from "../db.js";

/**
 * Helper: fetch an encrypted bundle row from DB and attach its capsules,
 * returning the composite shape that matches EncryptedEvidenceBundle.
 */
function fetchBundleWithCapsules(bundleId: string) {
  const repos = getRepos();
  const encBundle = repos.encryption.findEncryptedByBundleId(bundleId);
  if (!encBundle) return undefined;

  const capsules = repos.encryption.findCapsulesForBundle(encBundle.id);
  return { ...encBundle, capsules };
}

export async function evidenceEncryptedRoutes(app: FastifyInstance) {
  // Get encrypted evidence bundle
  app.get<{ Params: { bundleId: string } }>("/api/evidence/encrypted/:bundleId", async (req) => {
    const bundle = fetchBundleWithCapsules(req.params.bundleId);
    if (!bundle) return { error: "not_found" };
    return { bundle };
  });

  // Get key capsule for authenticated user
  app.get<{ Params: { bundleId: string }; Querystring: { address?: string } }>(
    "/api/evidence/encrypted/:bundleId/capsule",
    async (req) => {
      const bundle = fetchBundleWithCapsules(req.params.bundleId);
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
      const repos = getRepos();
      const encBundle = repos.encryption.findEncryptedByBundleId(req.params.bundleId);
      if (!encBundle) return reply.code(404).send({ error: "not_found" });

      const body = req.body as { recipientAddress: Address; accessLevel?: "full" | "selective" | "summary_only"; recipientPublicKey?: string };

      // Retrieve the real AES key from key store; fall back to zero bytes if not present
      const storedKey = kernelKeyStore.retrieve(req.params.bundleId) ?? new Uint8Array(32);

      const grant = await encryptionService.grantAccess(
        req.params.bundleId,
        storedKey,
        body.recipientAddress,
        body.accessLevel ?? "full",
        body.recipientPublicKey,
      );

      // Persist the grant to the database
      repos.encryption.insertGrant({
        id: grant.id,
        bundleId: grant.bundleId,
        grantedBy: grant.grantedBy,
        grantedTo: grant.grantedTo,
        capsuleId: grant.capsuleId,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt ?? null,
        revoked: grant.revoked,
      });

      return { grant };
    },
  );

  // List all grants for an address
  app.get<{ Params: { address: string } }>("/api/evidence/grants/:address", async (req) => {
    const repos = getRepos();
    const filtered = repos.encryption.findGrantsByAddress(req.params.address);
    return { grants: filtered };
  });

  // Archive an evidence bundle to IPFS
  app.post<{ Body: { bundle: any } }>("/api/evidence/archive", async (req, reply) => {
    try {
      const { bundle } = req.body as { bundle: any };
      if (!bundle) {
        return reply.code(400).send({ error: "bundle_required", message: "Request body must include a bundle object" });
      }
      const storage = await getEvidenceStorage();
      const result = await storage.archiveBundle(bundle);
      pipelineTelemetry.emit(bundle.jobId ?? "pipeline-" + Date.now(), "evidence_archive", "completed", { metadata: { cid: result.cid } });
      auditService.log({
        eventType: "evidence.archived",
        actor: (req as any).operatorId ?? (req as any).apiKeyId,
        resourceType: "evidence",
        resourceId: bundle.id ?? bundle.jobId,
        action: "archive",
        metadata: { cid: result.cid, metadataCid: result.metadataCid },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { archived: true, cid: result.cid, metadataCid: result.metadataCid };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Archive failed";
      return reply.code(500).send({ error: "archive_failed", message });
    }
  });

  // Archive an encrypted evidence bundle to IPFS and store CIDs
  app.post<{ Params: { bundleId: string } }>("/api/evidence/:bundleId/archive", async (req, reply) => {
    const repos = getRepos();
    const encBundle = repos.encryption.findEncryptedByBundleId(req.params.bundleId);
    if (!encBundle) return reply.code(404).send({ error: "not_found" });

    if (encBundle.ipfsCid) {
      return { archived: true, cid: encBundle.ipfsCid, metadataCid: encBundle.ipfsMetadataCid ?? null, alreadyArchived: true };
    }

    try {
      const capsules = repos.encryption.findCapsulesForBundle(encBundle.id);
      const bundle = { ...encBundle, capsules };
      const storage = await getEvidenceStorage();
      const result = await storage.archiveEncryptedBundle(bundle);
      // Persist CIDs back to the database
      repos.encryption.updateEncryptedBundle(encBundle.id, {
        ipfsCid: result.cid,
        ipfsMetadataCid: result.metadataCid,
      });
      auditService.log({
        eventType: "evidence.archived",
        actor: (req as any).operatorId ?? (req as any).apiKeyId,
        resourceType: "evidence",
        resourceId: req.params.bundleId,
        action: "archive",
        metadata: { cid: result.cid, metadataCid: result.metadataCid, encrypted: true },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { archived: true, cid: result.cid, metadataCid: result.metadataCid };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Archive failed";
      return reply.code(500).send({ error: "archive_failed", message });
    }
  });

  // Retrieve data from IPFS by CID
  app.get<{ Params: { cid: string } }>("/api/evidence/ipfs/:cid", async (req, reply) => {
    try {
      const storage = await getEvidenceStorage();
      const data = await storage.retrieveBundle(req.params.cid);
      return { data };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Retrieval failed";
      return reply.code(404).send({ error: "not_found", message });
    }
  });

  // Get IPFS CIDs for a bundle
  app.get<{ Params: { bundleId: string } }>("/api/evidence/:bundleId/ipfs", async (req, reply) => {
    const repos = getRepos();
    const encBundle = repos.encryption.findEncryptedByBundleId(req.params.bundleId);
    if (!encBundle) return reply.code(404).send({ error: "not_found" });

    if (!encBundle.ipfsCid) {
      return reply.code(404).send({ error: "not_archived", message: "Bundle has not been archived to IPFS" });
    }

    return {
      bundleId: req.params.bundleId,
      cid: encBundle.ipfsCid,
      metadataCid: encBundle.ipfsMetadataCid ?? null,
      filecoinDealId: encBundle.filecoinDealId ?? null,
    };
  });

  // ── Lit Protocol endpoints ──────────────────────────────────────

  // Get Lit access conditions for a bundle
  app.get<{ Params: { bundleId: string } }>("/api/evidence/:bundleId/lit-conditions", async (req, reply) => {
    const bundle = fetchBundleWithCapsules(req.params.bundleId);
    if (!bundle) return reply.code(404).send({ error: "not_found" });

    const conditions = litEncryptionService.getAccessConditions(bundle as any);
    if (!conditions) {
      return reply.code(404).send({
        error: "not_lit_encrypted",
        message: "Bundle was not encrypted with Lit Protocol",
      });
    }

    return {
      bundleId: req.params.bundleId,
      accessConditions: conditions,
      network: bundle.litNetwork ?? null,
      dataToEncryptHash: bundle.litDataToEncryptHash ?? null,
    };
  });

  // Decrypt a Lit-encrypted bundle using an auth signature
  app.post<{ Params: { bundleId: string }; Body: { authSig: LitAuthSig } }>(
    "/api/evidence/:bundleId/lit-decrypt",
    async (req, reply) => {
      const bundle = fetchBundleWithCapsules(req.params.bundleId);
      if (!bundle) return reply.code(404).send({ error: "not_found" });

      if (!bundle.litCiphertext || !bundle.litDataToEncryptHash) {
        return reply.code(400).send({
          error: "not_lit_encrypted",
          message: "Bundle was not encrypted with Lit Protocol",
        });
      }

      const body = req.body as { authSig?: LitAuthSig };
      if (!body.authSig) {
        return reply.code(400).send({
          error: "auth_sig_required",
          message: "Request body must include authSig with sig, derivedVia, signedMessage, and address",
        });
      }

      try {
        const decrypted = await litEncryptionService.decryptBundle(bundle as any, body.authSig);
        return { bundle: decrypted };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Decryption failed";
        return reply.code(403).send({ error: "decryption_failed", message });
      }
    },
  );
}
