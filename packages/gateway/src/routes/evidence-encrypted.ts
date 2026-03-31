import type { FastifyInstance } from "fastify";
import type { Address } from "@pcc/spec";
import { encryptionService, litEncryptionService, getEvidenceStorage } from "../services.js";
import { auditService } from "../services/audit-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { trackServerEvent } from "../services/posthog-service.js";
import type { LitAuthSig } from "@pcc/kernel";
import { kernelKeyStore, generateDecryptAction, executeDecryptAction, isRealLitEnabled } from "@pcc/kernel";
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
  // Log Lit service availability at route registration time
  const litStatus = litEncryptionService.getStatus();
  console.log(
    `[LIT] evidence-encrypted routes registered — litConnected=${litStatus.connected} litMode=${litStatus.mode} litNetwork=${litStatus.network}`,
  );

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
      trackServerEvent("evidence_archived", { cid: result.cid, jobId: bundle.jobId }, (req as any).operatorId);
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
      trackServerEvent("evidence_archived", { cid: result.cid, bundleId: req.params.bundleId, encrypted: true }, (req as any).operatorId);
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

  // Get Lit service status
  app.get("/api/evidence/lit-status", async () => {
    return {
      timestamp: new Date().toISOString(),
      lit: litEncryptionService.getStatus(),
    };
  });

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

  // Decrypt a Lit-encrypted bundle using an auth signature.
  // Path 1 (preferred): Lit Action via Chipotle REST API (when LIT_PROTOCOL_REAL=true)
  // Path 2 (fallback): Local litEncryptionService.decryptBundle()
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

      const litApiUrl = process.env.LIT_API_URL ?? "https://api.dev.litprotocol.com/core/v1";
      const litApiKey = process.env.LIT_USAGE_KEY ?? process.env.LIT_API_KEY ?? "";
      const useRealLit = isRealLitEnabled() && !!litApiKey;

      // Path 1: Try Lit Action decrypt via Chipotle REST API
      if (useRealLit) {
        try {
          console.log(`[LIT] attempting Lit Action decrypt for bundleId=${req.params.bundleId}`);
          const storedKey = kernelKeyStore.retrieve(req.params.bundleId);
          const keyB64 = storedKey ? Buffer.from(storedKey).toString("base64") : "";

          const actionCode = generateDecryptAction({
            escrowAddress: (bundle as any).escrowAddress ?? "",
            jobId: (bundle as any).jobId ?? "",
            chain: (bundle as any).litNetwork === "chipotle" ? "baseSepolia" : "baseSepolia",
            encryptedKeyB64: keyB64,
          });

          const result = await executeDecryptAction({
            apiUrl: litApiUrl,
            apiKey: litApiKey,
            actionCode,
            userAddress: body.authSig.address,
          });

          if (result.authorized && result.key) {
            console.log(`[LIT] Lit Action decrypt authorized (${result.role}) for bundleId=${req.params.bundleId}`);
            pipelineTelemetry.emit(req.params.bundleId, "evidence_encrypt", "completed", {
              metadata: { path: "lit_action", role: result.role, operation: "decrypt" },
            });
            trackServerEvent("evidence_encrypted", {
              bundleId: req.params.bundleId,
              operation: "decrypt",
              path: "lit_action",
              role: result.role,
            }, (req as any).operatorId);
            return { bundle: { decryptionKey: result.key, role: result.role, path: "lit_action" } };
          }

          if (!result.authorized) {
            console.log(`[LIT] Lit Action decrypt denied: ${result.reason}`);
            // Do NOT fall back to local — the on-chain check said no
            return reply.code(403).send({
              error: "access_denied",
              message: result.reason ?? "On-chain access conditions not met",
              path: "lit_action",
            });
          }
        } catch (litErr) {
          // Lit network failure — fall through to local decrypt
          const litMsg = litErr instanceof Error ? litErr.message : "Lit Action failed";
          console.log(`[LIT] Lit Action decrypt failed, falling back to local: ${litMsg}`);
        }
      }

      // Path 2: Local decrypt (mock Lit or real Lit unavailable)
      try {
        console.log(`[LIT] using local decrypt for bundleId=${req.params.bundleId}`);
        const decrypted = await litEncryptionService.decryptBundle(bundle as any, body.authSig);
        pipelineTelemetry.emit(req.params.bundleId, "evidence_encrypt", "completed", {
          metadata: { path: "local", operation: "decrypt" },
        });
        trackServerEvent("evidence_encrypted", {
          bundleId: req.params.bundleId,
          operation: "decrypt",
          path: "local",
        }, (req as any).operatorId);
        return { bundle: decrypted };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Decryption failed";
        return reply.code(403).send({ error: "decryption_failed", message });
      }
    },
  );
}
