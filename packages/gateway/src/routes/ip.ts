/**
 * Story Protocol IP routes.
 *
 * Exposes PCC's Story Protocol integration via REST:
 *
 *   POST /api/ip/register-capability         — Register a CSD as Story IP Asset
 *   POST /api/ip/register-job-evidence       — Register job evidence as derivative IP
 *   POST /api/ip/distribute-royalties        — 501 not_executed (PCC does not execute Story royalty payments)
 *   POST /api/ip/set-licensing-terms         — Designer sets auto-license conditions
 *   POST /api/ip/settle-royalties            — 501 not_executed (PCC does not execute Story royalty payments)
 *   GET  /api/ip/:ipId/licensing-terms       — Get licensing terms for an IP Asset
 *   GET  /api/ip/:ipId/derivative-tree       — Get full derivative tree with revenue shares
 *   GET  /api/ip/:ipId/royalty-distribution  — Calculate royalty distribution for a job amount
 *   POST /api/ip/:ipId/pay                   — 501 not_executed (PCC does not execute Story royalty payments)
 *   POST /api/ip/:ipId/claim                 — 501 not_executed (PCC does not execute Story royalty payments)
 *   GET  /api/ip/:ipId/revenue               — Revenue snapshot
 *   GET  /api/ip/:ipId/lineage               — Full IP lineage chain
 *   GET  /api/ip/capability/:capabilityId    — Get IP registration for a capability
 *   POST /api/ip/:ipId/dispute               — Raise a dispute
 *
 * DB persistence: registrations and derivative links are stored in the
 * story_ip_registrations / story_derivative_links tables via @pcc/store.
 */

import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { getRepos } from "../db.js";
import { getStoryIPService, getLicensingEngine, StoryNotExecutedError } from "@pcc/contracts";
import type { LicensingTerms } from "@pcc/spec";

const STORY_ROYALTY_NOT_EXECUTED_MESSAGE =
  "PCC does not execute Story royalty payments. This route moves no money and records nothing.";

function isStoryNotExecuted(err: unknown): boolean {
  if (err instanceof StoryNotExecutedError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "STORY_NOT_EXECUTED"
  );
}

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

interface RaiseDisputeBody {
  evidenceHash: string;
  reason: string;
}

interface SetLicensingTermsBody {
  ipId: string;
  designerAddress: string;
  autoLicense: {
    minRevSharePercent: number;
    minAssuranceTier: number;
    allowedCapabilityTypes: string[];
    allowedKinds: Array<"base" | "profile" | "extension" | "workflow">;
    cloneThreshold: number;
    derivativeThreshold: number;
    commercialUse: boolean;
    allowedRegions: string[];
  };
  standingOffers: Array<{
    name: string;
    revSharePercent: number;
    conditions: {
      maxMonthlyJobs: number;
      minTier: number;
      capabilityTypes: string[];
    };
    autoAccept: boolean;
  }>;
  defaultRevShare: number;
  allowSubDerivatives: boolean;
  derivativeDecayRate: number;
}

interface RoyaltyDistributionQuerystring {
  amount: string;
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
  const engine = getLicensingEngine();

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

        return { registration: reg, simulated: true };
      } catch (err) {
        if (isStoryNotExecuted(err)) {
          return reply.code(501).send({
            error: "not_executed",
            operation: typeof (err as { operation?: unknown }).operation === "string" ? (err as { operation: string }).operation : null,
            message: (err as { message?: string }).message,
          });
        }
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

        return { link, simulated: true };
      } catch (err) {
        if (isStoryNotExecuted(err)) {
          return reply.code(501).send({
            error: "not_executed",
            operation: typeof (err as { operation?: unknown }).operation === "string" ? (err as { operation: string }).operation : null,
            message: (err as { message?: string }).message,
          });
        }
        return reply.code(500).send({
          error: "derivative_registration_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── POST /api/ip/distribute-royalties ────────────────────────────────────

  app.post(
    "/api/ip/distribute-royalties",
    async (_req, reply) => {
      return reply.code(501).send({
        error: "not_executed",
        operation: "distributeRoyaltyTokens",
        message: STORY_ROYALTY_NOT_EXECUTED_MESSAGE,
      });
    },
  );

  // ── POST /api/ip/set-licensing-terms ─────────────────────────────────────
  // IMPORTANT: static path segments must be defined BEFORE /:ipId/* routes.

  app.post<{ Body: SetLicensingTermsBody }>(
    "/api/ip/set-licensing-terms",
    async (req, reply) => {
      const body = req.body;
      if (!body?.ipId || !body?.designerAddress) {
        return reply.code(400).send({ error: "ipId and designerAddress are required" });
      }

      const terms: LicensingTerms = {
        id: uuidv4(),
        ipId: body.ipId,
        designerAddress: body.designerAddress,
        autoLicense: body.autoLicense,
        standingOffers: body.standingOffers ?? [],
        defaultRevShare: body.defaultRevShare ?? 5,
        allowSubDerivatives: body.allowSubDerivatives ?? true,
        derivativeDecayRate: body.derivativeDecayRate ?? 0.5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      engine.setTerms(body.ipId, terms);
      return { terms, basis: "prediction", persisted: false };
    },
  );

  // ── POST /api/ip/settle-royalties ─────────────────────────────────────────

  app.post(
    "/api/ip/settle-royalties",
    async (_req, reply) => {
      return reply.code(501).send({
        error: "not_executed",
        operation: "settleRoyalties",
        message: STORY_ROYALTY_NOT_EXECUTED_MESSAGE,
      });
    },
  );

  // ── GET /api/ip/:ipId/licensing-terms ─────────────────────────────────────

  app.get<{ Params: IpIdParams }>(
    "/api/ip/:ipId/licensing-terms",
    async (req, reply) => {
      const { ipId } = req.params;
      const terms = engine.getTerms(ipId);
      if (!terms) {
        return reply.code(404).send({ error: "licensing_terms_not_found" });
      }
      return { terms, basis: "prediction", persisted: false };
    },
  );

  // ── GET /api/ip/:ipId/derivative-tree ─────────────────────────────────────

  app.get<{ Params: IpIdParams }>(
    "/api/ip/:ipId/derivative-tree",
    async (req, reply) => {
      const { ipId } = req.params;
      try {
        const chain = engine.calculateEffectiveRevShare(ipId);
        const children = engine.getChildren(ipId);
        return {
          ipId,
          ancestorChain: chain.chain,
          totalAncestorShare: chain.totalAncestorShare,
          directChildren: children,
          basis: "prediction",
        };
      } catch (err) {
        return reply.code(500).send({
          error: "derivative_tree_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── GET /api/ip/:ipId/royalty-distribution ────────────────────────────────

  app.get<{ Params: IpIdParams; Querystring: RoyaltyDistributionQuerystring }>(
    "/api/ip/:ipId/royalty-distribution",
    async (req, reply) => {
      const { ipId } = req.params;
      const amount = (req.query as RoyaltyDistributionQuerystring).amount ?? "1000000";

      try {
        const distributions = engine.getRoyaltyDistribution(ipId, amount);
        return { ipId, amount, distributions, basis: "prediction" };
      } catch (err) {
        return reply.code(500).send({
          error: "royalty_distribution_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── POST /api/ip/:ipId/pay ────────────────────────────────────────────────

  app.post(
    "/api/ip/:ipId/pay",
    async (_req, reply) => {
      return reply.code(501).send({
        error: "not_executed",
        operation: "payJobRoyalty",
        message: STORY_ROYALTY_NOT_EXECUTED_MESSAGE,
      });
    },
  );

  // ── POST /api/ip/:ipId/claim ──────────────────────────────────────────────

  app.post(
    "/api/ip/:ipId/claim",
    async (_req, reply) => {
      return reply.code(501).send({
        error: "not_executed",
        operation: "claimRevenue",
        message: STORY_ROYALTY_NOT_EXECUTED_MESSAGE,
      });
    },
  );

  // ── GET /api/ip/:ipId/revenue ─────────────────────────────────────────────

  app.get<{ Params: IpIdParams }>(
    "/api/ip/:ipId/revenue",
    async (req, reply) => {
      const { ipId } = req.params;

      try {
        const snapshot = await svc.getRevenueSnapshot(ipId);
        return { ...snapshot, simulated: true };
      } catch (err) {
        if (isStoryNotExecuted(err)) {
          return reply.code(501).send({
            error: "not_executed",
            operation: typeof (err as { operation?: unknown }).operation === "string" ? (err as { operation: string }).operation : null,
            message: (err as { message?: string }).message,
          });
        }
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
        return { ipId, ...lineage, simulated: true };
      } catch (err) {
        if (isStoryNotExecuted(err)) {
          return reply.code(501).send({
            error: "not_executed",
            operation: typeof (err as { operation?: unknown }).operation === "string" ? (err as { operation: string }).operation : null,
            message: (err as { message?: string }).message,
          });
        }
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
              return { registration: dbReg, simulated: true };
            }
          } catch {
            // DB not available
          }
          return reply.code(404).send({ error: "ip_registration_not_found" });
        }

        return { registration: reg, simulated: true };
      } catch (err) {
        if (isStoryNotExecuted(err)) {
          return reply.code(501).send({
            error: "not_executed",
            operation: typeof (err as { operation?: unknown }).operation === "string" ? (err as { operation: string }).operation : null,
            message: (err as { message?: string }).message,
          });
        }
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
        return { dispute, simulated: true };
      } catch (err) {
        if (isStoryNotExecuted(err)) {
          return reply.code(501).send({
            error: "not_executed",
            operation: typeof (err as { operation?: unknown }).operation === "string" ? (err as { operation: string }).operation : null,
            message: (err as { message?: string }).message,
          });
        }
        return reply.code(500).send({
          error: "raise_dispute_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
