/**
 * Story Protocol IP routes.
 *
 * Exposes PCC's Story Protocol integration via REST:
 *
 *   POST /api/ip/register-capability       — Register a CSD as Story IP Asset
 *   POST /api/ip/register-job-evidence     — Register job evidence as derivative IP
 *   POST /api/ip/distribute-royalties      — Set revenue split for an IP Asset
 *   POST /api/ip/:ipId/pay                 — Pay royalty to an IP vault
 *   POST /api/ip/:ipId/claim               — Claim revenue from a vault
 *   GET  /api/ip/:ipId/revenue             — Revenue snapshot
 *   GET  /api/ip/:ipId/lineage             — Full IP lineage chain
 *   GET  /api/ip/capability/:capabilityId  — Get IP registration for a capability
 *   POST /api/ip/:ipId/dispute             — Raise a dispute
 *
 * DB persistence: registrations and derivative links are stored in the
 * story_ip_registrations / story_derivative_links tables via @pcc/store.
 */

import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { getRepos } from "../db.js";
import { getStoryIPService } from "@pcc/contracts";

// ---------------------------------------------------------------------------
// Body / Params interfaces
// ---------------------------------------------------------------------------

interface RegisterCapabilityBody {
  capability: {
    id: string;
    name: string;
    type: string;
    kernelId: string;
    description?: string;
  };
  designerAddress: string;
  designerName: string;
  commercialRevShare?: number;
  ipfsCid?: string;
}

interface RegisterJobEvidenceBody {
  parentIpId: string;
  jobId: string;
  evidenceBundleHash: string;
  operatorAddress: string;
  operatorName: string;
  ipfsCid?: string;
}

interface DistributeRoyaltiesBody {
  ipId: string;
  splits: Array<{
    address: string;
    role: "designer" | "operator" | "verifier" | "assembler" | "curator";
    percentage: number;
    label: string;
  }>;
}

interface PayRoyaltyBody {
  amount: string;
  payerAddress: string;
}

interface ClaimRevenueBody {
  tokenIds?: string[];
}

interface RaiseDisputeBody {
  evidenceHash: string;
  reason: string;
}

interface IpIdParams {
  ipId: string;
}

interface CapabilityIdParams {
  capabilityId: string;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function ipRoutes(app: FastifyInstance) {
  const svc = getStoryIPService();

  // ── POST /api/ip/register-capability ─────────────────────────────────────

  app.post<{ Body: RegisterCapabilityBody }>(
    "/api/ip/register-capability",
    async (req, reply) => {
      const { capability, designerAddress, designerName, commercialRevShare, ipfsCid } = req.body;

      if (!capability?.id || !capability?.name || !capability?.type || !capability?.kernelId) {
        return reply.code(400).send({ error: "capability.id, capability.name, capability.type, and capability.kernelId are required" });
      }
      if (!designerAddress || !designerName) {
        return reply.code(400).send({ error: "designerAddress and designerName are required" });
      }

      try {
        const reg = await svc.registerCapabilityAsIP(capability, {
          designerAddress,
          designerName,
          commercialRevShare,
          ipfsCid,
        });

        // Persist to DB (best-effort)
        try {
          const repos = getRepos();
          // Only set capabilityId if the capability actually exists in the DB
          // (the FK is nullable, and the capability may not be persisted in all envs)
          let resolvedCapabilityId: string | undefined;
          try {
            const caps = repos.capabilities.findByKernel(capability.kernelId);
            const cap = caps.find((c) => c.id === capability.id);
            resolvedCapabilityId = cap?.id;
          } catch {
            // Capability lookup failed — insert without FK
          }
          repos.story.insertIpRegistration({
            ipId: reg.ipId,
            nftTokenId: reg.nftTokenId,
            licenseTermsId: reg.licenseTermsId,
            txHash: reg.txHash,
            capabilityId: resolvedCapabilityId,
            csdUrl: reg.csdUrl,
            chain: reg.chain,
            registeredAt: reg.registeredAt,
          });
        } catch (dbErr) {
          console.warn("[ip] DB persist of IP registration failed (best-effort):", dbErr instanceof Error ? dbErr.message : dbErr);
        }

        return { registration: reg };
      } catch (err) {
        return reply.code(500).send({
          error: "registration_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── POST /api/ip/register-job-evidence ───────────────────────────────────

  app.post<{ Body: RegisterJobEvidenceBody }>(
    "/api/ip/register-job-evidence",
    async (req, reply) => {
      const { parentIpId, jobId, evidenceBundleHash, operatorAddress, operatorName, ipfsCid } = req.body;

      if (!parentIpId || !jobId || !evidenceBundleHash || !operatorAddress || !operatorName) {
        return reply.code(400).send({
          error: "parentIpId, jobId, evidenceBundleHash, operatorAddress, and operatorName are required",
        });
      }

      try {
        const link = await svc.registerJobAsDerivative(parentIpId, {
          jobId,
          evidenceBundleHash,
          operatorAddress,
          operatorName,
          ipfsCid,
        });

        // Persist to DB (best-effort)
        try {
          const repos = getRepos();
          // Only set jobId if the job actually exists in the DB (FK constraint)
          let resolvedJobId: string | undefined;
          try {
            const job = repos.jobs.findById(link.jobId);
            resolvedJobId = job?.id;
          } catch {
            // Job lookup failed — insert without FK
          }
          repos.story.insertDerivativeLink({
            id: uuidv4(),
            parentIpId: link.parentIpId,
            childIpId: link.childIpId,
            licenseTokenId: link.licenseTokenId,
            jobId: resolvedJobId,
            evidenceBundleHash: link.evidenceBundleHash,
            txHash: link.txHash,
            linkedAt: link.linkedAt,
          });
        } catch (dbErr) {
          console.warn("[ip] DB persist of derivative link failed (best-effort):", dbErr instanceof Error ? dbErr.message : dbErr);
        }

        return { link };
      } catch (err) {
        return reply.code(500).send({
          error: "derivative_registration_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── POST /api/ip/distribute-royalties ────────────────────────────────────

  app.post<{ Body: DistributeRoyaltiesBody }>(
    "/api/ip/distribute-royalties",
    async (req, reply) => {
      const { ipId, splits } = req.body;

      if (!ipId || !splits || !Array.isArray(splits) || splits.length === 0) {
        return reply.code(400).send({ error: "ipId and splits (non-empty array) are required" });
      }

      const total = splits.reduce((s, item) => s + (item.percentage ?? 0), 0);
      if (total !== 100) {
        return reply.code(400).send({
          error: "splits_must_sum_to_100",
          message: `Splits sum to ${total}, expected 100`,
        });
      }

      try {
        const result = await svc.distributeRoyaltyTokens(ipId, splits);

        // Persist splits to DB (best-effort)
        try {
          const repos = getRepos();
          // Remove old splits first
          repos.story.deleteRoyaltySplitsByIp(ipId);
          for (const split of splits) {
            repos.story.insertRoyaltySplit({
              id: uuidv4(),
              ipId,
              address: split.address,
              role: split.role,
              percentage: split.percentage,
              label: split.label,
            });
          }
        } catch (dbErr) {
          console.warn("[ip] DB persist of royalty splits failed (best-effort):", dbErr instanceof Error ? dbErr.message : dbErr);
        }

        return result;
      } catch (err) {
        return reply.code(500).send({
          error: "distribute_royalties_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── POST /api/ip/:ipId/pay ────────────────────────────────────────────────

  app.post<{ Params: IpIdParams; Body: PayRoyaltyBody }>(
    "/api/ip/:ipId/pay",
    async (req, reply) => {
      const { ipId } = req.params;
      const { amount, payerAddress } = req.body;

      if (!amount || !payerAddress) {
        return reply.code(400).send({ error: "amount and payerAddress are required" });
      }

      try {
        const result = await svc.payJobRoyalty(ipId, amount, payerAddress);
        return result;
      } catch (err) {
        return reply.code(500).send({
          error: "pay_royalty_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── POST /api/ip/:ipId/claim ──────────────────────────────────────────────

  app.post<{ Params: IpIdParams; Body: ClaimRevenueBody }>(
    "/api/ip/:ipId/claim",
    async (req, reply) => {
      const { ipId } = req.params;
      const { tokenIds } = req.body ?? {};

      try {
        const result = await svc.claimRevenue(ipId, tokenIds);

        // Persist claim to DB (best-effort)
        try {
          const repos = getRepos();
          repos.story.insertRevenueClaim({
            id: uuidv4(),
            ipId,
            claimerAddress: "0x0000000000000000000000000000000000000000",
            amount: result.claimed,
            txHash: result.txHash,
            claimedAt: new Date().toISOString(),
          });
        } catch (dbErr) {
          console.warn("[ip] DB persist of revenue claim failed (best-effort):", dbErr instanceof Error ? dbErr.message : dbErr);
        }

        return result;
      } catch (err) {
        return reply.code(500).send({
          error: "claim_revenue_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── GET /api/ip/:ipId/revenue ─────────────────────────────────────────────

  app.get<{ Params: IpIdParams }>(
    "/api/ip/:ipId/revenue",
    async (req, reply) => {
      const { ipId } = req.params;

      try {
        const snapshot = await svc.getRevenueSnapshot(ipId);
        return snapshot;
      } catch (err) {
        return reply.code(500).send({
          error: "revenue_snapshot_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── GET /api/ip/:ipId/lineage ─────────────────────────────────────────────

  app.get<{ Params: IpIdParams }>(
    "/api/ip/:ipId/lineage",
    async (req, reply) => {
      const { ipId } = req.params;

      try {
        const lineage = await svc.getLineage(ipId);
        return { ipId, ...lineage };
      } catch (err) {
        return reply.code(500).send({
          error: "lineage_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── GET /api/ip/capability/:capabilityId ─────────────────────────────────
  // IMPORTANT: this route must be defined BEFORE /:ipId/* routes to avoid
  // conflict. Fastify resolves static path segments first.

  app.get<{ Params: CapabilityIdParams }>(
    "/api/ip/capability/:capabilityId",
    async (req, reply) => {
      const { capabilityId } = req.params;

      try {
        // Check service in-memory store first
        const reg = await svc.getIPRegistration(capabilityId);

        if (!reg) {
          // Fall back to DB
          try {
            const repos = getRepos();
            const dbReg = repos.story.findIpByCapabilityId(capabilityId);
            if (dbReg) {
              return { registration: dbReg };
            }
          } catch {
            // DB not available
          }
          return reply.code(404).send({ error: "ip_registration_not_found" });
        }

        return { registration: reg };
      } catch (err) {
        return reply.code(500).send({
          error: "get_ip_registration_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── POST /api/ip/:ipId/dispute ────────────────────────────────────────────

  app.post<{ Params: IpIdParams; Body: RaiseDisputeBody }>(
    "/api/ip/:ipId/dispute",
    async (req, reply) => {
      const { ipId } = req.params;
      const { evidenceHash, reason } = req.body;

      if (!evidenceHash || !reason) {
        return reply.code(400).send({ error: "evidenceHash and reason are required" });
      }

      try {
        const dispute = await svc.raiseDispute(ipId, { hash: evidenceHash, reason });
        return { dispute };
      } catch (err) {
        return reply.code(500).send({
          error: "raise_dispute_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
