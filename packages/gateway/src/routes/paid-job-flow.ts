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
import type { Result } from "@pcc/spec";
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
import { schema, eq } from "@pcc/store";
import { TemplateResolver } from "@pcc/contract-builder";
import { PricingCalculator } from "@pcc/contract-builder";
import { applyPricingRules, sanitizeText } from "@pcc/kernel";
import { getCapabilityDescriptor } from "../services/ad-hoc-pricing.js";
import { pipelineTelemetry } from "../telemetry.js";
import { getSettlementService } from "../services/settlement-service.js";
import { getKernelService } from "../services/kernel-service.js";
import { verifyWithOracle, buildEasAttestationMetadata } from "../services/oracle-client.js";
import { getEvidenceStorage, commitmentService, zkProofService } from "../services.js";
import { StarknetProofAnchoringService } from "@pcc/verifier";
import {
  submitAttestationV2,
  submitAttestationV3,
  submitEvidenceV2,
  getMilestoneV2,
  isWriteEnabled as escrowWriteEnabled,
  resolveMockUSDCAddress,
  createEscrowV3,
  approveAndReleaseV3,
  submitEvidenceV3,
  waitForReceipt,
  GAS_LIMITS,
} from "../contracts/escrow-client.js";
import { withSignerLock } from "../contracts/signer-lock.js";
import type {
  OperatorPolicy,
  NegotiationSession,
  SessionStatus,
  SessionTransition,
} from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY, SESSION_TTL_MS } from "@pcc/spec";

const { negotiationSessions, operatorPolicies, executionScopes, toolCallRelay } = schema;

const resolver = new TemplateResolver();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether mock settlement is active (default: true for testnet) */
function isMockSettlement(): boolean {
  return process.env.MOCK_SETTLEMENT !== "false";
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

  // Check if this kernel is externally-managed (daemon-polled).
  // isExternal is a best-effort routing hint (queued vs active), never a
  // correctness gate — so a missing/uninitialised kernel-service must NOT
  // abort escrow+job creation. Both callers wrap createJobFromSession (the
  // negotiate commit handler swallows throws as "best-effort"; the fast-track
  // route turns them into a 500), so an unguarded getKernelService() throw
  // here silently strands the buyer with a committed session but no job or
  // escrow. Default to "local" when the service isn't available.
  let localKernelId: string | undefined;
  try {
    localKernelId = (getKernelService() as any).config?.kernelId;
  } catch {
    localKernelId = undefined;
  }
  const isExternal = !!localKernelId && session.kernelId !== localKernelId;

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

      // Auto-compute quote. Derive basePrice from the capability's own
      // pricing model for ad-hoc types instead of a hardcoded $10 fallback
      // (previously mispriced every ad-hoc escrow funded through this
      // fast-track endpoint — see MATCHING-NOTES.md gap #1). A genuinely
      // unknown type (no template, no registered capability row) is now a
      // clean 4xx instead of silently quoting $10.
      const desc = getCapabilityDescriptor(capabilityType);
      if (desc.kind === "missing") {
        return reply.status(404).send({
          error: "capability_not_buildable",
          message: desc.reason,
        });
      }
      const basePrice = desc.kind === "template"
        ? (desc.template.basePricingHints?.basePrice ? parseFloat(desc.template.basePricingHints.basePrice) : 10)
        : parseFloat(desc.descriptor.basePrice);
      const quoteCurrency = desc.kind === "template"
        ? (desc.template.basePricingHints?.currency ?? "USDC")
        : desc.descriptor.currency;
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
        currency: quoteCurrency,
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

    try {
      const repos = getRepos();
      const { db } = getStore();

      // Look up the job
      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }

      if (job.status === "settled" || job.status === "completed") {
        return reply.status(409).send({
          error: "Job already completed",
          status: job.status,
        });
      }

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

      // Build evidence hash
      const evidencePayload = JSON.stringify({
        jobId,
        auditTrail,
        completedAt: new Date().toISOString(),
        customHash: body.evidenceHash,
      });

      // Use crypto for hashing
      const hashBuffer = crypto.createHash("sha256").update(evidencePayload).digest("hex");
      const bundleHash = `sha256:${hashBuffer}`;

      const now = new Date().toISOString();
      const bundleId = `bundle-${crypto.randomUUID().slice(0, 12)}`;

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

      // ── 2. Store evidence bundle ───────────────────────────────────
      repos.evidence.insert({
        id: bundleId,
        jobId,
        stepId: job.stepId,
        kernelId: job.kernelId,
        assuranceTier: 0,
        bundleHash,
        kernelSignature: {
          signer: "0x0000000000000000000000000000000000000000",
          algorithm: "ed25519" as const,
          value: "gateway-auto-sign",
        },
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
          assuranceTier: 0,
          bundleHash,
          events,
          kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "ed25519" as const, value: "gateway-auto-sign" },
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
            assuranceTier: 0, bundleHash: bundleHash as `sha256:${string}`, events: events as any,
            kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "ed25519" as const, value: "gateway-auto-sign" },
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
          requiredTier: 0,
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

      // ── 4a-V2. On-chain evidence submit + stepId read (V2 path only) ──
      // V2 binds the EAS attestation to the milestone's REAL on-chain stepId, so
      // we (a) submit the evidence hash on-chain via MilestoneEscrowV2 and
      // (b) read the milestone's stepId back from chain before asking the oracle
      // to mint. Best-effort: any failure here leaves V1-style settlement intact.
      const hasRealEscrow =
        !!escrowAddress && escrowAddress.startsWith("0x") && !escrowAddress.startsWith("mock");

      // V3 Mode-A (oracle-free approveAndRelease) settlement REMOVED per owner directive — everything through the oracle. V3 escrows now settle via the oracle-attested Mode-B dispatch below.

      let onChainStepId: `0x${string}` | undefined;
      let evidenceTxHash: string | null = null;
      if (useEasV2() && hasRealEscrow && escrowWriteEnabled()) {
        try {
          const ev = await submitEvidenceV2(0, bundleHash as `0x${string}`, escrowAddress as `0x${string}`);
          evidenceTxHash = ev.transactionHash;
          const ms = await getMilestoneV2(0, escrowAddress as `0x${string}`);
          onChainStepId = ms.stepId as `0x${string}`;
        } catch (evErr) {
          console.warn(
            "[complete] V2 on-chain evidence submit / stepId read failed (best-effort):",
            evErr instanceof Error ? evErr.message : evErr,
          );
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
        assuranceTier: 0,
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
            assuranceTier: 0,
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

          // Bind on-chain only against a REAL escrow with write enabled. The
          // mock/dev easUid (0xea…) is returned but not submitted to a live chain.
          if (easUid && hasRealEscrow && escrowWriteEnabled() && escrowAddress) {
            // V3 dispatch: escrows created via the V3 factory carry version="v3"
            // in the DB, so the write path targets submitAttestationV3 (which
            // dispatches through MilestoneEscrowV3ABI). V2 escrows keep the V2
            // helper. Falls back to V2 if the row is missing.
            const escrowRow = repos.escrows.findByContractAddress(escrowAddress);
            const escrowVersion =
              (escrowRow?.version as "v2" | "v3" | null | undefined) ?? "v2";
            // V3 escrows require the evidence hash on-chain BEFORE the attestation
            // binds — submitAttestation reverts "Evidence not submitted" otherwise.
            // (The V2 path submits earlier via submitEvidenceV2.) Submit the bundle
            // hash as bytes32 — the same 0x<hex> the oracle attests — and wait for
            // it to mine so the attestation read below sees it.
            if (escrowVersion === "v3") {
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
            }
            const submitted =
              escrowVersion === "v3"
                ? await submitAttestationV3(0, easUid, escrowAddress as `0x${string}`)
                : await submitAttestationV2(0, easUid, escrowAddress as `0x${string}`);
            easBridge.submitted = true;
            easBridge.attestationTxHash = submitted.transactionHash;
            easBridge.escrowVersion = escrowVersion;
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
      return reply.status(500).send({
        error: "completion_failed",
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
