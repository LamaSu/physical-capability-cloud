/**
 * Escrow contract client — read and write operations for MilestoneEscrow.
 *
 * Read operations use the public client (no wallet needed).
 * Write operations use a wallet client backed by a private key from env.
 *
 * The gateway is primarily a read gateway. Write operations are exposed here
 * so the gateway can proxy write requests from the dashboard when the user
 * has connected their wallet via SIWE.  In production, writes should go
 * through agent wallets; this client is for admin / operator tooling.
 *
 * Network selection:
 *   PCC_NETWORK=sepolia            → Ethereum Sepolia (deployed contracts)
 *   PCC_NETWORK=base-sepolia       → Base Sepolia (default, legacy)
 *   PCC_NETWORK=flow-evm-testnet   → Flow EVM Testnet (chain 545)
 *
 * Env vars:
 *   ESCROW_CONTRACT_ADDRESS — default escrow contract (optional, per-request override)
 *   PCC_RPC_URL             — Override RPC URL (defaults per network from chain-config)
 *   PCC_GATEWAY_PRIVATE_KEY — private key for write ops (optional; writes fail gracefully without it)
 *   MOCK_USDC_ADDRESS       — MockUSDC token address (optional; auto-resolved from chain-config)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  formatUnits,
  parseUnits,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  MilestoneEscrowABI,
  MockUSDCABI,
  MilestoneStatus,
  milestoneStatusName,
  getDeployment,
  getContractAddress,
  type OracleAttestation,
} from "@pcc/contracts";
// V2 / EAS-gated escrow ABI lives in the @pcc/contracts/abi subpath export
// (it is intentionally not on the top-level barrel; the V1 stack is the default).
import {
  MilestoneEscrowV2ABI,
  MilestoneStatusV2,
  milestoneStatusV2Name,
} from "@pcc/contracts/abi";
// V3 (oracle.evidence.v2 / payer-approval) ABI — additive alongside V1/V2.
// MilestoneEscrowV3 is the fee-from-attestation + Mode-A escrow. The PCCProtocolV3
// factory is deployed on base-sepolia (0x786E85B1…5534, chain-config
// milestoneEscrowFactoryV3); MilestoneEscrowV3 clones are minted from it. The
// pure calldata encoders below (for the payer's own wallet in a future Mode-B
// flow) AND the wallet writers further down (createEscrowV3 / approveAndReleaseV3,
// used by the gateway-driven Mode-A settlement ceremony where payer == arbiter ==
// the gateway signer) both target this stack.
import {
  MilestoneEscrowV3ABI,
  MilestoneStatusV3,
  milestoneStatusV3Name,
} from "@pcc/contracts/abi";

// ---------------------------------------------------------------------------
// Network-aware configuration
// ---------------------------------------------------------------------------

const PCC_NETWORK = process.env.PCC_NETWORK ?? "base-sepolia";

function resolveChainConfig(): { chain: Chain; rpcUrl: string } {
  try {
    const deployment = getDeployment(PCC_NETWORK);
    return {
      chain: deployment.chain,
      rpcUrl: process.env.PCC_RPC_URL ?? deployment.rpcUrl ?? "https://sepolia.base.org",
    };
  } catch {
    return {
      chain: baseSepolia,
      rpcUrl: process.env.PCC_RPC_URL ?? "https://sepolia.base.org",
    };
  }
}

const DEFAULT_ESCROW_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS as Address | undefined;
const GATEWAY_PRIVATE_KEY = process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}` | undefined;

/** Explicit gas limits for on-chain writes — skip the flaky public-RPC estimateGas (OutOfGas fix). Generous (~2-3x actual). */
export const GAS_LIMITS = {
  createEscrow: 900000n, addMilestone: 500000n, fund: 500000n, approve: 150000n,
  release: 1200000n, approveAndRelease: 1000000n, submitEvidence: 300000n,
  submitAttestation: 500000n, depositBond: 400000n, fileDispute: 500000n,
} as const;

/**
 * Resolve the MockUSDC token address for a given network.
 *
 * Precedence: chain-config `mockUSDC` FIRST, `MOCK_USDC_ADDRESS` env as a
 * fallback ONLY when the network has no chain-config token (e.g. localhost,
 * where forge-deploy writes the freshly-deployed token into the env line).
 *
 * The env was previously preferred, but a polluted deployment env
 * (MOCK_USDC_ADDRESS set to the Flow-EVM mockUSDC 0x5f2eb54d… while running on
 * base-sepolia) caused escrows to be minted against a token the payer holds 0
 * of — fund() then reverts. Chain-config is the per-network source of truth for
 * a deployed network; env only fills the gap where chain-config is empty.
 *
 * This is the single resolver shared by the escrow-create path
 * (paid-job-flow.createJobFromSession) and the approve default (approveToken),
 * so the escrow's `_token`, the approve target, and the fund pull all reference
 * the same token.
 */
export function resolveMockUSDCAddress(network: string = PCC_NETWORK): Address | undefined {
  try {
    return getContractAddress(network, "mockUSDC");
  } catch {
    // No chain-config token for this network (e.g. localhost) — fall back to
    // the env override if one is set.
    if (process.env.MOCK_USDC_ADDRESS) {
      return process.env.MOCK_USDC_ADDRESS as Address;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Client singletons
// ---------------------------------------------------------------------------

let _publicClient: PublicClient | undefined;
let _walletClient: WalletClient | undefined;
let _account: Account | undefined;

function getPublicClient(): PublicClient {
  if (!_publicClient) {
    const { chain, rpcUrl } = resolveChainConfig();
    _publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    }) as PublicClient;
  }
  return _publicClient;
}

function getWalletClient(): WalletClient {
  if (!_walletClient) {
    if (!GATEWAY_PRIVATE_KEY) {
      throw new Error(
        "PCC_GATEWAY_PRIVATE_KEY not set — write operations are unavailable. " +
        "Set this env var to enable escrow funding, milestone release, and dispute filing.",
      );
    }
    const { chain, rpcUrl } = resolveChainConfig();
    _account = privateKeyToAccount(GATEWAY_PRIVATE_KEY);
    _walletClient = createWalletClient({
      account: _account,
      chain,
      transport: http(rpcUrl),
    });
  }
  return _walletClient;
}

function getAccount(): Account {
  if (!_account) {
    getWalletClient(); // initializes _account
  }
  return _account!;
}

function resolveAddress(address?: Address): Address {
  const resolved = address ?? DEFAULT_ESCROW_ADDRESS;
  if (!resolved) {
    throw new Error(
      "No escrow contract address provided and ESCROW_CONTRACT_ADDRESS env var is not set.",
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnChainMilestone {
  stepId: string;
  operator: Address;
  amount: string;
  operatorBond: string;
  status: number;
  statusName: string;
  evidenceBundleHash: string;
  verifierAttestationHash: string;
  challengeWindowEnd: number;
  challengeWindowSeconds: number;
}

export interface OnChainDispute {
  challenger: Address;
  challengerBond: string;
  challengerEvidenceHash: string;
  reason: string;
  resolved: boolean;
  challengerWon: boolean;
}

export interface OnChainEscrowState {
  address: Address;
  payer: Address;
  arbiter: Address;
  token: Address;
  cwmId: string;
  funded: boolean;
  totalAmount: string;
  milestoneCount: number;
  milestones: OnChainMilestone[];
}

export interface EscrowEvent {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: number;
  transactionHash: string;
}

export interface WriteResult {
  transactionHash: string;
  status: "submitted";
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Read full escrow state from chain: payer, arbiter, token, cwmId, funded,
 * totalAmount, and all milestones.
 */
export async function getEscrowState(contractAddress?: Address): Promise<OnChainEscrowState> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();

  // Read all scalar state in parallel
  const [payer, arbiter, token, cwmId, funded, totalAmount, milestoneCount] = await Promise.all([
    client.readContract({ address, abi: MilestoneEscrowABI, functionName: "payer" }),
    client.readContract({ address, abi: MilestoneEscrowABI, functionName: "arbiter" }),
    client.readContract({ address, abi: MilestoneEscrowABI, functionName: "token" }),
    client.readContract({ address, abi: MilestoneEscrowABI, functionName: "cwmId" }),
    client.readContract({ address, abi: MilestoneEscrowABI, functionName: "funded" }),
    client.readContract({ address, abi: MilestoneEscrowABI, functionName: "totalAmount" }),
    client.readContract({ address, abi: MilestoneEscrowABI, functionName: "getMilestoneCount" }),
  ]);

  const count = Number(milestoneCount as bigint);
  const milestones: OnChainMilestone[] = [];

  // Read all milestones in parallel
  const milestoneReads = Array.from({ length: count }, (_, i) =>
    client.readContract({
      address,
      abi: MilestoneEscrowABI,
      functionName: "getMilestone",
      args: [BigInt(i)],
    }),
  );

  const rawMilestones = await Promise.all(milestoneReads);

  for (const raw of rawMilestones) {
    const m = raw as unknown as {
      stepId: string;
      operator: Address;
      amount: bigint;
      operatorBond: bigint;
      status: number;
      evidenceBundleHash: string;
      verifierAttestationHash: string;
      challengeWindowEnd: bigint;
      challengeWindowSeconds: bigint;
    };

    milestones.push({
      stepId: m.stepId,
      operator: m.operator,
      amount: formatUnits(m.amount, 6),
      operatorBond: formatUnits(m.operatorBond, 6),
      status: m.status,
      statusName: milestoneStatusName(m.status),
      evidenceBundleHash: m.evidenceBundleHash,
      verifierAttestationHash: m.verifierAttestationHash,
      challengeWindowEnd: Number(m.challengeWindowEnd),
      challengeWindowSeconds: Number(m.challengeWindowSeconds),
    });
  }

  return {
    address,
    payer: payer as Address,
    arbiter: arbiter as Address,
    token: token as Address,
    cwmId: cwmId as string,
    funded: funded as boolean,
    totalAmount: formatUnits(totalAmount as bigint, 6),
    milestoneCount: count,
    milestones,
  };
}

/**
 * Read dispute state for a specific milestone index.
 */
export async function getDispute(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<OnChainDispute> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();

  const raw = await client.readContract({
    address,
    abi: MilestoneEscrowABI,
    functionName: "getDispute",
    args: [BigInt(milestoneIndex)],
  });

  const d = raw as unknown as {
    challenger: Address;
    challengerBond: bigint;
    challengerEvidenceHash: string;
    reason: string;
    resolved: boolean;
    challengerWon: boolean;
  };

  return {
    challenger: d.challenger,
    challengerBond: formatUnits(d.challengerBond, 6),
    challengerEvidenceHash: d.challengerEvidenceHash,
    reason: d.reason,
    resolved: d.resolved,
    challengerWon: d.challengerWon,
  };
}

/**
 * Read contract events (EscrowFunded, MilestoneReleased, DisputeFiled, etc.)
 */
export async function getEvents(
  contractAddress?: Address,
  fromBlock?: bigint,
): Promise<EscrowEvent[]> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();

  const logs = await client.getContractEvents({
    address,
    abi: MilestoneEscrowABI,
    fromBlock: fromBlock ?? 0n,
  });

  return logs.map((log) => ({
    eventName: log.eventName,
    args: log.args as unknown as Record<string, unknown>,
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
  }));
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Fund the escrow contract. Caller must have already approved the token
 * transfer (totalAmount) to the escrow address.
 *
 * Calls MilestoneEscrow.fund() — transfers totalAmount from payer to escrow.
 */
export async function fundEscrow(contractAddress?: Address): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowABI,
    functionName: "fund",
    args: [],
    gas: GAS_LIMITS.fund,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Approve MockUSDC spending for escrow funding.
 * Must be called before fundEscrow so the escrow contract can pull tokens.
 */
export async function approveToken(
  spender: Address,
  amount: string,
  tokenAddress?: Address,
): Promise<WriteResult> {
  const token = tokenAddress ?? resolveMockUSDCAddress();
  if (!token) {
    throw new Error("No token address provided and MOCK_USDC_ADDRESS env var is not set and no mockUSDC in chain-config.");
  }
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address: token,
    abi: MockUSDCABI,
    functionName: "approve",
    args: [spender, parseUnits(amount, 6)],
    gas: GAS_LIMITS.approve,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Release funds for a milestone after the challenge window has expired.
 *
 * Requires the SAME oracle attestation that was submitted via
 * submitAttestation. The contract recomputes
 * keccak256(abi.encode(attestation)) and rejects release if it doesn't
 * match the stored hash. When a protocol root is configured, the
 * attestation is also re-verified on-chain at settlement time.
 */
export async function releaseMilestone(
  milestoneIndex: number,
  attestation: OracleAttestation,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  // viem encodes the attestation struct from the OracleAttestation object
  // (fields map to the tuple components named in the ABI). The contract
  // binds release to keccak256(abi.encode(attestation)), so the SAME struct
  // that was submitted via submitAttestation must be passed here.
  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowABI,
    functionName: "release",
    args: [BigInt(milestoneIndex), attestation],
    gas: GAS_LIMITS.release,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * File a dispute against a milestone during its challenge window.
 *
 * Requires a challenger bond (transferred from caller to escrow).
 * Caller must have approved the token transfer for the bond amount.
 */
export async function fileDispute(
  milestoneIndex: number,
  challengerBond: string,
  challengerEvidenceHash: `0x${string}`,
  reason: string,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowABI,
    functionName: "fileDispute",
    args: [
      BigInt(milestoneIndex),
      parseUnits(challengerBond, 6),
      challengerEvidenceHash,
      reason,
    ],
    gas: GAS_LIMITS.fileDispute,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Deposit operator bond for a milestone (must be called by the operator).
 * Operator must have approved the token transfer for the bond amount.
 */
export async function depositBond(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowABI,
    functionName: "depositBond",
    args: [BigInt(milestoneIndex)],
    gas: GAS_LIMITS.depositBond,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Submit evidence bundle hash for a completed milestone step.
 * Must be called by the milestone operator.
 */
export async function submitEvidence(
  milestoneIndex: number,
  evidenceBundleHash: `0x${string}`,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowABI,
    functionName: "submitEvidence",
    args: [BigInt(milestoneIndex), evidenceBundleHash],
    gas: GAS_LIMITS.submitEvidence,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Submit an oracle-signed attestation for a milestone.
 * Opens the challenge window. When a protocol root is configured, the
 * attestation is re-verified on-chain by the oracle verifier before the
 * challenge window opens; invalid attestations fail closed.
 *
 * The caller must retain the exact same attestation struct to pass back
 * into releaseMilestone when settling — the stored hash is
 * keccak256(abi.encode(attestation)).
 */
export async function submitAttestation(
  milestoneIndex: number,
  attestation: OracleAttestation,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  // viem encodes the attestation struct from the OracleAttestation object.
  // The contract stores keccak256(abi.encode(attestation)) and release()
  // will require the exact same struct, so the struct shape must be
  // deterministic across submit + release.
  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowABI,
    functionName: "submitAttestation",
    args: [BigInt(milestoneIndex), attestation],
    gas: GAS_LIMITS.submitAttestation,
  });

  return { transactionHash: hash, status: "submitted" };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Check if write operations are available (private key is configured) */
export function isWriteEnabled(): boolean {
  return !!GATEWAY_PRIVATE_KEY;
}

/**
 * Wait for a transaction to be mined and return its terminal receipt status.
 *
 * The V2 write helpers above return as soon as the tx is BROADCAST (viem's
 * writeContract resolves on the tx hash, not on mining). A crank that submits a
 * dependent sequence (submitEvidence → submitAttestation → release) must wait for
 * each step to MINE before the next one's estimation runs against the new state,
 * otherwise the next estimation can `eth_call` against the pre-write state and
 * revert spuriously. This is the same "trust the receipt, not a re-read" pattern
 * the create-leg uses (paid-job-flow createJobFromSession) — we confirm the write
 * landed via its receipt, we do NOT re-read getMilestone (the load-balanced RPC
 * replica lags the just-mined write).
 */
export async function waitForReceipt(
  txHash: Hex,
): Promise<{ status: "success" | "reverted" | "timeout"; blockNumber: number }> {
  const client = getPublicClient();
  try {
    // Bound the wait (F3). Without a timeout a dropped/underpriced tx polls forever, and
    // because settlement runs this inside the in-process signer lock (settlement-crank
    // withSignerLock) it would wedge ALL settlement + escrow-creation writes behind it.
    // 90s mirrors the create-leg's addMilestone wait (paid-job-flow.ts).
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    return { status: receipt.status, blockNumber: Number(receipt.blockNumber) };
  } catch (err) {
    // Timed out waiting for the receipt: the tx has NOT confirmed within the bound.
    // Report a distinct "timeout" the caller classifies as blocked (never as success) —
    // the tx may still mine later, and the next drive's fresh read + revert-map heals it.
    if (
      err instanceof WaitForTransactionReceiptTimeoutError ||
      (err instanceof Error && err.name === "WaitForTransactionReceiptTimeoutError")
    ) {
      return { status: "timeout", blockNumber: 0 };
    }
    throw err;
  }
}

/** Get the gateway signer address (if configured) */
export function getSignerAddress(): Address | undefined {
  if (!GATEWAY_PRIVATE_KEY) return undefined;
  try {
    return getAccount().address;
  } catch {
    return undefined;
  }
}

/** Re-export status utilities for convenience */
export { MilestoneStatus, milestoneStatusName };

// ===========================================================================
// V2 / EAS-gated path (MilestoneEscrowV2)
// ---------------------------------------------------------------------------
// MilestoneEscrowV2 is a parallel stack alongside V1 (see PR #83). It differs
// from V1 in the release-gating step ONLY: `submitAttestation` now binds a REAL
// on-chain EAS attestation by UID (validated for provenance + payload) instead
// of accepting a free-form bytes32, and `release(uint256)` takes only the
// milestone index (the attestation was already bound by UID at submit time).
//
// These helpers mirror the V1 functions above in shape; callers opt in by
// pointing them at a MilestoneEscrowV2 address. The V1 helpers are untouched so
// existing callers (and escrow/settlement tests) keep working unchanged.
// ===========================================================================

/**
 * The Ethereum Attestation Service contract. Base + Base Sepolia ship EAS as a
 * predeploy at 0x42…0021. Override with EAS_CONTRACT_ADDRESS for other chains.
 */
const DEFAULT_EAS_ADDRESS: Address =
  (process.env.EAS_CONTRACT_ADDRESS as Address | undefined) ??
  "0x4200000000000000000000000000000000000021";

/**
 * Minimal IEAS surface — only `getAttestation`, the single read the gateway
 * needs to inspect an attestation by UID. Field order mirrors the canonical EAS
 * `Attestation` struct (see IEAS.sol) verbatim.
 */
export const IEAS_ABI = [
  {
    name: "getAttestation",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** V2 milestone shape — the V1 fields plus the three V2 additions. */
export interface OnChainMilestoneV2 extends OnChainMilestone {
  /** Minimum assurance tier the EAS attestation must report (0-3). */
  requiredTier: number;
  /** keccak256(bytes(jobId)) bound at milestone creation. */
  jobIdHash: string;
  /** EAS UID that released the milestone (0x0…0 until attested). */
  verifierAttestationUid: string;
}

/** V2 escrow state — identical to V1 except milestones carry the V2 fields. */
export type OnChainEscrowStateV2 = Omit<OnChainEscrowState, "milestones"> & {
  milestones: OnChainMilestoneV2[];
};

/** Raw EAS attestation as returned by IEAS.getAttestation. */
export interface RawEasAttestation {
  uid: string;
  schema: string;
  time: number;
  expirationTime: number;
  revocationTime: number;
  refUID: string;
  recipient: Address;
  attester: Address;
  revocable: boolean;
  data: Hex;
}

// ── Pure calldata encoders (no wallet/network — usable by callers + tests) ──

/**
 * Encode calldata for MilestoneEscrowV2.submitAttestation(uint256, bytes32).
 * The bytes32 is the EAS attestation UID (validated on-chain against EAS).
 * Wire signature matches V1, but the semantics of the bytes32 differ.
 */
export function encodeSubmitAttestationV2(milestoneIndex: number, easUid: Hex): Hex {
  return encodeFunctionData({
    abi: MilestoneEscrowV2ABI,
    functionName: "submitAttestation",
    args: [BigInt(milestoneIndex), easUid],
  });
}

/**
 * Encode calldata for MilestoneEscrowV2.release(uint256).
 * Unlike V1's release(uint256, Attestation), V2 release takes ONLY the index —
 * the attestation was already bound by UID via submitAttestation.
 */
export function encodeReleaseV2(milestoneIndex: number): Hex {
  return encodeFunctionData({
    abi: MilestoneEscrowV2ABI,
    functionName: "release",
    args: [BigInt(milestoneIndex)],
  });
}

// ── Shaping (pure — maps a raw on-chain milestone tuple to a typed object) ──

/** Map a raw MilestoneEscrowV2 milestone tuple to a typed OnChainMilestoneV2. */
export function shapeMilestoneV2(raw: unknown): OnChainMilestoneV2 {
  const m = raw as {
    stepId: string;
    operator: Address;
    amount: bigint;
    operatorBond: bigint;
    status: number;
    evidenceBundleHash: string;
    verifierAttestationHash: string;
    challengeWindowEnd: bigint;
    challengeWindowSeconds: bigint;
    requiredTier: number;
    jobIdHash: string;
    verifierAttestationUid: string;
  };

  return {
    stepId: m.stepId,
    operator: m.operator,
    amount: formatUnits(m.amount, 6),
    operatorBond: formatUnits(m.operatorBond, 6),
    status: m.status,
    statusName: milestoneStatusV2Name(m.status),
    evidenceBundleHash: m.evidenceBundleHash,
    verifierAttestationHash: m.verifierAttestationHash,
    challengeWindowEnd: Number(m.challengeWindowEnd),
    challengeWindowSeconds: Number(m.challengeWindowSeconds),
    requiredTier: Number(m.requiredTier),
    jobIdHash: m.jobIdHash,
    verifierAttestationUid: m.verifierAttestationUid,
  };
}

// ── Read operations (V2) ───────────────────────────────────────────────────

/** Read a single V2 milestone (includes requiredTier, jobIdHash, attestation UID). */
export async function getMilestoneV2(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<OnChainMilestoneV2> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();
  const raw = await client.readContract({
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "getMilestone",
    args: [BigInt(milestoneIndex)],
  });
  return shapeMilestoneV2(raw);
}

/** Read full V2 escrow state from chain (scalars + all milestones). */
export async function getEscrowStateV2(contractAddress?: Address): Promise<OnChainEscrowStateV2> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();

  const [payer, arbiter, token, cwmId, funded, totalAmount, milestoneCount] = await Promise.all([
    client.readContract({ address, abi: MilestoneEscrowV2ABI, functionName: "payer" }),
    client.readContract({ address, abi: MilestoneEscrowV2ABI, functionName: "arbiter" }),
    client.readContract({ address, abi: MilestoneEscrowV2ABI, functionName: "token" }),
    client.readContract({ address, abi: MilestoneEscrowV2ABI, functionName: "cwmId" }),
    client.readContract({ address, abi: MilestoneEscrowV2ABI, functionName: "funded" }),
    client.readContract({ address, abi: MilestoneEscrowV2ABI, functionName: "totalAmount" }),
    client.readContract({ address, abi: MilestoneEscrowV2ABI, functionName: "getMilestoneCount" }),
  ]);

  const count = Number(milestoneCount as bigint);
  const reads = Array.from({ length: count }, (_, i) =>
    client.readContract({
      address,
      abi: MilestoneEscrowV2ABI,
      functionName: "getMilestone",
      args: [BigInt(i)],
    }),
  );
  const milestones = (await Promise.all(reads)).map(shapeMilestoneV2);

  return {
    address,
    payer: payer as Address,
    arbiter: arbiter as Address,
    token: token as Address,
    cwmId: cwmId as string,
    funded: funded as boolean,
    totalAmount: formatUnits(totalAmount as bigint, 6),
    milestoneCount: count,
    milestones,
  };
}

/**
 * Read dispute state for a V2 milestone. The Dispute struct shape is identical
 * to V1, but we read through the V2 ABI so the call dispatches against a
 * MilestoneEscrowV2 clone (decode-safe regardless of which stack deployed it).
 */
export async function getDisputeV2(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<OnChainDispute> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();

  const raw = await client.readContract({
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "getDispute",
    args: [BigInt(milestoneIndex)],
  });

  const d = raw as unknown as {
    challenger: Address;
    challengerBond: bigint;
    challengerEvidenceHash: string;
    reason: string;
    resolved: boolean;
    challengerWon: boolean;
  };

  return {
    challenger: d.challenger,
    challengerBond: formatUnits(d.challengerBond, 6),
    challengerEvidenceHash: d.challengerEvidenceHash,
    reason: d.reason,
    resolved: d.resolved,
    challengerWon: d.challengerWon,
  };
}

/**
 * Read contract events for a V2 escrow through the V2 ABI. V2 emits some events
 * (e.g. MilestoneAdded with a token param) the V1 ABI cannot decode, so reading a
 * V2 escrow's logs with the V1 ABI would silently drop or mis-decode them.
 */
export async function getEventsV2(
  contractAddress?: Address,
  fromBlock?: bigint,
): Promise<EscrowEvent[]> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();

  const logs = await client.getContractEvents({
    address,
    abi: MilestoneEscrowV2ABI,
    fromBlock: fromBlock ?? 0n,
  });

  return logs.map((log) => ({
    eventName: log.eventName,
    args: log.args as unknown as Record<string, unknown>,
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
  }));
}

/**
 * True if the EAS UID has already released a milestone in this escrow.
 * Mirrors the on-chain single-use guard (security review C1).
 */
export async function isAttestationUsedV2(easUid: Hex, contractAddress?: Address): Promise<boolean> {
  const address = resolveAddress(contractAddress);
  const client = getPublicClient();
  const used = await client.readContract({
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "attestationUsed",
    args: [easUid],
  });
  return used as boolean;
}

/**
 * Read a raw EAS attestation by UID from the EAS contract (default: the Base
 * predeploy). Callers should check `uid !== 0x0…0` to detect a missing record.
 */
export async function readEasAttestation(uid: Hex, easAddress?: Address): Promise<RawEasAttestation> {
  const client = getPublicClient();
  const raw = await client.readContract({
    address: easAddress ?? DEFAULT_EAS_ADDRESS,
    abi: IEAS_ABI,
    functionName: "getAttestation",
    args: [uid],
  });

  const a = raw as unknown as {
    uid: string;
    schema: string;
    time: bigint;
    expirationTime: bigint;
    revocationTime: bigint;
    refUID: string;
    recipient: Address;
    attester: Address;
    revocable: boolean;
    data: Hex;
  };

  return {
    uid: a.uid,
    schema: a.schema,
    time: Number(a.time),
    expirationTime: Number(a.expirationTime),
    revocationTime: Number(a.revocationTime),
    refUID: a.refUID,
    recipient: a.recipient,
    attester: a.attester,
    revocable: a.revocable,
    data: a.data,
  };
}

// ── Write operations (V2) ──────────────────────────────────────────────────

/**
 * Add a milestone to a V2 escrow (must be called by the payer, BEFORE fund()).
 *
 * This is the missing on-chain step in the per-job V2 flow: createEscrowV2 mints
 * an EMPTY escrow, so every downstream step (fund / submitEvidence / attestation /
 * release / getMilestone / state-read) requires at least one milestone to exist
 * on-chain first. V2 milestones carry two extra binding params beyond V1:
 *   - requiredTier: minimum assurance tier the EAS attestation must report (0-3).
 *   - jobId:        bound on-chain as keccak256(bytes(jobId)) for EAS payload checks.
 *
 * Wire signature: addMilestone(bytes32 stepId, address operator, uint256 amount,
 *                              uint256 operatorBond, uint256 challengeWindowSeconds,
 *                              uint8 requiredTier, string jobId).
 */
export async function addMilestoneV2(
  params: {
    stepId: Hex;
    operator: Address;
    amount: bigint;
    operatorBond: bigint;
    challengeWindowSeconds: number;
    requiredTier: number;
    jobId: string;
  },
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "addMilestone",
    args: [
      params.stepId,
      params.operator,
      params.amount,
      params.operatorBond,
      BigInt(params.challengeWindowSeconds),
      params.requiredTier,
      params.jobId,
    ],
    gas: GAS_LIMITS.addMilestone,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Fund a V2 escrow. The payer must have approved the token transfer for
 * totalAmount first. Same wire shape as V1 fund(), but routed through the V2 ABI
 * so it dispatches against a MilestoneEscrowV2 clone. Requires milestones.length > 0
 * on-chain (the contract reverts with "No milestones" otherwise).
 */
export async function fundEscrowV2(contractAddress?: Address): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "fund",
    args: [],
    gas: GAS_LIMITS.fund,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Deposit operator bond for a V2 milestone. Same wire shape as V1, V2 ABI.
 */
export async function depositBondV2(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "depositBond",
    args: [BigInt(milestoneIndex)],
    gas: GAS_LIMITS.depositBond,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * File a dispute against a V2 milestone. Same wire shape as V1
 * (uint256, uint256, bytes32, string), V2 ABI.
 */
export async function fileDisputeV2(
  milestoneIndex: number,
  challengerBond: string,
  challengerEvidenceHash: Hex,
  reason: string,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "fileDispute",
    args: [
      BigInt(milestoneIndex),
      parseUnits(challengerBond, 6),
      challengerEvidenceHash,
      reason,
    ],
    gas: GAS_LIMITS.fileDispute,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Bind a validated EAS attestation (by UID) to a V2 milestone, opening the
 * challenge window. The UID must reference a real attestation minted by the
 * authorized oracle with recipient == this escrow; the contract validates
 * provenance + payload on-chain and reverts otherwise.
 */
export async function submitAttestationV2(
  milestoneIndex: number,
  easUid: Hex,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "submitAttestation",
    args: [BigInt(milestoneIndex), easUid],
    gas: GAS_LIMITS.submitAttestation,
  });

  return { transactionHash: hash, status: "submitted" };
}

/** Submit evidence bundle hash for a V2 milestone (same shape as V1, V2 ABI). */
export async function submitEvidenceV2(
  milestoneIndex: number,
  evidenceBundleHash: Hex,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "submitEvidence",
    args: [BigInt(milestoneIndex), evidenceBundleHash],
    gas: GAS_LIMITS.submitEvidence,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Release a V2 milestone after its challenge window expires.
 * V2 release takes ONLY the index — the binding attestation was supplied to
 * submitAttestation, so no attestation struct is re-passed here (unlike V1).
 */
export async function releaseMilestoneV2(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV2ABI,
    functionName: "release",
    args: [BigInt(milestoneIndex)],
    gas: GAS_LIMITS.release,
  });

  return { transactionHash: hash, status: "submitted" };
}

/** Re-export V2 status utilities for convenience. */
export { MilestoneStatusV2, milestoneStatusV2Name };

// ===========================================================================
// V3 / oracle.evidence.v2 path (MilestoneEscrowV3)
// ---------------------------------------------------------------------------
// MilestoneEscrowV3 is a parallel stack alongside V1/V2 (see #139 / #140). It
// differs from V2 in three ways: (1) submitAttestation decodes feeBps +
// feeRecipient from the pcc.evidence.v2 EAS payload and uses them in release;
// (2) a NEW approveAndRelease(uint256) lets the PAYER settle Mode-A
// (user-attested) milestones with no oracle attestation, no challenge window,
// no fee; (3) the oracle-attested (Mode B) and dispute (Mode C) paths are
// inherited from V2.
//
// These are PURE calldata encoders only — no wallet, no network. V3 is not yet
// deployed, so there is no V3 address to send to; the caller (the payer's
// wallet for Mode A, the gateway signer for Mode B once V3 ships) submits the
// returned calldata. The wire signatures match V2 exactly for submitAttestation
// + release, so encodeSubmitAttestationV2 / encodeReleaseV2 would also work
// against a V3 clone — these V3-named variants exist so call sites are explicit
// about which stack they target and dispatch through the V3 ABI.
//
// V1/V2 helpers above are untouched.
// ===========================================================================

/**
 * Encode calldata for MilestoneEscrowV3.approveAndRelease(uint256) — Mode A.
 *
 * The PAYER (buyer) calls this to settle a user-attested milestone after
 * inspecting the deliverable off-chain. No oracle attestation, no challenge
 * window, no protocol fee. The gateway never sends this itself (it does not hold
 * the payer's key) — it returns the calldata for the payer's wallet to submit.
 */
export function encodeApproveAndReleaseV3(milestoneIndex: number): Hex {
  return encodeFunctionData({
    abi: MilestoneEscrowV3ABI,
    functionName: "approveAndRelease",
    args: [BigInt(milestoneIndex)],
  });
}

/**
 * Encode calldata for MilestoneEscrowV3.submitAttestation(uint256, bytes32) —
 * Mode B. The bytes32 is the pcc.evidence.v2 EAS UID; the contract decodes the
 * 9-field tuple (incl. feeBps + feeRecipient) on-chain and caps the fee at
 * MAX_FEE_BPS. Same wire signature as V2, dispatched through the V3 ABI.
 */
export function encodeSubmitAttestationV3(milestoneIndex: number, easUid: Hex): Hex {
  return encodeFunctionData({
    abi: MilestoneEscrowV3ABI,
    functionName: "submitAttestation",
    args: [BigInt(milestoneIndex), easUid],
  });
}

/**
 * Encode calldata for MilestoneEscrowV3.release(uint256) — Mode B release after
 * the challenge window. V3 fee math reads the attested feeBps/feeRecipient bound
 * at submitAttestation time (not protocol-root state). Index-only, like V2.
 */
export function encodeReleaseV3(milestoneIndex: number): Hex {
  return encodeFunctionData({
    abi: MilestoneEscrowV3ABI,
    functionName: "release",
    args: [BigInt(milestoneIndex)],
  });
}

// ── V3 Mode-B write helpers (gateway-signer) ─────────────────────────────
//
// Once oracle mints pcc.evidence.v2 attestations (bulletin 231: V3 factory
// deployed 0x786E85 + v2 schema; bulletin 240: V3 lane owns oracle-v2 upgrade),
// the gateway signer's Mode-B revenue path is: (1) submitEvidenceV3, (2)
// submitAttestationV3 with the EAS UID, (3) wait challenge window, (4)
// releaseMilestoneV3. These mirror the V2 pattern exactly — the wire
// signatures are byte-identical — but dispatch through the V3 ABI so the V3
// escrow's decode reads feeBps + feeRecipient from the v2 attestation payload
// (not the V2 root state). Per bulletin 239, once oracle-v2 activates, revenue
// routes to the per-operator wallet at args.operator (option A wire-up).

/**
 * Bind a validated EAS attestation (by UID) to a V3 milestone, opening the
 * challenge window. The contract decodes the pcc.evidence.v2 payload on-chain
 * (9-field tuple including feeBps + feeRecipient, capped at MAX_FEE_BPS) and
 * validates provenance against the authorized oracle.
 */
export async function submitAttestationV3(
  milestoneIndex: number,
  easUid: Hex,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV3ABI,
    functionName: "submitAttestation",
    args: [BigInt(milestoneIndex), easUid],
    gas: GAS_LIMITS.submitAttestation,
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Release a V3 milestone after its challenge window expires (Mode B).
 * V3 release takes ONLY the index — the binding attestation was supplied to
 * submitAttestationV3, so no attestation struct is re-passed here. Distribution
 * reads feeBps + feeRecipient from the attested payload and routes to
 * args.operator (per-operator wallet from option A).
 */
export async function releaseMilestoneV3(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV3ABI,
    functionName: "release",
    args: [BigInt(milestoneIndex)],
    gas: GAS_LIMITS.release,
  });

  return { transactionHash: hash, status: "submitted" };
}

// ── PCCProtocolV3 factory (wallet writers for the gateway-driven Mode-A rail) ──
//
// @pcc/contracts exports MilestoneEscrowV3ABI (the escrow instance) but NOT a
// PCCProtocolV3ABI (the factory) — the factory ABI has no committed TS source on
// master. The gateway only needs two members of the factory to run Mode A:
// createEscrowV3(payer,arbiter,token,cwmId)→address and the EscrowCreated event
// (escrow = topics[1]). Both are copied verbatim from the deployed factory
// (packages/contracts/src/PCCProtocolV3.sol createEscrowV3 @ L259, event @ L137;
// compiled artifact out/PCCProtocolV3.sol/PCCProtocolV3.json). The wire signature
// is identical to V2's createEscrowV2, so the DB/EscrowCreated decode contract is
// unchanged — this fragment simply lets viem dispatch through the V3 factory.

/**
 * Minimal PCCProtocolV3 factory ABI — only createEscrowV3 + EscrowCreated.
 * (The V3 factory is not exported by @pcc/contracts; this is the copy the
 * gateway's Mode-A create path dispatches against.)
 */
export const PCCProtocolV3FactoryABI = [
  {
    name: "createEscrowV3",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payer", type: "address" },
      { name: "arbiter", type: "address" },
      { name: "token", type: "address" },
      { name: "cwmId", type: "bytes32" },
    ],
    outputs: [{ name: "escrow", type: "address" }],
  },
  {
    name: "EscrowCreated",
    type: "event",
    inputs: [
      { name: "escrow", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "arbiter", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "cwmId", type: "bytes32", indexed: false },
    ],
  },
] as const;

/**
 * Deploy a MilestoneEscrowV3 clone via the PCCProtocolV3 factory (Mode A).
 *
 * Writes createEscrowV3(payer, arbiter, token, cwmId) to the factory, waits for
 * the receipt, decodes the EscrowCreated event (escrow = first indexed arg), and
 * returns the new escrow Address. Mirrors the inline createEscrowV2 logic in
 * paid-job-flow but returns the address directly for callers that don't need the
 * per-attempt retry loop.
 *
 * For the gateway-driven Mode-A ceremony, payer == arbiter == the gateway signer
 * (getAccount().address); the caller passes them explicitly so this stays a thin
 * factory wrapper.
 *
 * @param factoryAddress PCCProtocolV3 factory (chain-config milestoneEscrowFactoryV3).
 * @throws if no EscrowCreated log decodes with a non-zero escrow address.
 */
export async function createEscrowV3(
  payer: Address,
  arbiter: Address,
  token: Address,
  cwmId: Hex,
  factoryAddress: Address,
): Promise<Address> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address: factoryAddress,
    abi: PCCProtocolV3FactoryABI,
    functionName: "createEscrowV3",
    args: [payer, arbiter, token, cwmId],
    gas: GAS_LIMITS.createEscrow,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: PCCProtocolV3FactoryABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName === "EscrowCreated") {
        const addr = (decoded.args as { escrow?: Address }).escrow;
        if (addr && addr.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
          return addr;
        }
      }
    } catch {
      // Not an EscrowCreated log for this ABI — keep scanning.
    }
  }

  throw new Error(
    "createEscrowV3 receipt had no decodable EscrowCreated log with a non-zero escrow " +
      `address (tx ${hash}); the factory address ${factoryAddress} or ABI may be wrong.`,
  );
}

/**
 * Settle a Mode-A milestone: MilestoneEscrowV3.approveAndRelease(uint256).
 *
 * The PAYER calls this to release a user-attested milestone with no oracle
 * attestation, no challenge window, and no protocol fee. In the gateway-driven
 * Mode-A ceremony the gateway signer IS the payer, so — unlike Mode B, where the
 * gateway only returns encodeApproveAndReleaseV3 calldata for the buyer's wallet
 * — the gateway can and does send this transaction itself.
 *
 * Dispatches through MilestoneEscrowV3ABI (the same ABI encodeApproveAndReleaseV3
 * encodes against), so the on-chain call is byte-identical.
 */
export async function approveAndReleaseV3(
  milestoneIndex: number,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV3ABI,
    functionName: "approveAndRelease",
    args: [BigInt(milestoneIndex)],
    gas: GAS_LIMITS.approveAndRelease,
  });

  return { transactionHash: hash, status: "submitted" };
}

/** Submit evidence bundle hash for a V3 milestone (same shape as V1/V2, V3 ABI). */
export async function submitEvidenceV3(
  milestoneIndex: number,
  evidenceBundleHash: Hex,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowV3ABI,
    functionName: "submitEvidence",
    args: [BigInt(milestoneIndex), evidenceBundleHash],
    gas: GAS_LIMITS.submitEvidence,
  });

  return { transactionHash: hash, status: "submitted" };
}

// NOTE: waitForReceipt is defined once, above (the F3 version with a 90s timeout
// bound + a distinct "timeout" status). The settlement crank branches on that
// "timeout" status; the V3 evidence-submit sequencer here awaits it and ignores the
// return, so the single superset definition serves both. (A second, simpler V3-only
// copy from the Mode-B branch was removed during the settlement-crank rebase.)

/** Re-export V3 status utilities for convenience. */
export { MilestoneStatusV3, milestoneStatusV3Name };
