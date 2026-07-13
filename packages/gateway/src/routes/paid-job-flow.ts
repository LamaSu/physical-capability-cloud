/**
 * Paid Job Flow — end-to-end wiring from DHT discovery through settlement.
 *
 * This module connects the existing pieces:
 *   DHT discovery -> negotiation -> escrow -> scope -> execution -> evidence -> settlement
 *
 * Endpoints:
 *   POST /api/jobs/submit-from-discovery  — Fast-track: discovery straight to job+scope
 *   PUT  /api/jobs/:jobId/complete        — Job completion -> evidence -> settlement
 *   GET  /api/jobs/:jobId/settlement      — Settlement status for a job
 *
 * For testnet/demo: mock escrow (no real on-chain funding required).
 * Set MOCK_SETTLEMENT=false to require real escrow interactions.
 */

import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result, Signature } from "@pcc/spec";
import { createWalletClient, createPublicClient, http, keccak256, toBytes, decodeEventLog, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PCCProtocolABI, PCCProtocolV2ABI, getDeployment, getContractAddress } from "@pcc/contracts";
import { MilestoneEscrowV2ABI, MilestoneEscrowV3ABI, MockUSDCABI } from "@pcc/contracts/abi";
import { getStore, getRepos } from "../db.js";
import { getSettlementFacade } from "../facades/index.js";

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}
import { schema, eq, and, sql } from "@pcc/store";
import { getTemplate } from "@pcc/contract-builder";
import { TemplateResolver } from "@pcc/contract-builder";
import { PricingCalculator } from "@pcc/contract-builder";
import { applyPricingRules, sanitizeText } from "@pcc/kernel";
import { pipelineTelemetry } from "../telemetry.js";
import { getSettlementService } from "../services/settlement-service.js";
import { buildCanonicalEvidenceEnvelope } from "../services/evidence-envelope.js";
import { getKernelService } from "../services/kernel-service.js";
import { verifyWithOracle, buildEasAttestationMetadata } from "../services/oracle-client.js";
import { getEvidenceStorage, commitmentService, zkProofService } from "../services.js";
import { StarknetProofAnchoringService } from "@pcc/verifier";
import {
  submitAttestationV3,
  isWriteEnabled as escrowWriteEnabled,
  resolveMockUSDCAddress,
  createEscrowV3,
  approveAndReleaseV3,
  submitEvidenceV3,
  waitForReceipt,
  GAS_LIMITS,
} from "../contracts/escrow-client.js";
import { driveSettlement } from "../services/settlement-crank.js";
import {
  deviceEvidenceSettlementEnabled,
  resolveSettlementEvidence,
  isDeviceSignedSignature,
  registeredSignerInputFromColumns,
  naclEd25519Verify,
  type StoredSignature,
  type SettlementEvidenceSlot,
} from "../services/device-evidence-settlement.js";
import {
  sessionRevocationStore,
  type SessionRevocationRecord,
} from "../services/session-revocation-store.js";
import { withSignerLock } from "../contracts/signer-lock.js";
import type {
  OperatorPolicy,
  NegotiationSession,
  SessionStatus,
  SessionTransition,
  AssuranceTier,
} from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY, SESSION_TTL_MS } from "@pcc/spec";

const { negotiationSessions, operatorPolicies, executionScopes, toolCallRelay } = schema;

const resolver = new TemplateResolver();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether mock settlement is active (default: true for testnet).
 *  Exported so the negotiation /commit handler makes its "did real settlement
 *  actually wire an escrow?" decision from the SAME source of truth this module
 *  uses to pick the mock-vs-real escrow branch — the two must never disagree. */
export function isMockSettlement(): boolean {
  return process.env.MOCK_SETTLEMENT !== "false";
}

/** Coerce a possibly-loose value to a valid on-chain AssuranceTier (0-3).
 *  Never over-reports an SLA: NaN / out-of-range → 0. */
function toTier(v: unknown): AssuranceTier {
  const n = Math.trunc(Number(v));
  return (Number.isFinite(n) && n >= 0 && n <= 3 ? n : 0) as AssuranceTier;
}

/**
 * Whether to route settlement through the EAS-gated MilestoneEscrowV2 path.
 * Default OFF — the V1 flow stays the default so existing callers are unaffected.
 * Opt in per-deployment with PCC_USE_EAS_V2=true.
 */
function useEasV2(): boolean {
  return process.env.PCC_USE_EAS_V2 === "true";
}

/**
 * Whether to route settlement through the MilestoneEscrowV3 Mode-A path
 * (payer-approval, oracle-free). Default OFF. Opt in per-deployment with
 * PCC_USE_V3_MODE_A=true.
 *
 * Mode A is the gateway-driven ceremony where payer == arbiter == operator ==
 * the gateway signer, so the gateway holds the payer key and settles via
 * approveAndRelease itself — no oracle attestation, no EAS bridge, no challenge
 * window, no protocol fee. Takes precedence over useEasV2() when both are set
 * (a deployment picks one settlement rail). The V1/V2 branches are untouched.
 */
function useV3ModeA(): boolean {
  return process.env.PCC_USE_V3_MODE_A === "true";
}

/** Resolve chain ID from PCC_NETWORK env var */
function resolveChainId(): number {
  const network = process.env.PCC_NETWORK ?? "base-sepolia";
  const chainIds: Record<string, number> = {
    "base-sepolia": 84532,
    "flow-evm-testnet": 545,
    sepolia: 11155111,
    base: 8453,
    localhost: 31337,
  };
  return chainIds[network] ?? 84532;
}

/** Default write tools for common device types */
const DEVICE_WRITE_TOOLS: Record<string, string[]> = {
  "liquid-handler": [
    "ot2_run_protocol",
    "ot2_aspirate",
    "ot2_dispense",
    "ot2_pick_up_tip",
    "ot2_drop_tip",
    "ot2_move_to",
    "ot2_mix",
    "ot2_blow_out",
    "ot2_touch_tip",
    "ot2_transfer",
  ],
  "fdm-printer": [
    "printer_start_job",
    "printer_pause",
    "printer_resume",
    "printer_cancel",
    "printer_set_temperature",
  ],
  "cnc-mill": [
    "cnc_start_program",
    "cnc_pause",
    "cnc_resume",
    "cnc_cancel",
    "cnc_set_speed",
  ],
};

/** Get write tools for a device type, falling back to a generic set */
function getWriteToolsForDeviceType(capabilityType: string): string[] {
  return DEVICE_WRITE_TOOLS[capabilityType] ?? [
    "device_start_job",
    "device_pause",
    "device_resume",
    "device_cancel",
  ];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Pull the newly-created escrow address out of a tx receipt's EscrowCreated
 * event. Both PCCProtocol (V1) and PCCProtocolV2 emit EscrowCreated with
 * `escrow` as the first indexed param, so decodeEventLog gives a layout-safe
 * read instead of a positional topics[1] slice. Throws a descriptive error if
 * no EscrowCreated log decodes or the decoded address is zero — a silent
 * zero-address escrow would poison every downstream settlement step.
 */
function extractEscrowCreatedAddress(
  logs: readonly { topics: readonly `0x${string}`[] | `0x${string}`[]; data: `0x${string}` }[],
  abi: typeof PCCProtocolV2ABI | typeof PCCProtocolABI,
): `0x${string}` {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName === "EscrowCreated") {
        const addr = (decoded.args as { escrow?: `0x${string}` }).escrow;
        if (addr && addr.toLowerCase() !== ZERO_ADDRESS) {
          return addr;
        }
      }
    } catch {
      // Not an EscrowCreated log (or doesn't match this ABI) — keep scanning.
    }
  }
  throw new Error(
    "createEscrow receipt had no decodable EscrowCreated log with a non-zero escrow address " +
      "(EscrowCreated topic layout may have changed, or the factory address/ABI is wrong)",
  );
}

/**
 * Create escrow + job + scope from a committed negotiation session.
 * This is the core wiring logic shared by the commit handler and the fast-track endpoint.
 */
/**
 * Resolve the per-operator payout address for a kernel (option A revenue routing).
 * Looks up the kernel's operator, then finds the api_keys row with the operator's
 * per-operator EOA (set by /api/auth/provision + best-effort setAgentWallet). If
 * none found, returns null so callers can fall back to the gateway signer
 * (preserves existing behavior for legacy operators not yet migrated).
 *
 * Cf. coord bulletin 235: without this, V3 releases route funds to the gateway
 * signer (self-pay). With this, funds route to the operator's operational EOA.
 */
function resolveOperatorPayoutAddress(kernelId: string): `0x${string}` | null {
  try {
    const repos = getRepos();
    const kernel = repos.kernels.findById(kernelId);
    if (!kernel?.operatorAddress) return null;
    const keys = repos.apiKeys.findByOperator(kernel.operatorAddress);
    for (const k of keys) {
      const addr = (k as { operatorWalletAddress?: string | null }).operatorWalletAddress;
      if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
        return addr as `0x${string}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function createJobFromSession(
  session: typeof negotiationSessions.$inferSelect,
): Promise<{
  jobId: string;
  scopeId: string;
  escrowId: string;
  escrowAddress: string;
  escrowStatus: string;
}> {
  const repos = getRepos();
  const { db } = getStore();
  const now = new Date().toISOString();

  const quote = session.quote as Record<string, unknown> | null;
  const contractTerms = session.contractTerms as Record<string, unknown> | null;
  const milestones = (contractTerms?.milestones ?? []) as Array<{
    stepId: string;
    amount: string;
    bondAmount: string;
    challengeWindowSeconds: number;
  }>;

  const totalPriceForMs = (quote?.totalPrice as string) ?? "10.00";
  const assuranceTier = Number((contractTerms?.assuranceTier as number | undefined) ?? 0);

  // Normalize the milestone set ONCE so the on-chain V2 escrow, the DB rows, and
  // the job all reference the same milestones. When contract terms define none,
  // synthesize a single full-amount milestone (mirrors the historical DB default).
  const normalizedMilestones: Array<{
    stepId: string;
    amount: string;
    bondAmount: string;
    challengeWindowSeconds: number;
  }> = milestones.length > 0
    ? milestones
    : [{
        stepId: `step-${crypto.randomUUID().slice(0, 8)}`,
        amount: totalPriceForMs,
        bondAmount: (quote?.bondAmount as string) ?? "0.00",
        challengeWindowSeconds: 0,
      }];

  // Job id is needed BEFORE escrow creation so V2 milestones can bind it on-chain
  // (keccak256(bytes(jobId)) is stored per-milestone for EAS payload validation).
  const jobId = session.jobId ?? `job-${crypto.randomUUID().slice(0, 12)}`;

  // ── 1. Create or reference escrow ──────────────────────────────────
  const escrowId = `esc-${crypto.randomUUID().slice(0, 12)}`;
  let escrowAddress: string;
  let escrowStatus: string;

  if (isMockSettlement()) {
    escrowAddress = `mock-escrow-${Date.now().toString(36)}`;
    escrowStatus = "funded";
  } else {
    // Real on-chain escrow via PCCProtocol factory
    const network = process.env.PCC_NETWORK ?? "base-sepolia";
    const pk = process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}` | undefined;
    if (!pk) throw new Error("PCC_GATEWAY_PRIVATE_KEY required for real settlement");

    const deployment = getDeployment(network);
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({
      account,
      chain: deployment.chain,
      transport: http(deployment.rpcUrl),
    });
    const publicClient = createPublicClient({
      chain: deployment.chain,
      transport: http(deployment.rpcUrl),
    });

    // Token: chain-config mockUSDC for this network FIRST (the token the payer
    // actually holds), with MOCK_USDC_ADDRESS env as a fallback only where
    // chain-config has no token (e.g. localhost). resolveMockUSDCAddress is the
    // SAME resolver approveToken uses, so the escrow's `_token`, the approve
    // target, and the fund pull all reference one token. A polluted env
    // (MOCK_USDC_ADDRESS = Flow-EVM 0x5f2eb54d… on base-sepolia) no longer wins
    // and strands fund() against a token the payer holds 0 of. Both V1
    // createEscrow and V2 createEscrowV2 take the same (payer, arbiter, token,
    // cwmId) shape; only the factory + fn name differ.
    const tokenAddr = resolveMockUSDCAddress(network);
    if (!tokenAddr) {
      throw new Error(
        `No MockUSDC token resolvable for network ${network} ` +
          `(no chain-config mockUSDC and MOCK_USDC_ADDRESS env unset)`,
      );
    }
    const cwmIdBytes = keccak256(toBytes(`pcc-session-${session.id}-${Date.now()}`));

    if (useV3ModeA()) {
      // ── V3 Mode-A (payer-approval, oracle-free) ─────────────────────────
      // Deploy a MilestoneEscrowV3 clone via the V3 factory, add each milestone
      // (V2 ABI works on V3 — identical addMilestone shape), THEN fund the escrow
      // upfront (approveToken + fund) so it is ready for approveAndRelease at
      // /complete. payer == arbiter == operator == the gateway signer, same as V2.
      // Funding upfront (unlike V1/V2, which fund elsewhere) matches Mode A: the
      // gateway holds the payer key and releases its own escrowed USDC on approval.
      // Per-env V3 factory override (staging isolation): a non-prod deployment can
      // point at its OWN factory — one bound to a throwaway staging oracle — via
      // MILESTONE_ESCROW_FACTORY_V3, so the prod oracle trust root is never shared
      // across environments. Falls back to the chain-config (prod) address when unset.
      // See docs/ORACLE-TRUST-ARCHITECTURE.md.
      const factoryAddrV3 =
        (process.env.MILESTONE_ESCROW_FACTORY_V3 as `0x${string}` | undefined) ??
        getContractAddress(network, "milestoneEscrowFactoryV3");

      let totalFundAmount = 0n;
      for (const ms of normalizedMilestones) {
        totalFundAmount += parseUnits(ms.amount, 6);
      }

      escrowAddress = await withSignerLock(async () => {
        // createEscrowV3 handles the factory write + EscrowCreated decode.
        const addr = await createEscrowV3(
          account.address, // payer  = gateway signer
          account.address, // arbiter = gateway signer
          tokenAddr,
          cwmIdBytes,
          factoryAddrV3,
        );
        console.log(
          `[paid-job] Created on-chain V3 (Mode A) escrow: ${addr} (token: ${tokenAddr})`,
        );

        // Add each milestone (V2 ABI is byte-identical on V3). Operator payout
        // address prefers the per-operator EOA from option A (revenue routes to
        // the operator's own wallet, not the gateway signer). Falls back to
        // account.address for legacy operators that haven't been minted A yet.
        // requiredTier is carried for parity; Mode A ignores it at release.
        const v3OperatorPayout =
          resolveOperatorPayoutAddress(session.kernelId) ?? account.address;
        for (const ms of normalizedMilestones) {
          const stepIdBytes = keccak256(toBytes(ms.stepId));
          const addTx = await walletClient.writeContract({
            address: addr as `0x${string}`,
            abi: MilestoneEscrowV2ABI,
            functionName: "addMilestone",
            args: [
              stepIdBytes,
              v3OperatorPayout,
              parseUnits(ms.amount, 6),
              parseUnits(ms.bondAmount ?? "0.00", 6),
              BigInt(ms.challengeWindowSeconds ?? 0),
              assuranceTier,
              jobId,
            ],
            gas: GAS_LIMITS.addMilestone,
          });
          const addReceipt = await publicClient.waitForTransactionReceipt({ hash: addTx, timeout: 90_000 });
          if (addReceipt.status !== "success") {
            throw new Error(
              `V3 addMilestone reverted (stepId=${ms.stepId}, tx=${addTx}, escrow ${addr})`,
            );
          }
          console.log(
            `[paid-job] V3 milestone added on-chain: stepId=${ms.stepId} amount=${ms.amount} (tx: ${addTx})`,
          );
        }

        // Fund the escrow upfront: approve the escrow to pull totalFundAmount of
        // the token, then fund(). Both use the MockUSDC / V2-fund ABIs which are
        // byte-identical on V3. The escrow is now settle-ready for /complete.
        const approveTx = await walletClient.writeContract({
          address: tokenAddr,
          abi: MockUSDCABI,
          functionName: "approve",
          args: [addr as `0x${string}`, totalFundAmount],
          gas: GAS_LIMITS.approve,
        });
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 90_000 });
        if (approveReceipt.status !== "success") {
          throw new Error(`V3 approve reverted (tx=${approveTx}, escrow ${addr})`);
        }

        const fundTx = await walletClient.writeContract({
          address: addr as `0x${string}`,
          abi: MilestoneEscrowV3ABI,
          functionName: "fund",
          args: [],
          gas: GAS_LIMITS.fund,
        });
        const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTx, timeout: 90_000 });
        if (fundReceipt.status !== "success") {
          throw new Error(`V3 fund reverted (tx=${fundTx}, escrow ${addr})`);
        }
        console.log(
          `[paid-job] V3 escrow ${addr} funded upfront (${normalizedMilestones.length} milestone(s), ${totalFundAmount} base units)`,
        );

        return addr;
      });
      escrowStatus = "funded";
    } else {

    // V2 (EAS): deploy an EAS-gated MilestoneEscrowV2 via the V2 factory.
    // V1 (default): legacy createEscrow on the V1 protocol. Branch-by-abstraction
    // on useEasV2() so existing deployments are untouched.
    const v2 = useEasV2();
    const factoryAddr = v2
      ? getContractAddress(network, "milestoneEscrowFactoryV2")
      : getContractAddress(network, "pccProtocol");
    const factoryAbi = v2 ? PCCProtocolV2ABI : PCCProtocolABI;
    const createFn = v2 ? "createEscrowV2" : "createEscrow";

    // P0-1 + P2 settlement robustness. Three layers, all needed because the hot
    // signer is shared and the public RPC is flaky:
    //   (P2) withSignerLock serializes the WHOLE create->addMilestone sequence so
    //        concurrent createJobFromSession requests can't read the same
    //        getTransactionCount(pending) and collide on the nonce window.
    //   (P0-1) explicit monotonic nonces WITHIN the locked sequence so create and
    //        addMilestone can't share a nonce on RPC propagation lag.
    //   (retry) if an addMilestone tx is DROPPED by the flaky RPC (receipt never
    //        arrives within the window), the escrow ends up with too few milestones.
    //        Retrying the milestone alone risks a duplicate (the dropped tx could
    //        still mine), so we ABANDON the empty escrow and mint a FRESH one.
    //        Abandoned escrows are inert (never funded, never referenced). A reverted
    //        tx (vs a drop) is a real contract error and throws immediately.
    const MAX_CREATE_ATTEMPTS = 3;
    escrowAddress = await withSignerLock(async () => {
      let lastAddr = "";
      for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
        let nonce = await publicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });

        const txHash = await walletClient.writeContract({
          address: factoryAddr,
          abi: factoryAbi,
          functionName: createFn,
          args: [account.address, account.address, tokenAddr, cwmIdBytes],
          nonce: nonce++,
          gas: GAS_LIMITS.createEscrow,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        const addr = extractEscrowCreatedAddress(receipt.logs, factoryAbi as typeof PCCProtocolV2ABI);
        lastAddr = addr;
        console.log(
          `[paid-job] Created on-chain ${v2 ? "V2 (EAS) " : ""}escrow: ${addr} (tx: ${txHash}, token: ${tokenAddr}, attempt ${attempt}/${MAX_CREATE_ATTEMPTS})`,
        );

        // V1 has no on-chain milestones to add — the escrow IS the result.
        if (!v2) return addr;

        // createEscrowV2 mints an EMPTY escrow; without >=1 milestone fund() reverts.
        // Add each milestone in sequence on the same (locked) signer, BEFORE fund().
        // Operator payout prefers the per-operator EOA from option A (revenue
        // routes to the operator, not the gateway); falls back to account.address
        // for legacy operators. Cf. coord bulletin 235.
        const v2OperatorPayout =
          resolveOperatorPayoutAddress(session.kernelId) ?? account.address;
        let dropped = false;
        for (const ms of normalizedMilestones) {
          const stepIdBytes = keccak256(toBytes(ms.stepId));
          const addTx = await walletClient.writeContract({
            address: addr as `0x${string}`,
            abi: MilestoneEscrowV2ABI,
            functionName: "addMilestone",
            args: [
              stepIdBytes,
              v2OperatorPayout,
              parseUnits(ms.amount, 6),
              parseUnits(ms.bondAmount ?? "0.00", 6),
              BigInt(ms.challengeWindowSeconds ?? 0),
              assuranceTier, // requiredTier (0-3); the smoke quote uses tier 0
              jobId,
            ],
            nonce: nonce++,
            gas: GAS_LIMITS.addMilestone,
          });
          // Drop vs revert: a dropped tx never produces a receipt -> waitForTransactionReceipt
          // times out (caught -> retry with a fresh escrow). A mined-but-reverted tx is a real
          // contract error -> throw immediately.
          let addReceipt;
          try {
            addReceipt = await publicClient.waitForTransactionReceipt({ hash: addTx, timeout: 90_000 });
          } catch {
            dropped = true;
            break;
          }
          if (addReceipt.status !== "success") {
            throw new Error(
              `addMilestone reverted (stepId=${ms.stepId}, tx=${addTx}, escrow ${addr})`,
            );
          }
          console.log(
            `[paid-job] V2 milestone added on-chain: stepId=${ms.stepId} amount=${ms.amount} tier=${assuranceTier} (tx: ${addTx})`,
          );
        }

        if (!dropped) {
          // Every addMilestone receipt mined with status "success" -> the milestones
          // ARE on-chain. Do NOT re-read getMilestoneCount to "confirm": the public
          // load-balanced RPC serves reads from a replica that lags the just-mined
          // write, returning a phantom 0 that falsely abandons a VALID escrow (verified
          // 2026-06-15 — 4/4 such "abandoned" escrows read getMilestoneCount=1 on-chain
          // moments later). The mined receipts are the authoritative confirmation;
          // read-lag is a consumer concern (/state + the smoke poll the count).
          console.log(
            `[paid-job] V2 escrow ${addr}: ${normalizedMilestones.length} milestone(s) added, receipts confirmed (attempt ${attempt}/${MAX_CREATE_ATTEMPTS})`,
          );
          return addr;
        }

        // Only reached when an addMilestone tx was genuinely DROPPED (its receipt timed
        // out) -> that escrow is missing a milestone, so abandon it and mint a fresh one.
        console.warn(
          `[paid-job] escrow ${addr} had a dropped addMilestone tx (attempt ${attempt}/${MAX_CREATE_ATTEMPTS}) — retrying with a fresh escrow`,
        );
      }
      throw new Error(
        `createEscrowV2 + addMilestone could not land milestones after ${MAX_CREATE_ATTEMPTS} attempts ` +
          `(last escrow ${lastAddr}). The signer-lock serialized the writes but the RPC kept dropping txs — ` +
          `a dedicated RPC with failover is the durable fix (board P2).`,
      );
    });
    escrowStatus = "created";
    } // end V1/V2 branch (else of useV3ModeA)
  }

  const totalPrice = quote?.totalPrice as string ?? "10.00";
  const currency = quote?.currency as string ?? "USDC";
  const deadline = (contractTerms?.deadline as string) ?? new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  repos.escrows.insert({
    id: escrowId,
    cwmId: session.cwmId ?? `cwm-${crypto.randomUUID().slice(0, 12)}`,
    contractAddress: escrowAddress,
    payer: session.userAgentId,
    totalAmount: totalPrice,
    currency,
    status: escrowStatus,
    createdAt: now,
    deadline,
    // V3 dispatch: settled-later routes/facades read this and pick the V3
    // write helpers (submitAttestationV3 / releaseMilestoneV3) vs V2.
    version: useV3ModeA() ? "v3" : "v2",
  });

  // Insert milestones (DB rows mirror the normalized set used on-chain above).
  for (const ms of normalizedMilestones) {
    repos.escrows.insertMilestone({
      id: `ms-${crypto.randomUUID().slice(0, 12)}`,
      escrowId,
      stepId: ms.stepId,
      amount: ms.amount,
      status: escrowStatus === "funded" ? "funded" : "pending",
      bondAmount: ms.bondAmount,
    });
  }

  // ── 2. Create the job ──────────────────────────────────────────────
  // (jobId was computed above, before escrow creation, so V2 milestones could
  // bind it on-chain.)

  // Resolve capability ID for this kernel + type
  const caps = repos.capabilities.findByKernel(session.kernelId);
  const matchingCap = caps.find((c) => c.type === session.capabilityType) ?? caps[0];
  const capabilityId = matchingCap?.id ?? "cap-default";

  // Job stepId mirrors the first normalized milestone (== on-chain milestone 0).
  const stepId = normalizedMilestones[0].stepId;

  // Decide dispatch routing: is this job for the gateway's OWN in-process
  // kernel, or for a remote operator node that polls
  // GET /api/operator/jobs?status=queued and executes it out-of-process?
  //
  // isExternal is a best-effort routing hint (queued vs active/pending), never
  // a correctness gate — so a missing/uninitialised kernel-service must NOT
  // abort escrow+job creation. Both callers wrap createJobFromSession (the
  // negotiate commit handler swallows throws as "best-effort"; the fast-track
  // route turns them into a 500), so an unguarded getKernelService() throw here
  // would silently strand the buyer with a committed session but no job/escrow.
  //
  // A job is gateway-LOCAL only when we have an initialised local kernel AND the
  // job targets that exact kernel. EVERYTHING ELSE is external -> "queued":
  //   - no local kernel  (a pure control-plane gateway with only remote nodes)
  //   - a different kernelId  (the job belongs to some other operator's node)
  // A production gateway has NO local kernel, so defaulting to "local" here (the
  // pre-SEAM-1 behaviour) marked every remote job "pending" — a status the
  // operator daemon (which polls status=queued) never sees, stranding a
  // stranger's paid job forever. Treat "not our own kernel" as external.
  let localKernelId: string | undefined;
  try {
    localKernelId = (getKernelService() as any).config?.kernelId;
  } catch {
    localKernelId = undefined;
  }
  const isExternal = !(localKernelId && session.kernelId === localKernelId);

  repos.jobs.insert({
    id: jobId,
    stepId,
    cwmId: session.cwmId ?? `cwm-${crypto.randomUUID().slice(0, 12)}`,
    capabilityId,
    kernelId: session.kernelId,
    status: isExternal ? "queued" : (isMockSettlement() ? "active" : "pending"),
    assignedDevices: [],
    startedAt: now,
    progress: 0,
    parameters: (session.selections ?? null) as any,
    // F8 — persist the contracted tier so JobDTOs report the real value.
    assuranceTier,
  });

  // ── 3. Create execution scope ──────────────────────────────────────
  const scopeId = `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const allowedTools = getWriteToolsForDeviceType(session.capabilityType);
  const expiry = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 hour

  db.insert(executionScopes).values({
    id: scopeId,
    kernelId: session.kernelId,
    jobId,
    createdBy: session.userAgentId,
    status: "active",
    allowedTools,
    maxCommands: 200,
    commandCount: 0,
    maxRetries: 5,
    retryCount: 0,
    createdAt: now,
    expiresAt: expiry,
  }).run();

  // ── 4. Update session with jobId, escrowAddress, scopeId ───────────
  db.update(negotiationSessions)
    .set({
      jobId,
      escrowAddress,
    })
    .where(eq(negotiationSessions.id, session.id))
    .run();

  pipelineTelemetry.emit(jobId, "job_submit", "completed", {
    metadata: {
      sessionId: session.id,
      escrowId,
      scopeId,
      kernelId: session.kernelId,
      capabilityType: session.capabilityType,
      mockSettlement: isMockSettlement(),
    },
  });

  return {
    jobId,
    scopeId,
    escrowId,
    escrowAddress,
    escrowStatus,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function paidJobFlowRoutes(app: FastifyInstance) {
  const settlementFacade = getSettlementFacade();
  // ═════════════════════════════════════════════════════════════════════
  // POST /api/jobs/submit-from-discovery — Fast-track from discovery to job
  // ═════════════════════════════════════════════════════════════════════

  app.post<{
    Body: {
      kernelId: string;
      capabilityType: string;
      parameters?: Record<string, unknown>;
      paymentMethod?: "escrow" | "testnet-mock";
      userAgentId: string;
    };
  }>("/api/jobs/submit-from-discovery", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const { kernelId, capabilityType, parameters, paymentMethod, userAgentId } = body as any;

    if (!kernelId || !capabilityType || !userAgentId) {
      return reply.status(400).send({
        error: "kernelId, capabilityType, and userAgentId are required",
      });
    }

    try {
      const { db } = getStore();
      const now = new Date();

      // Load operator policy
      const policyRow = db.select().from(operatorPolicies)
        .where(eq(operatorPolicies.kernelId, kernelId))
        .get();
      const policy = (policyRow?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;

      if (policy.emergencyStop) {
        return reply.status(503).send({ error: "Operator has activated emergency stop" });
      }

      // ── Create fast-track session ───────────────────────────────────
      const sessionId = `sess-${crypto.randomUUID()}`;
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

      const constraints = {
        allowedMaterials: policy.allowedMaterials,
        maxDurationMs: policy.maxDurationMs,
        operatingHours: policy.operatingHours,
        timezone: policy.timezone,
        requireEscrow: policy.requireEscrow,
        maxTemperatureCelsius: policy.maxTemperatureCelsius,
      };

      const selections = parameters ?? {};
      const sanitizedSelections: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(selections)) {
        sanitizedSelections[key] = typeof value === "string" ? sanitizeText(value) : value;
      }

      // Auto-compute quote
      const template = getTemplate(capabilityType);
      const basePrice = template?.basePricingHints?.basePrice
        ? parseFloat(template.basePricingHints.basePrice)
        : 10;
      const quantity = (sanitizedSelections.quantity as number) ?? 1;
      const { adjustedPrice, adjustments } = applyPricingRules(
        basePrice * quantity,
        policy.pricingRules.filter((r) => r.enabled),
      );

      const quote = {
        basePrice: basePrice.toFixed(2),
        adjustments: adjustments.map((a) => ({
          ruleId: a.ruleId,
          label: a.label,
          impact: a.amount.toFixed(2),
        })),
        totalPrice: adjustedPrice.toFixed(2),
        currency: template?.basePricingHints?.currency ?? "USDC",
        bondAmount: "0.00",
        challengeWindowSeconds: 0,
        validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      };

      const stepId = `step-${crypto.randomUUID().slice(0, 8)}`;

      const contractTerms = {
        milestones: [{
          stepId,
          amount: quote.totalPrice,
          bondAmount: quote.bondAmount,
          challengeWindowSeconds: quote.challengeWindowSeconds,
        }],
        deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        assuranceTier: 0,
        payer: "0x0000000000000000000000000000000000000000",
        operator: "0x0000000000000000000000000000000000000000",
        token: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
      };

      const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
      const cwmId = `cwm-${crypto.randomUUID().slice(0, 12)}`;

      const transitions: SessionTransition[] = [
        { from: "created", to: "created", timestamp: now.toISOString(), actor: userAgentId, reason: "Fast-track session created" },
        { from: "created", to: "configuring", timestamp: now.toISOString(), actor: userAgentId, reason: "Parameters auto-configured" },
        { from: "configuring", to: "quoted", timestamp: now.toISOString(), actor: "system", reason: `Quote computed: ${quote.totalPrice} ${quote.currency}` },
        { from: "quoted", to: "reviewing", timestamp: now.toISOString(), actor: "system", reason: "Contract terms auto-generated" },
        { from: "reviewing", to: "committed", timestamp: now.toISOString(), actor: userAgentId, reason: `Fast-track committed with job ${jobId}` },
      ];

      const session = {
        id: sessionId,
        status: "committed" as SessionStatus,
        userAgentId,
        kernelId,
        capabilityType,
        capabilityId: null,
        network: null,
        selections: sanitizedSelections,
        operatorConstraints: constraints,
        scheduling: {
          earliestAvailable: new Date(Date.now() + 60_000).toISOString(),
          estimatedDuration: "PT30M",
          queuePosition: 0,
          estimatedWaitMs: 60_000,
        },
        quote,
        contractTerms,
        jobId,
        escrowAddress: null as string | null,
        cwmId,
        transitions,
        createdAt: now.toISOString(),
        expiresAt,
        committedAt: now.toISOString(),
      };

      db.insert(negotiationSessions).values(session as any).run();

      // ── Wire: create escrow + job + scope ───────────────────────────
      // Reload from DB to get proper typed row
      const sessionRow = db.select().from(negotiationSessions)
        .where(eq(negotiationSessions.id, sessionId))
        .get();

      if (!sessionRow) {
        return reply.status(500).send({ error: "Failed to create session" });
      }

      const result = await createJobFromSession(sessionRow);

      pipelineTelemetry.emit(result.jobId, "job_accepted", "completed", {
        metadata: {
          sessionId,
          kernelId,
          capabilityType,
          paymentMethod: paymentMethod ?? "testnet-mock",
        },
      });

      return reply.status(201).send({
        sessionId,
        jobId: result.jobId,
        scopeId: result.scopeId,
        escrowId: result.escrowId,
        escrowAddress: result.escrowAddress,
        escrowStatus: result.escrowStatus,
        quote,
        contractTerms,
        message: "Fast-track job created. Scope is active — executor can start making tool calls.",
      });
    } catch (err) {
      return reply.status(500).send({
        error: "fast_track_failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // PUT /api/jobs/:jobId/complete — Job completion -> evidence -> settlement
  // ═════════════════════════════════════════════════════════════════════

  app.put<{
    Params: { jobId: string };
    Body: {
      evidenceHash?: string;
      evidenceEvents?: Array<{
        type: string;
        payload?: Record<string, unknown>;
      }>;
      /** Oracle-minted EAS attestation UID to bind on-chain (V2 path only). */
      easUid?: string;
    };
  }>("/api/jobs/:jobId/complete", async (req, reply) => {
    const { jobId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Set once we've won the completion claim below, so a failure before
    // evidence is durably recorded can release the claim (see the catch).
    let claimedOriginalStatus: string | undefined;

    try {
      const repos = getRepos();
      const { db } = getStore();

      // Look up the job
      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }

      // Atomic completion claim (P1). better-sqlite3 is synchronous, so this
      // UPDATE ... WHERE ... RETURNING runs to completion without yielding the
      // event loop — only ONE caller can flip a job into 'completing'. Closes
      // two holes at once:
      //   (a) re-runnability — the old guard rejected only settled/completed,
      //       so a retried PUT on an 'evidence_submitted' job rebuilt the
      //       evidence bundle and re-ran settlement;
      //   (b) the check-then-act race — the old read happened many awaits
      //       before the terminal write, so two concurrent PUTs both passed
      //       and double-settled.
      const claimed = db
        .update(schema.jobs)
        .set({ status: "completing" })
        .where(
          and(
            eq(schema.jobs.id, jobId),
            sql`${schema.jobs.status} NOT IN ('completing','evidence_submitted','settled','completed','cancelled','failed')`,
          ),
        )
        .returning()
        .all();
      if (claimed.length !== 1) {
        // Lost the claim: the job is terminal, already has evidence submitted,
        // or another completion is in flight. Reject rather than double-run.
        return reply.status(409).send({
          error: "Job already completed or completion in progress",
          status: job.status,
        });
      }
      claimedOriginalStatus = job.status;

      // #3 — the REAL assurance tier this job was negotiated at. N3 now writes
      // this tier on-chain as the milestone's requiredTier, so the evidence
      // bundle, the oracle verification, and the EAS attestation must all attest
      // at the SAME tier — otherwise a tier>=1 milestone can't be released via
      // this route (funds stranded), the N3 failure mode resurfacing through a
      // different door. Source of truth is the session's contractTerms (what
      // createJobFromSession bound on-chain); the jobs table has no tier column.
      const tierSessionRow = db
        .select()
        .from(negotiationSessions)
        .where(eq(negotiationSessions.jobId, jobId))
        .get();
      const jobAssuranceTier = toTier(
        (tierSessionRow?.contractTerms as Record<string, unknown> | null)?.assuranceTier ?? 0,
      );

      // ── 1. Gather evidence ─────────────────────────────────────────
      // Collect tool call results from the scope's audit trail
      const scopes = db.select().from(executionScopes)
        .where(eq(executionScopes.jobId, jobId))
        .all();

      const auditTrail: Array<Record<string, unknown>> = [];
      for (const scope of scopes) {
        const calls = db.select().from(toolCallRelay)
          .where(eq(toolCallRelay.scopeId, scope.id))
          .all();
        for (const call of calls) {
          auditTrail.push({
            toolName: call.toolName,
            args: call.toolArgs,
            status: call.status,
            result: call.result,
            createdAt: call.createdAt,
            completedAt: call.completedAt,
          });
        }
      }

      const now = new Date().toISOString();
      const bundleId = `bundle-${crypto.randomUUID().slice(0, 12)}`;

      // Digest of the tool-call audit trail. The old code hashed an ad-hoc
      // {jobId, auditTrail, ...} JSON into bundleHash and then DISCARDED those
      // bytes — the committed hash had no retrievable preimage, so the
      // verification oracle (which fetches GET /api/evidence/:hash and
      // re-hashes the raw bytes, failing closed) could never verify a Path-B
      // bundle. The audit-trail binding now rides INSIDE the served envelope
      // (execution_completed payload below) instead of being the whole
      // preimage.
      const auditTrailSha256 = crypto
        .createHash("sha256")
        .update(JSON.stringify(auditTrail))
        .digest("hex");

      // Build evidence events
      const customEvents = (body.evidenceEvents ?? []) as Array<{
        type: string;
        payload?: Record<string, unknown>;
      }>;

      const events = [
        {
          id: `ev-${crypto.randomUUID().slice(0, 8)}`,
          type: "execution_completed",
          timestamp: now,
          source: {
            deviceId: "gateway",
            deviceType: "controller",
            kernelId: job.kernelId,
          },
          payload: {
            toolCallCount: auditTrail.length,
            completedAt: now,
            // Binds the audit trail (and the caller's own evidence hash, when
            // supplied) inside the hashed envelope — see bundleHash below.
            auditTrailSha256,
            ...(body.evidenceHash ? { customEvidenceHash: body.evidenceHash } : {}),
          } as Record<string, unknown>,
          hash: `sha256:${crypto.createHash("sha256").update(JSON.stringify({ type: "execution_completed", timestamp: now })).digest("hex")}`,
        },
        ...customEvents.map((ev) => ({
          id: `ev-${crypto.randomUUID().slice(0, 8)}`,
          type: ev.type,
          timestamp: now,
          source: {
            deviceId: "gateway",
            deviceType: "controller",
            kernelId: job.kernelId,
          },
          payload: ev.payload ?? {},
          hash: `sha256:${crypto.createHash("sha256").update(JSON.stringify(ev)).digest("hex")}`,
        })),
      ];

      const kernelSignature = {
        signer: "0x0000000000000000000000000000000000000000" as const,
        algorithm: "ed25519" as const,
        value: "gateway-auto-sign",
      };

      // Commit bundleHash over the CANONICAL ENVELOPE — the exact bytes
      // GET /api/evidence/:hash serves back. The oracle's fetch-and-verify
      // (re-hash raw bytes, fail closed) and its authenticity-of-origin floor
      // (reads events[] off the hash-verified doc, pcc-oracle PR #15) both
      // work against these bytes; a re-serialization that dropped
      // source.simulated / payload.mock would break the hash. NOTE: these
      // gateway-synth events are DERIVED from the real tool-call audit trail
      // (digital execution records), not simulations — so they are not tagged
      // source.simulated; their honest tell is the zero-address signer, which
      // ALCOA "Original" and the oracle's identity check both catch.
      const envelopeCanonical = buildCanonicalEvidenceEnvelope(
        {
          id: bundleId,
          jobId,
          stepId: job.stepId,
          kernelId: job.kernelId,
          assuranceTier: jobAssuranceTier,
          createdAt: now,
          kernelSignature,
        },
        events,
      );
      const gatewayBundleHash = `sha256:${crypto.createHash("sha256").update(envelopeCanonical).digest("hex")}`;

      // ── SEAM-2 (path 2): choose the settlement anchor. READY BUT GATED. ──
      // By DEFAULT the gate is CLOSED — the #52 machine.execution_log verifier is
      // stubbed/fail-closed AND the SEAM2_DEVICE_EVIDENCE_SETTLEMENT flag is unset —
      // so `resolveSettlementEvidence` returns the gateway fallback: `settlementSignature`
      // is the gateway placeholder and `bundleHash` is the canonical-envelope hash above
      // (serve-the-flag) — the default money path is unchanged apart from the now
      // oracle-verifiable hash. When a real device has cleared #52 on deployed infra and
      // the gate is opened (NOT done here), a device-signed (#236) bundle captured by
      // operator-relay (path 1) whose Ed25519 signature verifies against the kernel's
      // REGISTERED signer anchors settlement on the DEVICE's own hash + signature
      // instead of this placeholder. Fails closed to the gateway anchor on any verify
      // failure — the money path never weakens.
      const gatewaySignature: StoredSignature = {
        signer: "0x0000000000000000000000000000000000000000",
        algorithm: "ed25519",
        value: "gateway-auto-sign",
      };
      const seam2GateOpen = deviceEvidenceSettlementEnabled();
      // §7.1 / §8.5-4 — the AUTHORITATIVE effectiveEvidenceTime is the gateway RECEIPT
      // time persisted WHEN the device evidence entered, NOT this /complete handler's
      // wall-clock (`now`). A device bundle is captured EARLIER (operator-relay
      // POST /api/operator/evidence) and RETRIEVED below; `now` here is the later
      // settlement-stage clock, so using it would swap one settlement wall-clock for
      // another. Validity (expiry/revocation) is judged at EVIDENCE time, NEVER at
      // settlement-now, NEVER on the device's raw `createdAt` claim (§3.1 CVE-2024-55655
      // fix). It is therefore sourced from the retrieved row's persisted gatewayReceivedAt
      // (derived inside the gate-open block). Left undefined when there is no device row
      // (closed path / no bundle): resolveSettlementEvidence returns the fallback/hold
      // without consuming it, so the default money path is unchanged; and a delegated
      // bundle that somehow lacks a trusted time then fails closed (§8.5-4, fix #3).
      let seam2EffectiveEvidenceTime: number | undefined;
      let seam2DeviceBundle: SettlementEvidenceSlot | null = null;
      let seam2RegisteredSigner: unknown = null;
      let seam2Revocations: SessionRevocationRecord[] = [];
      if (seam2GateOpen) {
        // Extra lookups only when the gate is open — the closed path is unchanged.
        const priorBundles = repos.evidence.findByJob(jobId);
        const deviceRow = priorBundles.find((r) =>
          isDeviceSignedSignature(r.kernelSignature as StoredSignature),
        );
        if (deviceRow) {
          // The device's ADVISORY `createdAt` (its OWN claim) — DISTINCT from the
          // gateway receipt time (`seam2EffectiveEvidenceTime`). Advisory only: it feeds
          // the §8.4-A skew FLAG, never validity/expiry/revocation. Converted to Unix
          // SECONDS; omitted if the row carries no parseable createdAt.
          const rawCreatedAt = (deviceRow as { createdAt?: unknown }).createdAt;
          const deviceCreatedAtSec =
            typeof rawCreatedAt === "string" || typeof rawCreatedAt === "number"
              ? Math.floor(new Date(rawCreatedAt).getTime() / 1000)
              : NaN;
          // §7.1 / §8.5-4 — the AUTHORITATIVE evidence time: the gateway RECEIPT time
          // persisted at ingestion (gatewayReceivedAt). Legacy rows written before that
          // column existed fall back to the row's gateway-insert time (createdAt, which
          // operator-relay set to the gateway clock) — never `now`, never the device's
          // advisory createdAt, never settlement time.
          const receiptRaw =
            (deviceRow as { gatewayReceivedAt?: unknown }).gatewayReceivedAt ??
            (deviceRow as { createdAt?: unknown }).createdAt;
          const receiptSec =
            typeof receiptRaw === "string" || typeof receiptRaw === "number"
              ? Math.floor(new Date(receiptRaw).getTime() / 1000)
              : NaN;
          if (Number.isFinite(receiptSec)) seam2EffectiveEvidenceTime = receiptSec;
          seam2DeviceBundle = {
            bundleHash: deviceRow.bundleHash,
            kernelSignature: deviceRow.kernelSignature as StoredSignature,
            assuranceTier: deviceRow.assuranceTier,
            ...(deviceRow.sessionKeyAuthorization
              ? { sessionKeyAuthorization: deviceRow.sessionKeyAuthorization }
              : {}),
            contractId: jobId,
            ...(Number.isFinite(deviceCreatedAtSec)
              ? { deviceCreatedAt: deviceCreatedAtSec }
              : {}),
          };
        }
        const kernelRow = repos.kernels.findById(job.kernelId);
        seam2RegisteredSigner = registeredSignerInputFromColumns(kernelRow ?? null);
        // §8.5-2: revocation state, keyed (inside resolveSettlementEvidence) to the
        // authoritative §8.5-4 effectiveEvidenceTime computed above. Extra lookups only
        // when the gate is open — the closed path is unchanged.
        seam2Revocations = sessionRevocationStore.list();
      }
      const settlementEvidence = await resolveSettlementEvidence({
        deviceBundle: seam2DeviceBundle,
        registeredSigner: seam2RegisteredSigner,
        // §8.5-1: the purchased tier. At tier >= 1 a missing/failed device bundle
        // HOLDS (below) instead of silently anchoring on the gateway placeholder.
        requestedTier: jobAssuranceTier,
        fallback: {
          bundleHash: gatewayBundleHash,
          kernelSignature: gatewaySignature,
          assuranceTier: jobAssuranceTier,
        },
        verifyEd25519: naclEd25519Verify,
        // §8.5-2: revocation enforcement keyed to §8.5-4 effectiveEvidenceTime.
        // `revocations` is empty on the CLOSED path (populated only inside the gate-open
        // block), so it is omitted there. effectiveEvidenceTime is supplied only when a
        // device row was retrieved (its persisted §7.1 gatewayReceivedAt); it is omitted
        // on the closed path / when there is no bundle, where it is never consumed
        // (fallback/hold returned) — so the default money path is unchanged.
        ...(seam2Revocations.length > 0 ? { revocations: seam2Revocations } : {}),
        ...(seam2EffectiveEvidenceTime !== undefined
          ? { effectiveEvidenceTime: seam2EffectiveEvidenceTime }
          : {}),
        gateOpen: seam2GateOpen,
      });

      // ── SEAM-2 §8.5-1: HARD-GATE HOLD ──────────────────────────────────────
      // When the purchased tier (>= 1) required real device evidence that did NOT
      // verify (or was absent), resolveSettlementEvidence returns source:"hold"
      // rather than silently anchoring settlement on the gateway placeholder
      // (§7.3-3: never a silent downgrade, never an auto-refund; §8.4-C). Money
      // HOLDS: skip the whole anchor → store → oracle → EAS → settle chain, so no
      // on-chain write and no mock auto-settle happen and the escrow stays funded
      // for the buyer to supplement / accept / dispute. Mode-C/D dispute calls are
      // an owner-gated LATER step and are intentionally NOT wired here.
      //   LIVE FOR TIER >= 1 (audit round-2 fix #1): even with the gate closed by
      //   default (seam2GateOpen === false), a PURCHASED tier >= 1 job now resolves to
      //   source:"hold" (required-verifier-unavailable) instead of settling on the
      //   gateway placeholder — fail closed. Tier 0 still settles via the gateway
      //   fallback (unchanged). NOTE: the hold performed here is MINIMAL (job status +
      //   response only). Full hold persistence/resolution — SettlementHold record,
      //   real escrow ids, non-reclaimable/non-arbitrary bundle, buyer
      //   supplement/accept/dispute — is DEFERRED (§8.5, "before hold path is
      //   operational"); the buyer's funds simply stay in escrow until then.
      if (settlementEvidence.source === "hold") {
        // TODO(§8.5: operationalize the hold path). Persist a SettlementHold record (real
        // escrow id, non-reclaimable/non-arbitrary bundle), and wire buyer resolution
        // (supplement evidence / accept / Mode-C-D dispute). Today this is the MINIMAL hold
        // (job status + response); the money stays funded in escrow with no resolution path.
        // Move the job off the 'completing' claim into a distinct terminal
        // 'settlement_hold' so it is neither stuck (the claim guard excludes
        // 'completing') nor re-runnable as if unexecuted — mirroring how the settle
        // paths below record job status via repos.jobs.
        repos.jobs.updateStatus(jobId, "settlement_hold");
        pipelineTelemetry.emit(jobId, "settlement_complete", "completed", {
          metadata: {
            bundleId,
            settlementStatus: "hold",
            holdReason: settlementEvidence.reason ?? "evidence-insufficient-for-tier",
            requestedTier: jobAssuranceTier,
          },
        });
        // Same response shape as the settled path below (no new contract), with a
        // "hold" status and null anchor/settlement fields — nothing was anchored.
        return {
          jobId,
          status: "hold",
          evidenceBundleId: null,
          evidenceHash: null,
          escrowAddress: null,
          escrowId: null,
          settledAt: null,
          ipfsCid: null,
          starknetAnchorTxHash: null,
          eas: null,
          scopesRevoked: 0,
          toolCallsRecorded: auditTrail.length,
          oracleVerified: false,
          oracleAttestation: null,
          message:
            "Job executed but the device evidence did not verify for the purchased tier. " +
            "Settlement is on HOLD — funds remain in escrow (no release, no refund). " +
            "Supplement evidence, accept the result, or open a dispute.",
        };
      }
      // The settlement anchor: drives the stored bundle, IPFS archive, oracle verify,
      // driveSettlement and the EAS bridge below. The gateway placeholder + envelope
      // hash when the gate is closed (the default).
      const bundleHash = settlementEvidence.bundleHash;
      const settlementSignature = settlementEvidence.kernelSignature;

      // ── 2. Store evidence bundle ───────────────────────────────────
      repos.evidence.insert({
        id: bundleId,
        jobId,
        stepId: job.stepId,
        kernelId: job.kernelId,
        assuranceTier: jobAssuranceTier,
        bundleHash,
        // SEAM-2: the settlement anchor's signature — the gateway placeholder when
        // the gate is closed (default), the DEVICE's real Ed25519 signature when open.
        kernelSignature: settlementSignature,
        // §7.1 — gateway receipt time for THIS settlement-anchor row, created here at
        // /complete (so receipt ≈ creation for this row). Persisted for the same reason
        // as the ingestion path: the authoritative effectiveEvidenceTime if ever retrieved.
        gatewayReceivedAt: now,
        createdAt: now,
      });

      if (events.length > 0) {
        repos.evidence.insertEvents(
          events.map((ev) => ({
            id: ev.id,
            bundleId,
            type: ev.type,
            timestamp: ev.timestamp,
            source: ev.source,
            payload: ev.payload as Record<string, unknown>,
            hash: ev.hash,
          })),
        );
      }

      // Update job with evidence bundle reference
      repos.jobs.update(jobId, {
        evidenceBundleId: bundleId,
        status: "evidence_submitted",
      });

      // ── 2b. Archive evidence to IPFS (Storacha/Helia) — best effort ──
      let ipfsCid: string | null = null;
      try {
        const storage = await getEvidenceStorage();
        const archiveResult = await storage.archiveBundle({
          id: bundleId,
          jobId,
          stepId: job.stepId,
          kernelId: job.kernelId,
          assuranceTier: jobAssuranceTier,
          bundleHash,
          events,
          // StoredSignature → the strict spec Signature (device sig or the gateway
          // placeholder; both ed25519, signer is a 0x-string).
          kernelSignature: settlementSignature as Signature,
          createdAt: now,
        });
        ipfsCid = archiveResult.cid;
        pipelineTelemetry.emit(jobId, "evidence_archive", "completed", {
          metadata: { cid: ipfsCid, bundleId },
        });
      } catch (archiveErr) {
        console.warn("[complete] Evidence IPFS archive failed, using mock CID:", archiveErr instanceof Error ? archiveErr.message : archiveErr);
        // Generate a deterministic mock CID so the pipeline always returns one
        try {
          const { StorachaStorageService } = await import("@pcc/kernel/storacha-storage");
          const mockStorage = new StorachaStorageService({ mock: true });
          await mockStorage.init();
          const mockResult = await mockStorage.archiveBundle({
            id: bundleId, jobId, stepId: job.stepId, kernelId: job.kernelId,
            assuranceTier: jobAssuranceTier, bundleHash: bundleHash as `sha256:${string}`, events: events as any,
            kernelSignature: settlementSignature as Signature,
            createdAt: now,
          });
          ipfsCid = mockResult.cid;
        } catch { /* truly best-effort */ }
      }

      // ── 2c. ZK commitment + Starknet anchor — best effort ───────────
      let starknetTxHash: string | null = null;
      try {
        const starknetService = new StarknetProofAnchoringService({
          mock: true, // Use mock until Starknet account is deployed
        });
        // Create a commitment from the evidence hash
        const commitment = await commitmentService.createCommitment(bundleHash as any);
        // Generate tier compliance proof
        const proof = await zkProofService.generateProof("tier_compliance", commitment as any, {
          requiredTier: jobAssuranceTier,
          bundleHash,
        });
        // Anchor on Starknet
        const anchor = await starknetService.anchorProof(proof);
        starknetTxHash = anchor.txHash;
        pipelineTelemetry.emit(jobId, "verification_request", "completed", {
          metadata: { txHash: starknetTxHash, proofId: proof.id, mode: starknetService.isMock() ? "mock" : "real" },
        });
      } catch (zkErr) {
        console.warn("[complete] ZK/Starknet anchor failed (best-effort):", zkErr instanceof Error ? zkErr.message : zkErr);
      }

      // ── 3. Execution scopes — left active (not revoked on completion) ──
      // Scopes remain active so the operator/agent can continue using them
      // for follow-up tool calls (camera, diagnostics, etc.) until expiry.

      // ── 4. Find escrow and submit evidence hash ────────────────────
      // Look up the session that created this job to find the escrow
      const sessionRow = db.select().from(negotiationSessions)
        .where(eq(negotiationSessions.jobId, jobId))
        .get();

      let escrowAddress: string | null = sessionRow?.escrowAddress ?? null;
      let escrowId: string | null = null;

      // Also try to find the escrow by cwmId
      if (sessionRow?.cwmId) {
        const escrow = repos.escrows.findByCwm(sessionRow.cwmId);
        if (escrow) {
          escrowId = escrow.id;
          escrowAddress = escrow.contractAddress;

          // Update escrow milestone with evidence hash
          const milestones = repos.escrows.findMilestonesByEscrow(escrow.id);
          if (milestones.length > 0) {
            repos.escrows.updateMilestoneStatus(milestones[0].id, "evidence_submitted");
          }
        }
      }

      // ── 4a-V2. On-chain evidence leg via the settlement crank (V2 path) ──
      // driveSettlement reads the milestone's receipt-confirmed on-chain state,
      // funds it if needed, and submits the evidence hash — mapping the contract's
      // own dedup reverts to already-done, so this is safe to re-run. It returns the
      // on-chain stepId (the oracle binds its EAS mint to it) and stops at
      // needs_input:eas_uid; the UID is minted at 4b and bound at 4c.
      //
      // This replaces the former one-shot submitEvidence. We no longer swallow the
      // result and silently fall back to V1: expected reverts are handled INSIDE the
      // crank, and an unexpected chain error (RPC down) leaves the job recoverable at
      // 'evidence_submitted' for resume-settlement to re-drive — it is not hidden.
      const hasRealEscrow =
        !!escrowAddress && escrowAddress.startsWith("0x") && !escrowAddress.startsWith("mock");

      // V3 Mode-A (oracle-free approveAndRelease) settlement REMOVED per owner directive — everything through the oracle. V3 escrows now settle via the oracle-attested Mode-B dispatch below.

      let onChainStepId: `0x${string}` | undefined;
      let evidenceTxHash: string | null = null;
      if (useEasV2() && hasRealEscrow && escrowWriteEnabled()) {
        try {
          const drive = await driveSettlement(escrowAddress as `0x${string}`, 0, {
            evidenceBundleHash: bundleHash as `0x${string}`,
          });
          onChainStepId = (drive.stepId as `0x${string}` | undefined) ?? undefined;
          evidenceTxHash = drive.steps.find((s) => s.action === "submitEvidence")?.txHash ?? null;
        } catch (evErr) {
          // The milestone stays where the crank left it on-chain; a fresh read on the
          // next drive (4c below, or resume-settlement) resumes it. Surface, don't hide.
          pipelineTelemetry.emit(jobId, "settlement_claim", "failed", {
            metadata: { path: "crank-evidence", error: evErr instanceof Error ? evErr.message : String(evErr) },
          });
        }
      }

      // ── 4b. Oracle verification ─────────────────────────────────────
      // Every settlement must pass through the PCC Verification Oracle.
      // If PCC_ORACLE_KEY is not set, falls back to mock (dev/test).
      // V2: ask the oracle to MINT an on-chain EAS attestation bound to the
      // real milestone stepId; the returned UID is bound on-chain below.
      const oracleResponse = await verifyWithOracle({
        escrowAddress: escrowAddress ?? "0x0000000000000000000000000000000000000000",
        jobId,
        kernelId: job.kernelId,
        evidenceHash: bundleHash,
        assuranceTier: jobAssuranceTier,
        chainId: resolveChainId(),
        ...(useEasV2()
          ? {
              mintEasAttestation: true,
              schemaUid: process.env.PCC_EVIDENCE_SCHEMA_UID,
              // Prefer the real on-chain stepId; fall back to the job's stepId
              // string (hashed by the oracle) when no real escrow is available.
              stepId: onChainStepId ?? job.stepId,
            }
          : {}),
      });

      if (!oracleResponse.result.verified) {
        return reply.status(422).send({
          error: "oracle_verification_failed",
          reason: oracleResponse.result.reason,
          checks: oracleResponse.result.checks,
        });
      }

      // Store the attestation for potential on-chain submission
      const oracleAttestation = oracleResponse.attestation;

      // ── 4c. EAS attestation bridge (V2) — gated by PCC_USE_EAS_V2 ─────
      // V1 default: no on-chain attestation bridge here (backwards compatible —
      // settlement below is unchanged). V2 (PCC_USE_EAS_V2=true): build the
      // pcc.evidence.v1 attestation payload from the oracle verdict + evidence
      // and, when the gateway can write to a real escrow and an oracle-minted
      // EAS UID is supplied, bind it on-chain via
      // MilestoneEscrowV2.submitAttestation(uid). This replaces the removed
      // Alkahest bridge.
      let easBridge: Record<string, unknown> | null = null;
      if (useEasV2()) {
        try {
          const easMeta = buildEasAttestationMetadata({
            jobId,
            kernelId: job.kernelId,
            stepId: job.stepId,
            evidenceBundleHash: bundleHash,
            ipfsCid: ipfsCid ?? "",
            assuranceTier: jobAssuranceTier,
            oracleVerified: oracleResponse.result.verified,
            recipient: escrowAddress && escrowAddress.startsWith("0x") ? escrowAddress : undefined,
          });

          easBridge = {
            schema: easMeta.schema,
            schemaUid: easMeta.schemaUid,
            recipient: easMeta.recipient,
            encoded: easMeta.encoded,
            evidenceTxHash,
            submitted: false,
            attestationUid: null as string | null,
            attestationTxHash: null as string | null,
          };

          // EAS UID to bind on-chain: prefer the oracle-minted UID (orchestrated
          // path), fall back to a caller-supplied body.easUid (explicit bind).
          const oracleEasUid = oracleResponse.easAttestation?.easUid;
          const bodyEasUid = typeof body.easUid === "string" ? body.easUid : undefined;
          const easUid = (oracleEasUid ?? bodyEasUid) as `0x${string}` | undefined;

          if (easUid) easBridge.attestationUid = easUid;

          // Bind the attestation on-chain against a REAL escrow with write enabled
          // (the mock/dev easUid 0xea… is returned but never sent to a live chain).
          // Dispatch on the escrow's DB version: V3 escrows (created via the V3
          // factory) settle through the oracle-attested Mode-B path (submitEvidenceV3
          // → submitAttestationV3); V2 escrows route through the idempotent settlement
          // crank (driveSettlement), which is V2-only. Falls back to V2 when the row
          // is missing.
          if (easUid && hasRealEscrow && escrowWriteEnabled() && escrowAddress) {
            const escrowRow = repos.escrows.findByContractAddress(escrowAddress);
            const escrowVersion =
              (escrowRow?.version as "v2" | "v3" | null | undefined) ?? "v2";
            if (escrowVersion === "v3") {
              // V3 requires the evidence hash on-chain BEFORE the attestation binds —
              // submitAttestation reverts "Evidence not submitted" otherwise. Submit the
              // bundle hash as bytes32 (the same 0x<hex> the oracle attests) and wait
              // for it to mine so the attestation read below sees it.
              try {
                const evidenceBytes32 = (
                  bundleHash.startsWith("sha256:")
                    ? `0x${bundleHash.slice("sha256:".length)}`
                    : bundleHash
                ) as `0x${string}`;
                const evV3 = await submitEvidenceV3(
                  0,
                  evidenceBytes32,
                  escrowAddress as `0x${string}`,
                );
                easBridge.evidenceTxHash = evV3.transactionHash;
                await waitForReceipt(evV3.transactionHash as `0x${string}`);
              } catch (evErr) {
                console.warn(
                  "[complete] V3 on-chain evidence submit failed (attestation will likely revert):",
                  evErr instanceof Error ? evErr.message : evErr,
                );
              }
              const submitted = await submitAttestationV3(0, easUid, escrowAddress as `0x${string}`);
              easBridge.submitted = true;
              easBridge.attestationTxHash = submitted.transactionHash;
              easBridge.escrowVersion = escrowVersion;
            } else {
              // V2: the idempotent settlement crank binds the attestation (and, for a
              // zero-window tier-0 milestone, releases). Passing BOTH the evidence hash
              // and the UID makes the drive self-healing — if 4a's evidence submit did
              // not land it resubmits evidence first, then binds. A re-run maps
              // "Attestation already used" / "Evidence not submitted" to already-done.
              const drive = await driveSettlement(escrowAddress as `0x${string}`, 0, {
                evidenceBundleHash: bundleHash as `0x${string}`,
                easUid,
              });
              const attestStep = drive.steps.find((s) => s.action === "submitAttestation");
              // The attestation is on-chain once the milestone reached Attested or beyond.
              easBridge.submitted = drive.finalStatus === "Attested" || drive.settled;
              easBridge.attestationTxHash = attestStep?.txHash ?? null;
              easBridge.driveOutcome = drive.outcome;
              easBridge.settledOnChain = drive.settled;
              easBridge.escrowVersion = escrowVersion;
            }
          }

          pipelineTelemetry.emit(jobId, "settlement_claim", "completed", {
            metadata: {
              path: easBridge.escrowVersion === "v3" ? "eas-v3-mode-b" : "eas-v2",
              easSchema: easMeta.schema,
              easSubmitted: easBridge.submitted,
              easUid: easBridge.attestationUid ?? null,
            },
          });
        } catch (easErr) {
          console.warn("[complete] EAS attestation bridge failed (best-effort):", easErr instanceof Error ? easErr.message : easErr);
        }
      }

      // ── 5. Settlement ──────────────────────────────────────────────
      let settlementStatus = "evidence_submitted";
      let settledAt: string | null = null;

      if (isMockSettlement()) {
        // Mock settlement: auto-settle after marking evidence
        repos.jobs.updateStatus(jobId, "settled");
        settledAt = now;
        settlementStatus = "settled";

        if (escrowId) {
          repos.escrows.updateStatus(escrowId, "completed");
          const milestones = repos.escrows.findMilestonesByEscrow(escrowId);
          for (const ms of milestones) {
            repos.escrows.updateMilestoneStatus(ms.id, "released");
          }
        }
      } else {
        // Real settlement: update status to evidence_submitted and wait for challenge window
        repos.jobs.updateStatus(jobId, "evidence_submitted");
        settlementStatus = "evidence_submitted";
      }

      pipelineTelemetry.emit(jobId, "settlement_complete", "completed", {
        metadata: {
          bundleId,
          bundleHash,
          escrowAddress,
          settlementStatus,
          mockSettlement: isMockSettlement(),
          toolCallCount: auditTrail.length,
          oracleVerified: oracleResponse.result.verified,
          oracleReason: oracleResponse.result.reason,
        },
      });

      return {
        jobId,
        status: settlementStatus,
        evidenceBundleId: bundleId,
        evidenceHash: bundleHash,
        escrowAddress,
        escrowId,
        settledAt,
        ipfsCid,
        starknetAnchorTxHash: starknetTxHash,
        eas: easBridge,
        scopesRevoked: 0,
        toolCallsRecorded: auditTrail.length,
        oracleVerified: oracleResponse.result.verified,
        oracleAttestation: oracleAttestation ? {
          signature: oracleAttestation.signature,
          nonce: oracleAttestation.nonce,
          timestamp: oracleAttestation.timestamp,
        } : null,
        message: isMockSettlement()
          ? "Job completed and settled (mock settlement). Oracle verification passed."
          : "Job completed. Oracle verified. Evidence submitted. Awaiting challenge window expiry for settlement.",
      };
    } catch (err) {
      // Release the completion claim if we still hold it and hadn't yet recorded
      // evidence (status still 'completing'), so a legitimate retry can proceed.
      // Once we've advanced to evidence_submitted the WHERE matches nothing and
      // the retry stays blocked — the evidence already exists.
      if (claimedOriginalStatus !== undefined) {
        try {
          getStore().db
            .update(schema.jobs)
            .set({ status: claimedOriginalStatus })
            .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "completing")))
            .run();
        } catch {
          // best-effort — a stuck 'completing' row is still safe (blocks double-run)
        }
      }
      return reply.status(500).send({
        error: "completion_failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // POST /api/jobs/:jobId/resume-settlement — controlled recovery (A-2)
  // ═════════════════════════════════════════════════════════════════════
  //
  // P1 made /complete single-shot by widening the claim guard to also reject
  // 'evidence_submitted'. That closed the double-settle hole but created a trap:
  // any failure AFTER the evidence bundle is written (oracle throw, oracle
  // verified:false → 422, a crash) leaves the job at 'evidence_submitted', and
  // every /complete retry then 409s forever — in real mode the funds are
  // app-layer stuck with no recovery path.
  //
  // This endpoint is the controlled recovery: it RESUMES settlement (re-runs the
  // oracle gate + the settlement step) reusing the EXISTING evidence bundle. It
  // never rebuilds evidence, never creates a second bundle, and never re-submits
  // on-chain evidence or re-binds the EAS attestation — that would risk a double
  // on-chain write. Single-winner is preserved by the same atomic CAS pattern:
  // it reclaims ONLY an 'evidence_submitted' job into 'completing' (the status
  // /complete already excludes), so a concurrent /complete can't also grab it and
  // two concurrent resumes collapse to [200, 409].
  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/resume-settlement", async (req, reply) => {
    const { jobId } = req.params;
    // Set true once we hold the 'completing' claim, so a later failure can release
    // it back to 'evidence_submitted' (keeping the job recoverable, never trapped).
    let reclaimed = false;

    try {
      const repos = getRepos();
      const { db } = getStore();

      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }

      // Single-winner reclaim: flip ONLY an 'evidence_submitted' job into
      // 'completing'. Excludes settled/completed/failed/cancelled/completing, so a
      // settled job or an in-flight /complete is never disturbed, and two
      // concurrent resumes can't both win.
      const claimed = db
        .update(schema.jobs)
        .set({ status: "completing" })
        .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "evidence_submitted")))
        .returning()
        .all();
      if (claimed.length !== 1) {
        return reply.status(409).send({
          error: "Job is not in a resumable state (must be 'evidence_submitted' and not already settling/settled)",
          status: job.status,
        });
      }
      reclaimed = true;

      // Reuse the existing evidence bundle — never rebuild. Its absence means an
      // inconsistent row; release the claim and refuse rather than settle blind.
      const bundles = repos.evidence.findByJob(jobId);
      const latestBundle = bundles[bundles.length - 1] ?? null;
      if (!latestBundle) {
        repos.jobs.updateStatus(jobId, "evidence_submitted");
        reclaimed = false;
        return reply.status(409).send({
          error: "No evidence bundle found to resume; cannot settle without evidence",
          status: "evidence_submitted",
        });
      }
      const bundleId = latestBundle.id;
      const bundleHash = latestBundle.bundleHash;

      // Real negotiated tier (A-3 consistency): the on-chain milestone requiredTier.
      const tierSessionRow = db
        .select()
        .from(negotiationSessions)
        .where(eq(negotiationSessions.jobId, jobId))
        .get();
      const jobAssuranceTier = toTier(
        (tierSessionRow?.contractTerms as Record<string, unknown> | null)?.assuranceTier
          ?? latestBundle.assuranceTier
          ?? 0,
      );

      // Resolve escrow (same lookup as /complete). If settlement is ALREADY
      // recorded on-chain (escrow completed or a milestone released), do not
      // re-settle — reconcile the job to 'settled' and return. This is the
      // "IFF no settlement recorded" guard.
      let escrowAddress: string | null = tierSessionRow?.escrowAddress ?? null;
      let escrowId: string | null = null;
      if (tierSessionRow?.cwmId) {
        const escrow = repos.escrows.findByCwm(tierSessionRow.cwmId);
        if (escrow) {
          escrowId = escrow.id;
          escrowAddress = escrow.contractAddress;
          const milestones = repos.escrows.findMilestonesByEscrow(escrow.id);
          const alreadyReleased =
            escrow.status === "completed" || milestones.some((m) => m.status === "released");
          if (alreadyReleased) {
            repos.jobs.updateStatus(jobId, "settled");
            reclaimed = false;
            return {
              jobId,
              status: "settled",
              resumed: true,
              alreadySettled: true,
              evidenceBundleId: bundleId,
              escrowAddress,
              escrowId,
              assuranceTier: jobAssuranceTier,
              message: "Escrow already settled on-chain; job reconciled to settled (no re-settle).",
            };
          }
        }
      }

      // Whether to re-drive the CHAIN (not just the DB) for this recovery. The old
      // resume deliberately never touched the chain — "re-submitting on-chain evidence
      // would risk a double write". driveSettlement removes that fear: the contract
      // dedups every post-creation op by revert, and the crank maps those reverts to
      // already-done, so re-driving is a safe no-op past whatever already landed.
      const hasRealEscrow =
        !!escrowAddress && escrowAddress.startsWith("0x") && !escrowAddress.startsWith("mock");
      const v2ChainDrive = useEasV2() && hasRealEscrow && escrowWriteEnabled();

      // First chain pass: read the milestone's TRUE on-chain state and advance it —
      // fund + submit evidence if they never landed, and (the core recovery) RELEASE
      // an already-Attested milestone whose challenge window has closed, which needs
      // no oracle at all. Returns the on-chain stepId for the mint below.
      let onChainStepId: `0x${string}` | undefined;
      let chainOutcome: string | undefined;
      let chainSettled = false;
      if (v2ChainDrive) {
        try {
          const d1 = await driveSettlement(escrowAddress as `0x${string}`, 0, {
            evidenceBundleHash: bundleHash as `0x${string}`,
          });
          onChainStepId = (d1.stepId as `0x${string}` | undefined) ?? undefined;
          chainOutcome = d1.outcome;
          chainSettled = d1.settled;
        } catch (e1) {
          pipelineTelemetry.emit(jobId, "settlement_claim", "failed", {
            metadata: { path: "resume-crank-evidence", error: e1 instanceof Error ? e1.message : String(e1) },
          });
        }
      }

      // F4: if the first pass ALREADY read-confirmed an on-chain release (money moved),
      // the oracle verdict is moot — reconcile the DB to 'settled' and short-circuit
      // BEFORE the oracle gate. Without this, an oracle verified:false below resets the
      // job to 'evidence_submitted' and the DB permanently lags a real release (every
      // resume repeating the 422). Safe because driveSettlement reports settled ONLY from
      // a landed receipt or a read-confirmed Released (settlement-crank F1 invariant), and
      // when chainSettled the oracle mint was already skipped (nothing is lost by skipping
      // the gate).
      if (v2ChainDrive && chainSettled) {
        const nowIso = new Date().toISOString();
        repos.jobs.updateStatus(jobId, "settled");
        if (escrowId) {
          repos.escrows.updateStatus(escrowId, "completed");
          for (const ms of repos.escrows.findMilestonesByEscrow(escrowId)) {
            repos.escrows.updateMilestoneStatus(ms.id, "released");
          }
        }
        reclaimed = false;
        pipelineTelemetry.emit(jobId, "settlement_complete", "completed", {
          metadata: {
            path: "resume-settlement-chain-preconfirmed",
            bundleId,
            bundleHash,
            escrowAddress,
            settlementStatus: "settled",
            assuranceTier: jobAssuranceTier,
            mockSettlement: isMockSettlement(),
            chainOutcome: chainOutcome ?? null,
            chainSettled: true,
          },
        });
        return {
          jobId,
          status: "settled",
          resumed: true,
          evidenceBundleId: bundleId,
          evidenceHash: bundleHash,
          escrowAddress,
          escrowId,
          settledAt: nowIso,
          assuranceTier: jobAssuranceTier,
          oracleVerified: true, // release already landed on-chain; oracle gate short-circuited
          chainOutcome: chainOutcome ?? null,
          chainSettled: true,
          message:
            "Settlement resumed: milestone already released on-chain (read-confirmed). Job reconciled to settled; oracle gate short-circuited.",
        };
      }

      // Oracle gate — verify the reused evidence hash. For a real V2 escrow that is
      // not already settled on-chain we ALSO mint the EAS attestation (bound to the
      // on-chain stepId) so the second pass can bind it; the mock / non-chain path
      // stays a pure verification, unchanged.
      const oracleResponse = await verifyWithOracle({
        escrowAddress: escrowAddress ?? ZERO_ADDRESS,
        jobId,
        kernelId: job.kernelId,
        evidenceHash: bundleHash,
        assuranceTier: jobAssuranceTier,
        chainId: resolveChainId(),
        ...(v2ChainDrive && !chainSettled
          ? {
              mintEasAttestation: true,
              schemaUid: process.env.PCC_EVIDENCE_SCHEMA_UID,
              stepId: onChainStepId ?? job.stepId,
            }
          : {}),
      });
      if (!oracleResponse.result.verified) {
        // Not verified: release the claim back to 'evidence_submitted' so a future
        // resume (e.g. after a transient oracle outage) can try again.
        repos.jobs.updateStatus(jobId, "evidence_submitted");
        reclaimed = false;
        return reply.status(422).send({
          error: "oracle_verification_failed",
          reason: oracleResponse.result.reason,
          checks: oracleResponse.result.checks,
        });
      }

      // Second chain pass: bind the freshly-minted attestation and release if the
      // window has already closed (idempotent — a re-run maps the dedup reverts to
      // already-done). Skipped when the first pass already settled on-chain.
      if (v2ChainDrive && !chainSettled) {
        const easUid = oracleResponse.easAttestation?.easUid as `0x${string}` | undefined;
        if (easUid) {
          try {
            const d2 = await driveSettlement(escrowAddress as `0x${string}`, 0, {
              evidenceBundleHash: bundleHash as `0x${string}`,
              easUid,
            });
            chainOutcome = d2.outcome;
            chainSettled = d2.settled;
          } catch (e2) {
            pipelineTelemetry.emit(jobId, "settlement_claim", "failed", {
              metadata: { path: "resume-crank-attest", error: e2 instanceof Error ? e2.message : String(e2) },
            });
          }
        }
      }

      // Settlement DB status. Mock: settle immediately (unchanged). Real: reconcile to
      // 'settled' ONLY when the milestone actually released on-chain during this
      // resume; otherwise it stays 'evidence_submitted' (still awaiting the window),
      // resumable again once the window closes.
      const nowIso = new Date().toISOString();
      let settlementStatus = "evidence_submitted";
      let settledAt: string | null = null;
      if (isMockSettlement()) {
        repos.jobs.updateStatus(jobId, "settled");
        settledAt = nowIso;
        settlementStatus = "settled";
        if (escrowId) {
          repos.escrows.updateStatus(escrowId, "completed");
          for (const ms of repos.escrows.findMilestonesByEscrow(escrowId)) {
            repos.escrows.updateMilestoneStatus(ms.id, "released");
          }
        }
      } else if (chainSettled) {
        repos.jobs.updateStatus(jobId, "settled");
        settledAt = nowIso;
        settlementStatus = "settled";
        if (escrowId) {
          repos.escrows.updateStatus(escrowId, "completed");
          for (const ms of repos.escrows.findMilestonesByEscrow(escrowId)) {
            repos.escrows.updateMilestoneStatus(ms.id, "released");
          }
        }
      } else {
        repos.jobs.updateStatus(jobId, "evidence_submitted");
        settlementStatus = "evidence_submitted";
      }
      reclaimed = false;

      pipelineTelemetry.emit(jobId, "settlement_complete", "completed", {
        metadata: {
          path: "resume-settlement",
          bundleId,
          bundleHash,
          escrowAddress,
          settlementStatus,
          assuranceTier: jobAssuranceTier,
          mockSettlement: isMockSettlement(),
          oracleVerified: oracleResponse.result.verified,
          chainOutcome: chainOutcome ?? null,
          chainSettled,
        },
      });

      return {
        jobId,
        status: settlementStatus,
        resumed: true,
        evidenceBundleId: bundleId,
        evidenceHash: bundleHash,
        escrowAddress,
        escrowId,
        settledAt,
        assuranceTier: jobAssuranceTier,
        oracleVerified: oracleResponse.result.verified,
        chainOutcome: chainOutcome ?? null,
        chainSettled,
        message: isMockSettlement()
          ? "Settlement resumed from existing evidence (mock settlement). Oracle verification passed."
          : chainSettled
            ? "Settlement resumed and released on-chain via the crank. Job reconciled to settled."
            : "Settlement resumed from existing evidence. Oracle verified. Awaiting challenge window expiry.",
      };
    } catch (err) {
      // Release the reclaim so the job stays recoverable (never trapped at
      // 'completing'). Guarded on the status we set, matching /complete's catch.
      if (reclaimed) {
        try {
          getStore().db
            .update(schema.jobs)
            .set({ status: "evidence_submitted" })
            .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "completing")))
            .run();
        } catch {
          // best-effort — a stuck 'completing' row still blocks double-settle
        }
      }
      return reply.status(500).send({
        error: "resume_settlement_failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // GET /api/jobs/:jobId/settlement — Settlement status
  // ═════════════════════════════════════════════════════════════════════

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/settlement", async (req, reply) => {
    const { jobId } = req.params;

    try {
      const repos = getRepos();
      const { db } = getStore();

      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }

      // Look up negotiation session for escrow info
      const sessionRow = db.select().from(negotiationSessions)
        .where(eq(negotiationSessions.jobId, jobId))
        .get();

      const escrowAddress = sessionRow?.escrowAddress ?? null;
      let escrowData: Record<string, unknown> | null = null;
      let milestoneData: Array<Record<string, unknown>> = [];

      // Look up escrow details
      if (sessionRow?.cwmId) {
        const escrow = repos.escrows.findByCwm(sessionRow.cwmId);
        if (escrow) {
          escrowData = {
            id: escrow.id,
            contractAddress: escrow.contractAddress,
            totalAmount: escrow.totalAmount,
            currency: escrow.currency,
            escrowStatus: escrow.status,
            deadline: escrow.deadline,
          };

          const milestones = repos.escrows.findMilestonesByEscrow(escrow.id);
          milestoneData = milestones.map((ms) => ({
            id: ms.id,
            stepId: ms.stepId,
            amount: ms.amount,
            bondAmount: ms.bondAmount,
            status: ms.status,
            evidenceBundleHash: ms.evidenceBundleHash,
            challengeWindowStart: ms.challengeWindowStart,
            challengeWindowEnd: ms.challengeWindowEnd,
          }));
        }
      }

      // Look up evidence
      const bundles = repos.evidence.findByJob(jobId);
      const latestBundle = bundles[bundles.length - 1] ?? null;

      // Map job status to settlement status
      let settlementStatus: string;
      switch (job.status) {
        case "pending":
          settlementStatus = "pending";
          break;
        case "active":
        case "executing":
        case "queued":
        case "preparing":
          settlementStatus = "executing";
          break;
        case "evidence_stored":
        case "evidence_submitted":
        case "collecting_evidence":
          settlementStatus = "evidence_submitted";
          break;
        case "settled":
          settlementStatus = "settled";
          break;
        case "completed":
          settlementStatus = "settled";
          break;
        case "failed":
        case "cancelled":
          settlementStatus = "cancelled";
          break;
        default:
          settlementStatus = job.status;
      }

      // Check if escrow is funded
      if (settlementStatus === "pending" && escrowData) {
        const eStatus = escrowData.escrowStatus as string;
        if (eStatus === "funded" || eStatus === "active") {
          settlementStatus = "funded";
        }
      }

      const quote = sessionRow?.quote as Record<string, unknown> | null;

      return {
        jobId: job.id,
        status: settlementStatus,
        escrowAddress,
        evidenceHash: latestBundle?.bundleHash ?? null,
        evidenceBundleId: latestBundle?.id ?? job.evidenceBundleId ?? null,
        milestones: milestoneData,
        paidAmount: (escrowData?.totalAmount as string) ?? quote?.totalPrice ?? null,
        currency: (escrowData?.currency as string) ?? (quote?.currency as string) ?? "USDC",
        escrow: escrowData,
        session: sessionRow ? {
          id: sessionRow.id,
          capabilityType: sessionRow.capabilityType,
          committedAt: sessionRow.committedAt,
        } : null,
      };
    } catch (err) {
      return reply.status(500).send({
        error: "query_failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
