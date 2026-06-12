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
  type Address,
  type Hex,
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
  type OracleAttestation,
} from "@pcc/contracts";
// V2 / EAS-gated escrow ABI lives in the @pcc/contracts/abi subpath export
// (it is intentionally not on the top-level barrel; the V1 stack is the default).
import {
  MilestoneEscrowV2ABI,
  MilestoneStatusV2,
  milestoneStatusV2Name,
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
  });

  return { transactionHash: hash, status: "submitted" };
}

/** Re-export V2 status utilities for convenience. */
export { MilestoneStatusV2, milestoneStatusV2Name };
