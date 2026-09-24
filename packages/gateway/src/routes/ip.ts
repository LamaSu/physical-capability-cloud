/**
 * Story Protocol IP routes.
 *
 * Exposes PCC's Story Protocol integration via REST:
 *
 *   POST /api/ip/register-capability         — Register a CSD as Story IP Asset
 *   POST /api/ip/register-job-evidence       — Register job evidence as derivative IP
 *   POST /api/ip/distribute-royalties        — Set revenue split for an IP Asset
 *   POST /api/ip/set-licensing-terms         — Designer sets auto-license conditions
 *   POST /api/ip/settle-royalties            — Trigger royalty settlement for completed job
 *   GET  /api/ip/:ipId/licensing-terms       — Get licensing terms for an IP Asset
 *   GET  /api/ip/:ipId/derivative-tree       — Get full derivative tree with revenue shares
 *   GET  /api/ip/:ipId/royalty-distribution  — Calculate royalty distribution for a job amount
 *   POST /api/ip/:ipId/pay                   — Pay royalty to an IP vault
 *   POST /api/ip/:ipId/claim                 — Claim revenue from a vault
 *   GET  /api/ip/:ipId/revenue               — Revenue snapshot
 *   GET  /api/ip/:ipId/lineage               — Full IP lineage chain
 *   GET  /api/ip/capability/:capabilityId    — Get IP registration for a capability
 *   POST /api/ip/:ipId/dispute               — Raise a dispute
 *
 * DB persistence: registrations and derivative links are stored in the
 * story_ip_registrations / story_derivative_links tables via @pcc/store.
 *
 * Authorization (N10a):
 *   - WHO the caller is: only a wallet proven by a SIWE (EIP-4361) session. An API key's operatorId is
 *     not proof: POST /api/auth/provision is public and issues a key for a caller-asserted identity, so
 *     an owner check on it could be passed by anyone (the reason job.cancel is unregistered in
 *     mcp/operation-policy.ts). Keys become eligible once a key records a SIWE-proven identity.
 *   - WHO owns an IP: there is no owner column; ownership is derived from durable records only.
 *     A capability IP (story_ip_registrations.capability_id) is owned by the operator of that
 *     capability's kernel; a job-evidence IP (story_derivative_links.job_id) by the operator of that
 *     job's kernel. Anything else has no recorded owner, and every mutation of it is refused
 *     (403 ip_owner_unknown): fail closed.
 *   - Registration therefore requires the caller to operate the kernel it registers for, and records
 *     the link that later proves ownership; nothing about ownership comes from the request body.
 *   - Money never comes from the body: settle-royalties takes the revenue and the payer from the
 *     job's released escrow milestone, and pay/claim act as the caller only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { parseUnits } from "viem";
import { getRepos } from "../db.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { auditService } from "../services/audit-service.js";
import { getStoryIPService, getLicensingEngine } from "@pcc/contracts";
import type { ContributorRole, LicensingTerms } from "@pcc/spec";

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

/**
 * Body shape for POST /api/ip/distribute-royalties.
 *
 * `splits[].role` reuses the canonical `ContributorRole` taxonomy from
 * @pcc/spec (ADR-12 §2.1). That union covers all 10 new role values
 * (operator, verifier, insurer, integrator, protocol-author, model-author,
 * dataset-contributor, curator, assembler, network-treasury) plus the
 * deprecated `designer` alias kept for backward compatibility so older
 * clients still validate.
 *
 * The route handler does not enforce the enum at runtime — it only checks
 * the splits array shape and that percentages sum to 100, then forwards
 * the payload to `svc.distributeRoyaltyTokens()`. Older clients sending
 * the pre-ADR-12 `"network"` string therefore still decode at the JSON
 * boundary, even though it is not part of `ContributorRole`. Such clients
 * should migrate to `network-treasury` per ADR-12 §2.2.
 */
interface DistributeRoyaltiesBody {
  ipId: string;
  splits: Array<{
    address: string;
    role: ContributorRole;
    percentage: number;
    label: string;
  }>;
}

interface PayRoyaltyBody {
  amount: string;
  /** Optional: the payer is the caller. When given it must be the caller's wallet. */
  payerAddress?: string;
}

interface ClaimRevenueBody {
  tokenIds?: string[];
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

interface SettleRoyaltiesBody {
  jobId: string;
  childIpId: string;
  /** Optional and never trusted: when given it must equal the released milestone's amount (base units). */
  jobRevenue?: string;
  /** Optional and never trusted: when given it must equal the escrow's payer. */
  payerAddress?: string;
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
// Authorization (N10a)
// ---------------------------------------------------------------------------

const SIWE_STEPS = {
  nonce_url: "/api/auth/nonce",
  verify_url: "/api/auth/verify",
  how: "GET the nonce, sign the SIWE message with your wallet, POST it to verify, then send Authorization: Bearer <session token>.",
};

/**
 * The caller's wallet, lowercase, when a SIWE session proved it; otherwise null. API keys are not
 * accepted here on purpose (see the header): their operatorId is asserted, not proven.
 */
function verifiedWallet(req: FastifyRequest): string | null {
  // Gateway #326 adds req.provenWallet, set by apiGate on every request from a SIWE session or from a key
  // minted through the SIWE path: a wallet, or null. Only apiGate writes it; a client cannot. Once it is
  // set it is final, null included: apiGate deliberately answers null for a SIWE cookie riding on another
  // identity's API key (gateway #3160), so the session must not be consulted behind its back. Before
  // #326, the field is absent and the session is the only proof.
  const proven = (req as { provenWallet?: unknown }).provenWallet;
  if (proven !== undefined) return typeof proven === "string" && /^0x[0-9a-fA-F]{40}$/.test(proven) ? proven.toLowerCase() : null;
  const session = resolveSession(req);
  return session ? session.address.toLowerCase() : null;
}

function requireWallet(req: FastifyRequest, reply: FastifyReply): string | null {
  let wallet: string | null;
  try {
    wallet = verifiedWallet(req);
  } catch {
    void reply.code(503).send({ error: "store_unavailable", message: "Sessions cannot be checked without the store." });
    return null;
  }
  if (wallet === null) {
    void reply.code(401).send({
      error: "verified_wallet_required",
      message: "This action changes who is paid or what is owned, so it needs a wallet proven by a SIWE signature. An API key alone is not proof of identity.",
      siwe: SIWE_STEPS,
    });
  }
  return wallet;
}

/** The operator of a kernel, lowercase, or null when the kernel is unknown. */
function kernelOperator(kernelId: string): string | null {
  const kernel = getRepos().kernels.findById(kernelId);
  return kernel ? kernel.operatorAddress.toLowerCase() : null;
}

/**
 * The recorded owner of an IP, from durable records only:
 *   - a capability IP → the operator of the capability's kernel;
 *   - a job-evidence IP → the operator of the job's kernel (exactly one linked job).
 * null means no owner is recorded. Throws only if the store itself is unavailable.
 */
export function recordedIpOwner(ipId: string): string | null {
  const repos = getRepos();
  const reg = repos.story.findIpById(ipId);
  if (reg) {
    if (!reg.capabilityId) return null;
    const cap = repos.capabilities.findById(reg.capabilityId);
    return cap ? kernelOperator(cap.kernelId) : null;
  }
  const jobIds = new Set(
    repos.story
      .findDerivativeLinksByChild(ipId)
      .map((l) => l.jobId)
      .filter((j): j is string => typeof j === "string" && j.length > 0),
  );
  if (jobIds.size !== 1) return null;
  const job = repos.jobs.findById([...jobIds][0]!);
  return job ? kernelOperator(job.kernelId) : null;
}

/** An IP with a recorded owner. An ownerless record is not enough: nobody could manage or claim it. */
function hasRecordedOwner(ipId: string): boolean {
  return recordedIpOwner(ipId) !== null;
}

/** Story real mode (STORY_MOCK=false), where the service would sign with the GATEWAY's key. */
function storyRealMode(): boolean {
  return process.env.STORY_MOCK === "false";
}

const GATEWAY_NEVER_PAYS = {
  error: "not_executed",
  message:
    "In Story real mode the gateway would pay this royalty from its own wallet on the caller's behalf. PCC does not; " +
    "a payer's own on-chain payment path is an operator decision (queue G). Nothing was paid.",
};

/**
 * The caller must be the IP's recorded owner. Replies (401/403/503) and returns null otherwise.
 * An IP with no recorded owner is refused: an owner check fails CLOSED on a missing owner.
 */
function requireIpOwner(req: FastifyRequest, reply: FastifyReply, ipId: string): string | null {
  const wallet = requireWallet(req, reply);
  if (wallet === null) return null;
  let owner: string | null;
  try {
    owner = recordedIpOwner(ipId);
  } catch {
    void reply.code(503).send({ error: "store_unavailable", message: "IP ownership cannot be checked without the store." });
    return null;
  }
  if (owner === null) {
    void reply.code(403).send({
      error: "ip_owner_unknown",
      message: `No owner is recorded for IP ${ipId}, so nobody may change it. Ownership comes from a registration made by the operator of the capability's (or job's) kernel.`,
    });
    return null;
  }
  if (owner !== wallet) {
    void reply.code(403).send({ error: "not_ip_owner", message: `Only the owner of IP ${ipId} may do this.` });
    return null;
  }
  return wallet;
}

/**
 * Story's real mode refuses operations it cannot execute with `code: "STORY_NOT_EXECUTED"`
 * (StoryNotExecutedError, pcc-economics N10b). That is an honest "not available", not a server fault:
 * answer 501 so no client mistakes it for a transient error or for a result.
 */
function isStoryNotExecuted(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "STORY_NOT_EXECUTED";
}

function storyFailure(reply: FastifyReply, err: unknown, error: string) {
  if (isStoryNotExecuted(err)) {
    return reply.code(501).send({ error: "not_executed", message: err instanceof Error ? err.message : String(err) });
  }
  return reply.code(500).send({ error, message: err instanceof Error ? err.message : String(err) });
}

/** A positive integer amount in base units, as a canonical decimal string. */
function isBaseUnitAmount(v: unknown): v is string {
  return typeof v === "string" && /^[1-9][0-9]{0,77}$/.test(v);
}

/** Decimals of the currencies PCC escrows settle in. Anything else is refused, never guessed. */
const ESCROW_CURRENCY_DECIMALS: Readonly<Record<string, number>> = { USDC: 6 };

/**
 * The escrow milestone that settles a job: the job's step in the escrow of the job's OWN workflow.
 * There is no fallback across workflows: another workflow's released milestone and payer must never
 * settle this job (coord-watch #2974). A job whose workflow id matches no escrow is not settleable.
 */
function findJobMilestone(job: { cwmId: string; stepId: string }):
  | { escrow: { id: string; payer: string; currency: string }; milestone: { stepId: string; amount: string; status: string } }
  | "none"
  | "ambiguous" {
  const repos = getRepos();
  const escrow = repos.escrows.findByCwm(job.cwmId);
  if (!escrow) return "none";
  const ms = repos.escrows.findMilestonesByEscrow(escrow.id).filter((m) => m.stepId === job.stepId);
  if (ms.length === 0) return "none";
  if (ms.length > 1) return "ambiguous";
  return { escrow, milestone: ms[0]! };
}

// ── Once-only settlement (a durable claim in the append-only audit log) ─────
//
// A settlement of (jobId, childIpId) is claimed by an audit event written synchronously, before the
// first payment call, so no other request in this process can interleave between the check and the
// claim. A claim is permanent once anything was paid. A partial failure needs operator repair; it is
// never retried automatically, because that would pay the paid rows twice. If nothing was paid, a
// release event lets the settlement be tried again.

const SETTLEMENT_EVENT = "ip.royalties.settlement";

function activeSettlementClaims(jobId: string, childIpId: string): number {
  const rows = getRepos()
    .auditLog.query({ eventType: SETTLEMENT_EVENT, resourceType: "job", limit: Number.MAX_SAFE_INTEGER })
    .filter((r) => r.resourceId === jobId && (r.metadata as { childIpId?: unknown } | null)?.childIpId === childIpId);
  const claims = rows.filter((r) => r.action === "claim").length;
  const releases = rows.filter((r) => r.action === "release").length;
  return claims - releases;
}

function recordSettlement(action: "claim" | "release", jobId: string, childIpId: string, actor: string, metadata: Record<string, unknown>): void {
  getRepos().auditLog.insert({
    timestamp: new Date().toISOString(),
    eventType: SETTLEMENT_EVENT,
    actor,
    resourceType: "job",
    resourceId: jobId,
    action,
    metadata: { childIpId, ...metadata },
    ip: null,
    userAgent: null,
  });
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
      const { capability, designerAddress, designerName, commercialRevShare, ipfsCid } = req.body ?? ({} as RegisterCapabilityBody);

      if (!capability?.id || !capability?.name || !capability?.type || !capability?.kernelId) {
        return reply.code(400).send({ error: "capability.id, capability.name, capability.type, and capability.kernelId are required" });
      }
      if (!designerAddress || !designerName) {
        return reply.code(400).send({ error: "designerAddress and designerName are required" });
      }

      // Only the operator of the capability's kernel may register it, and the IP is minted to the
      // caller's own proven wallet: ownership never comes from the body.
      const wallet = requireWallet(req, reply);
      if (wallet === null) return reply;
      if (designerAddress.toLowerCase() !== wallet) {
        return reply.code(403).send({ error: "designer_must_be_caller", message: "designerAddress must be your own signed-in wallet." });
      }
      let repos: ReturnType<typeof getRepos>;
      try {
        repos = getRepos();
      } catch {
        return reply.code(503).send({ error: "store_unavailable", message: "A capability cannot be registered as IP without the store." });
      }
      const cap = repos.capabilities.findById(capability.id);
      if (!cap || cap.kernelId !== capability.kernelId) {
        return reply.code(404).send({
          error: "capability_not_found",
          message: `Capability ${capability.id} is not registered on kernel ${capability.kernelId}. Register the capability first; its kernel's operator is its IP's owner.`,
        });
      }
      if (kernelOperator(cap.kernelId) !== wallet) {
        return reply.code(403).send({ error: "not_kernel_operator", message: `Only the operator of kernel ${cap.kernelId} may register its capabilities as IP.` });
      }

      try {
        const reg = await svc.registerCapabilityAsIP(capability, {
          designerAddress: wallet,
          designerName,
          commercialRevShare,
          ipfsCid,
        });

        // The registration row IS the ownership record (capability → kernel → operator), so it is
        // not best-effort: an IP with no record would have no owner.
        try {
          repos.story.insertIpRegistration({
            ipId: reg.ipId,
            nftTokenId: reg.nftTokenId,
            licenseTermsId: reg.licenseTermsId,
            txHash: reg.txHash,
            capabilityId: cap.id,
            csdUrl: reg.csdUrl,
            chain: reg.chain,
            registeredAt: reg.registeredAt,
          });
        } catch (dbErr) {
          auditService.log({ eventType: "ip.registration_unrecorded", actor: wallet, resourceType: "ip", resourceId: reg.ipId, action: "repair-needed", metadata: { capabilityId: cap.id } });
          return reply.code(500).send({
            error: "registration_not_recorded",
            message: `The IP was registered as ${reg.ipId} but could not be recorded, so it has no owner: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
          });
        }

        return { registration: reg };
      } catch (err) {
        return storyFailure(reply, err, "registration_failed");
      }
    },
  );

  // ── POST /api/ip/register-job-evidence ───────────────────────────────────

  app.post<{ Body: RegisterJobEvidenceBody }>(
    "/api/ip/register-job-evidence",
    async (req, reply) => {
      const { parentIpId, jobId, evidenceBundleHash, operatorAddress, operatorName, ipfsCid } = req.body ?? ({} as RegisterJobEvidenceBody);

      if (!parentIpId || !jobId || !evidenceBundleHash || !operatorAddress || !operatorName) {
        return reply.code(400).send({
          error: "parentIpId, jobId, evidenceBundleHash, operatorAddress, and operatorName are required",
        });
      }

      // Only the operator of the job's kernel may register its evidence, as themselves.
      const wallet = requireWallet(req, reply);
      if (wallet === null) return reply;
      if (operatorAddress.toLowerCase() !== wallet) {
        return reply.code(403).send({ error: "operator_must_be_caller", message: "operatorAddress must be your own signed-in wallet." });
      }
      let repos: ReturnType<typeof getRepos>;
      try {
        repos = getRepos();
      } catch {
        return reply.code(503).send({ error: "store_unavailable", message: "Job evidence cannot be registered as IP without the store." });
      }
      const job = repos.jobs.findById(jobId);
      if (!job) return reply.code(404).send({ error: "job_not_found", message: `Job ${jobId} is not recorded.` });
      if (kernelOperator(job.kernelId) !== wallet) {
        return reply.code(403).send({ error: "not_kernel_operator", message: `Only the operator of kernel ${job.kernelId} may register this job's evidence.` });
      }
      // The parent is the IP of the capability this job ran, and nothing else (coord-watch #2974).
      const capabilityIp = repos.story.findIpByCapabilityId(job.capabilityId);
      if (!capabilityIp || capabilityIp.ipId !== parentIpId) {
        return reply.code(409).send({
          error: "parent_not_job_capability",
          message: `Job ${job.id}'s evidence derives from the IP of its own capability ${job.capabilityId}, not from ${parentIpId}.`,
        });
      }

      try {
        const link = await svc.registerJobAsDerivative(parentIpId, {
          jobId: job.id,
          evidenceBundleHash,
          operatorAddress: wallet,
          operatorName,
          ipfsCid,
        });

        // The link row IS the ownership record for the child IP (job → kernel → operator).
        try {
          repos.story.insertDerivativeLink({
            id: uuidv4(),
            parentIpId: link.parentIpId,
            childIpId: link.childIpId,
            licenseTokenId: link.licenseTokenId,
            jobId: job.id,
            evidenceBundleHash: link.evidenceBundleHash,
            txHash: link.txHash,
            linkedAt: link.linkedAt,
          });
        } catch (dbErr) {
          auditService.log({ eventType: "ip.derivative_unrecorded", actor: wallet, resourceType: "ip", resourceId: link.childIpId, action: "repair-needed", metadata: { jobId: job.id, parentIpId } });
          return reply.code(500).send({
            error: "derivative_not_recorded",
            message: `The derivative ${link.childIpId} was registered but could not be recorded, so it has no owner: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
          });
        }

        return { link };
      } catch (err) {
        return storyFailure(reply, err, "derivative_registration_failed");
      }
    },
  );

  // ── POST /api/ip/distribute-royalties ────────────────────────────────────

  app.post<{ Body: DistributeRoyaltiesBody }>(
    "/api/ip/distribute-royalties",
    async (req, reply) => {
      const { ipId, splits } = req.body ?? ({} as DistributeRoyaltiesBody);

      if (!ipId || !splits || !Array.isArray(splits) || splits.length === 0) {
        return reply.code(400).send({ error: "ipId and splits (non-empty array) are required" });
      }
      // Who gets paid is the owner's decision alone.
      if (requireIpOwner(req, reply, ipId) === null) return reply;

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
        return storyFailure(reply, err, "distribute_royalties_failed");
      }
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
      const wallet = requireIpOwner(req, reply, body.ipId);
      if (wallet === null) return reply;
      if (body.designerAddress.toLowerCase() !== wallet) {
        return reply.code(403).send({ error: "designer_must_be_caller", message: "designerAddress must be your own signed-in wallet." });
      }

      const terms: LicensingTerms = {
        id: uuidv4(),
        ipId: body.ipId,
        designerAddress: wallet,
        autoLicense: body.autoLicense,
        standingOffers: body.standingOffers ?? [],
        defaultRevShare: body.defaultRevShare ?? 5,
        allowSubDerivatives: body.allowSubDerivatives ?? true,
        derivativeDecayRate: body.derivativeDecayRate ?? 0.5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      engine.setTerms(body.ipId, terms);
      return { terms };
    },
  );

  // ── POST /api/ip/settle-royalties ─────────────────────────────────────────

  app.post<{ Body: SettleRoyaltiesBody }>(
    "/api/ip/settle-royalties",
    async (req, reply) => {
      const { jobId, childIpId, jobRevenue, payerAddress } = req.body ?? ({} as SettleRoyaltiesBody);

      if (!jobId || !childIpId) {
        return reply.code(400).send({ error: "jobId and childIpId are required" });
      }
      const wallet = requireWallet(req, reply);
      if (wallet === null) return reply;

      let repos: ReturnType<typeof getRepos>;
      try {
        repos = getRepos();
      } catch {
        return reply.code(503).send({ error: "store_unavailable", message: "Royalties cannot be settled without settlement state." });
      }
      const job = repos.jobs.findById(jobId);
      if (!job) return reply.code(404).send({ error: "job_not_found", message: `Job ${jobId} is not recorded.` });

      // The job's settlement, from server state only.
      const found = findJobMilestone(job);
      if (found === "none") {
        return reply.code(409).send({ error: "no_settlement_record", message: `Job ${jobId} has no escrow milestone.` });
      }
      if (found === "ambiguous") {
        return reply.code(409).send({ error: "settlement_ambiguous", message: `More than one escrow milestone matches job ${jobId}; nothing is settled.` });
      }
      const { escrow, milestone } = found;

      // Only a party to the job: its buyer (the escrow's payer) or its kernel's operator.
      const parties = new Set([escrow.payer.toLowerCase(), kernelOperator(job.kernelId)].filter((x): x is string => x !== null));
      if (!parties.has(wallet)) {
        return reply.code(403).send({ error: "not_job_party", message: `Only the buyer or the operator of job ${jobId} may settle its royalties.` });
      }
      if (milestone.status !== "released") {
        return reply.code(409).send({
          error: "milestone_not_released",
          message: `Job ${jobId}'s milestone is "${milestone.status}". Royalties are settled only on revenue that was actually released.`,
        });
      }

      // Revenue and payer are the released milestone's, in base units; the body can only agree.
      const decimals = ESCROW_CURRENCY_DECIMALS[escrow.currency];
      if (decimals === undefined) {
        return reply.code(409).send({ error: "unsupported_currency", message: `Escrow currency "${escrow.currency}" has no known decimals; nothing is settled.` });
      }
      let revenue: string;
      try {
        revenue = parseUnits(milestone.amount, decimals).toString();
      } catch {
        return reply.code(409).send({ error: "revenue_unreadable", message: `The milestone amount "${milestone.amount}" is not a ${escrow.currency} amount.` });
      }
      if (jobRevenue !== undefined && jobRevenue !== revenue) {
        return reply.code(409).send({ error: "revenue_mismatch", message: `The released revenue for job ${jobId} is ${revenue} base units, not ${jobRevenue}.`, revenue });
      }
      if (payerAddress !== undefined && payerAddress.toLowerCase() !== escrow.payer.toLowerCase()) {
        return reply.code(409).send({ error: "payer_mismatch", message: `Job ${jobId} was paid by its escrow's payer, not ${payerAddress}.` });
      }
      // The child IP must be this job's own evidence.
      if (!repos.story.findDerivativeLinksByJob(job.id).some((l) => l.childIpId === childIpId)) {
        return reply.code(409).send({ error: "ip_not_linked_to_job", message: `IP ${childIpId} is not the registered evidence of job ${jobId}.` });
      }

      if (storyRealMode()) return reply.code(501).send(GATEWAY_NEVER_PAYS);

      let distributions: ReturnType<typeof engine.getRoyaltyDistribution>;
      try {
        distributions = engine.getRoyaltyDistribution(childIpId, revenue);
      } catch (err) {
        return storyFailure(reply, err, "settle_royalties_failed");
      }
      const payable = distributions.filter((d) => d.amount !== "0");
      if (payable.length > 0) {
        // Check and claim with no await in between: once-only within this process.
        try {
          if (activeSettlementClaims(job.id, childIpId) > 0) {
            return reply.code(409).send({
              error: "already_settled",
              message: `Royalties for job ${jobId} and IP ${childIpId} were already settled, or a settlement is being repaired. They are never paid twice.`,
            });
          }
          recordSettlement("claim", job.id, childIpId, wallet, { revenue, payer: escrow.payer, rows: payable.length });
        } catch {
          return reply.code(503).send({ error: "store_unavailable", message: "A settlement cannot be recorded, so nothing is paid." });
        }
      }

      // Every row reports its own outcome. A failed row fails the request: nothing is swallowed.
      type Row =
        | { ipId: string; recipientAddress: string; amount: string; outcome: "paid"; txHash: string }
        | { ipId: string; recipientAddress: string; amount: string; outcome: "failed"; error: string };
      const rows: Row[] = [];
      let totalDistributed = 0n;
      let notExecuted = 0;
      for (const dist of distributions) {
        if (dist.amount === "0") continue;
        try {
          const { txHash } = await svc.payJobRoyalty(dist.ipId, dist.amount, escrow.payer);
          rows.push({ ipId: dist.ipId, recipientAddress: dist.recipientAddress, amount: dist.amount, outcome: "paid", txHash });
          totalDistributed += BigInt(dist.amount);
        } catch (err) {
          if (isStoryNotExecuted(err)) notExecuted++;
          rows.push({ ipId: dist.ipId, recipientAddress: dist.recipientAddress, amount: dist.amount, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
        }
      }
      const failed = rows.filter((r) => r.outcome === "failed").length;
      if (payable.length > 0 && rows.every((r) => r.outcome === "failed")) {
        // Nothing was paid: release the claim so the settlement can be tried again.
        try {
          recordSettlement("release", job.id, childIpId, wallet, { reason: "nothing paid" });
        } catch {
          /* the claim stands: a later attempt is refused, which is the safe side */
        }
      }
      const result = { jobId, childIpId, revenue, payerAddress: escrow.payer, distributions: rows, totalDistributed: String(totalDistributed) };
      if (failed > 0 && failed === rows.length && notExecuted === failed) {
        // Story's real mode executed none of it: not available, rather than a partial failure.
        return reply.code(501).send({ error: "not_executed", message: "Story did not execute any royalty payment; nothing was paid.", ...result });
      }
      if (failed > 0) {
        return reply.code(502).send({
          error: "settlement_incomplete",
          message: `${failed} of ${rows.length} royalty payments failed; the rows say which were paid.`,
          ...result,
        });
      }
      return result;
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
      return { terms };
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
        };
      } catch (err) {
        return storyFailure(reply, err, "derivative_tree_failed");
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
        return { ipId, amount, distributions };
      } catch (err) {
        return storyFailure(reply, err, "royalty_distribution_failed");
      }
    },
  );

  // ── POST /api/ip/:ipId/pay ────────────────────────────────────────────────

  app.post<{ Params: IpIdParams; Body: PayRoyaltyBody }>(
    "/api/ip/:ipId/pay",
    async (req, reply) => {
      const { ipId } = req.params;
      const { amount, payerAddress } = req.body ?? ({} as PayRoyaltyBody);

      if (!isBaseUnitAmount(amount)) {
        return reply.code(400).send({ error: "amount is required, as a positive integer in base units" });
      }
      // Anyone may pay into an IP's vault, but only as themselves.
      const wallet = requireWallet(req, reply);
      if (wallet === null) return reply;
      if (payerAddress !== undefined && payerAddress.toLowerCase() !== wallet) {
        return reply.code(403).send({ error: "payer_must_be_caller", message: "You can only pay as your own signed-in wallet." });
      }
      try {
        if (!hasRecordedOwner(ipId)) {
          return reply.code(403).send({ error: "ip_owner_unknown", message: `IP ${ipId} has no recorded owner, so nobody could claim what is paid into it.` });
        }
      } catch {
        return reply.code(503).send({ error: "store_unavailable", message: "The IP cannot be looked up without the store." });
      }
      if (storyRealMode()) return reply.code(501).send(GATEWAY_NEVER_PAYS);

      try {
        const result = await svc.payJobRoyalty(ipId, amount, wallet);
        return result;
      } catch (err) {
        return storyFailure(reply, err, "pay_royalty_failed");
      }
    },
  );

  // ── POST /api/ip/:ipId/claim ──────────────────────────────────────────────

  app.post<{ Params: IpIdParams; Body: ClaimRevenueBody }>(
    "/api/ip/:ipId/claim",
    async (req, reply) => {
      const { ipId } = req.params;
      const { tokenIds } = req.body ?? {};
      // Only the IP's owner claims its vault, and the claim records who claimed it.
      const wallet = requireIpOwner(req, reply, ipId);
      if (wallet === null) return reply;

      try {
        const result = await svc.claimRevenue(ipId, tokenIds);

        // Persist claim to DB (best-effort)
        try {
          const repos = getRepos();
          repos.story.insertRevenueClaim({
            id: uuidv4(),
            ipId,
            claimerAddress: wallet,
            amount: result.claimed,
            txHash: result.txHash,
            claimedAt: new Date().toISOString(),
          });
        } catch (dbErr) {
          console.warn("[ip] DB persist of revenue claim failed (best-effort):", dbErr instanceof Error ? dbErr.message : dbErr);
        }

        return result;
      } catch (err) {
        return storyFailure(reply, err, "claim_revenue_failed");
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
        return storyFailure(reply, err, "revenue_snapshot_failed");
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
        return storyFailure(reply, err, "lineage_failed");
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
        return storyFailure(reply, err, "get_ip_registration_failed");
      }
    },
  );

  // ── POST /api/ip/:ipId/dispute ────────────────────────────────────────────

  app.post<{ Params: IpIdParams; Body: RaiseDisputeBody }>(
    "/api/ip/:ipId/dispute",
    async (req, reply) => {
      const { ipId } = req.params;
      const { evidenceHash, reason } = req.body ?? ({} as RaiseDisputeBody);

      if (!evidenceHash || !reason) {
        return reply.code(400).send({ error: "evidenceHash and reason are required" });
      }
      // A dispute is a claim against an IP, so its claimant is often not a party (for example the real
      // author of a copied design). Rule: any proven wallet may raise one against a recorded IP, and the
      // response names that wallet as the disputant. Story's dispute bond bounds abuse in real mode.
      const wallet = requireWallet(req, reply);
      if (wallet === null) return reply;
      try {
        if (!hasRecordedOwner(ipId)) {
          return reply.code(403).send({ error: "ip_owner_unknown", message: `IP ${ipId} has no recorded owner to answer a dispute.` });
        }
      } catch {
        return reply.code(503).send({ error: "store_unavailable", message: "The IP cannot be looked up without the store." });
      }

      try {
        const dispute = await svc.raiseDispute(ipId, { hash: evidenceHash, reason });
        return { dispute, raisedBy: wallet };
      } catch (err) {
        return storyFailure(reply, err, "raise_dispute_failed");
      }
    },
  );
}
