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
 *   PCC_NETWORK=sepolia       → Ethereum Sepolia (deployed contracts)
 *   PCC_NETWORK=base-sepolia  → Base Sepolia (default, legacy)
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
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  formatUnits,
  parseUnits,
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
} from "@pcc/contracts";

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

/** Resolve MockUSDC address: env var > chain-config > undefined */
function resolveMockUSDCAddress(): Address | undefined {
  if (process.env.MOCK_USDC_ADDRESS) {
    return process.env.MOCK_USDC_ADDRESS as Address;
  }
  try {
    return getContractAddress(PCC_NETWORK, "mockUSDC");
  } catch {
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
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Release funds for a milestone after the challenge window has expired.
 * Anyone can call this — the contract enforces that the challenge window is closed.
 */
export async function releaseMilestone(
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
    functionName: "release",
    args: [BigInt(milestoneIndex)],
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
  });

  return { transactionHash: hash, status: "submitted" };
}

/**
 * Submit verifier attestation hash for a milestone.
 * Opens the challenge window.
 */
export async function submitAttestation(
  milestoneIndex: number,
  attestationHash: `0x${string}`,
  contractAddress?: Address,
): Promise<WriteResult> {
  const address = resolveAddress(contractAddress);
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: MilestoneEscrowABI,
    functionName: "submitAttestation",
    args: [BigInt(milestoneIndex), attestationHash],
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
