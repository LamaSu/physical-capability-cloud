/**
 * PCCProtocol contract client — read and write operations for the root protocol contract.
 *
 * The PCCProtocol contract:
 *   - Collects 1.5% fee from ALL PCC escrow settlements
 *   - Is the factory for deploying MilestoneEscrow instances
 *   - Has an immutable fee recipient (0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B)
 *
 * Network selection:
 *   PCC_NETWORK=sepolia       → Ethereum Sepolia
 *   PCC_NETWORK=base-sepolia  → Base Sepolia (default)
 *
 * Env vars:
 *   PCC_PROTOCOL_ADDRESS      — PCCProtocol contract address (override)
 *   PCC_RPC_URL               — Override RPC URL
 *   PCC_GATEWAY_PRIVATE_KEY   — Private key for write operations
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  PCCProtocolABI,
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

const PROTOCOL_ADDRESS = process.env.PCC_PROTOCOL_ADDRESS as Address | undefined;
const GATEWAY_PRIVATE_KEY = process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}` | undefined;

function resolveProtocolAddress(): Address {
  if (PROTOCOL_ADDRESS) return PROTOCOL_ADDRESS;
  try {
    return getContractAddress(PCC_NETWORK, "pccProtocol");
  } catch {
    throw new Error(
      "PCCProtocol address not found. Set PCC_PROTOCOL_ADDRESS or add pccProtocol to chain-config.ts.",
    );
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
        "PCC_GATEWAY_PRIVATE_KEY not set — write operations are unavailable.",
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
    getWalletClient();
  }
  return _account!;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProtocolState {
  address: Address;
  feeRecipient: Address;
  protocolFeeBps: number;
  protocolFeePercent: string;
  governor: Address;
  escrowCount: number;
  identityRegistry: Address;
  reputationRegistry: Address;
  validationRegistry: Address;
  verifierRegistry: Address;
}

export interface ProtocolWriteResult {
  transactionHash: string;
  status: "submitted";
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Read the full state of the PCCProtocol contract.
 * Includes fee rate, fee recipient, governor, registry addresses, escrow count.
 */
export async function getProtocolState(contractAddress?: Address): Promise<ProtocolState> {
  const address = contractAddress ?? resolveProtocolAddress();
  const client = getPublicClient();

  const [
    feeRecipient,
    protocolFeeBps,
    governor,
    escrowCount,
    identityRegistry,
    reputationRegistry,
    validationRegistry,
    verifierRegistry,
  ] = await Promise.all([
    client.readContract({ address, abi: PCCProtocolABI, functionName: "feeRecipient" }),
    client.readContract({ address, abi: PCCProtocolABI, functionName: "protocolFeeBps" }),
    client.readContract({ address, abi: PCCProtocolABI, functionName: "governor" }),
    client.readContract({ address, abi: PCCProtocolABI, functionName: "getEscrowCount" }),
    client.readContract({ address, abi: PCCProtocolABI, functionName: "identityRegistry" }),
    client.readContract({ address, abi: PCCProtocolABI, functionName: "reputationRegistry" }),
    client.readContract({ address, abi: PCCProtocolABI, functionName: "validationRegistry" }),
    client.readContract({ address, abi: PCCProtocolABI, functionName: "verifierRegistry" }),
  ]);

  const feeBps = Number(protocolFeeBps as bigint);

  return {
    address,
    feeRecipient: feeRecipient as Address,
    protocolFeeBps: feeBps,
    protocolFeePercent: `${(feeBps / 100).toFixed(2)}%`,
    governor: governor as Address,
    escrowCount: Number(escrowCount as bigint),
    identityRegistry: identityRegistry as Address,
    reputationRegistry: reputationRegistry as Address,
    validationRegistry: validationRegistry as Address,
    verifierRegistry: verifierRegistry as Address,
  };
}

/**
 * Calculate the protocol fee for a given amount.
 * Returns the fee as a formatted string (USDC, 6 decimals).
 */
export async function calculateProtocolFee(
  amount: bigint,
  contractAddress?: Address,
): Promise<{ fee: bigint; feeFormatted: string; netAmount: bigint; netFormatted: string }> {
  const address = contractAddress ?? resolveProtocolAddress();
  const client = getPublicClient();

  const fee = await client.readContract({
    address,
    abi: PCCProtocolABI,
    functionName: "calculateFee",
    args: [amount],
  });

  const feeValue = fee as bigint;
  const netAmount = amount - feeValue;

  return {
    fee: feeValue,
    feeFormatted: formatUnits(feeValue, 6),
    netAmount,
    netFormatted: formatUnits(netAmount, 6),
  };
}

/**
 * Get total fees collected by the protocol for a specific token.
 */
export async function getTotalFeesForToken(
  tokenAddress: Address,
  contractAddress?: Address,
): Promise<{ raw: bigint; formatted: string }> {
  const address = contractAddress ?? resolveProtocolAddress();
  const client = getPublicClient();

  const total = await client.readContract({
    address,
    abi: PCCProtocolABI,
    functionName: "getTotalFeesForToken",
    args: [tokenAddress],
  });

  const raw = total as bigint;
  return {
    raw,
    formatted: formatUnits(raw, 6),
  };
}

/**
 * Get fees collected from a specific escrow contract.
 */
export async function getFeesFromEscrow(
  escrowAddress: Address,
  contractAddress?: Address,
): Promise<{ raw: bigint; formatted: string }> {
  const address = contractAddress ?? resolveProtocolAddress();
  const client = getPublicClient();

  const fees = await client.readContract({
    address,
    abi: PCCProtocolABI,
    functionName: "feesFromEscrow",
    args: [escrowAddress],
  });

  const raw = fees as bigint;
  return {
    raw,
    formatted: formatUnits(raw, 6),
  };
}

/**
 * Check if an escrow address was deployed by this protocol factory.
 */
export async function isProtocolEscrow(
  escrowAddress: Address,
  contractAddress?: Address,
): Promise<boolean> {
  const address = contractAddress ?? resolveProtocolAddress();
  const client = getPublicClient();

  const result = await client.readContract({
    address,
    abi: PCCProtocolABI,
    functionName: "isProtocolEscrow",
    args: [escrowAddress],
  });

  return result as boolean;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create a new MilestoneEscrow via the protocol factory.
 * The escrow will have this protocol as its root (fee will be collected on release).
 *
 * Returns the new escrow's transaction hash (not the address — poll events for that).
 */
export async function createEscrowViaProtocol(
  payer: Address,
  arbiter: Address,
  token: Address,
  cwmId: `0x${string}`,
  contractAddress?: Address,
): Promise<ProtocolWriteResult> {
  const address = contractAddress ?? resolveProtocolAddress();
  const wallet = getWalletClient();

  const hash = await wallet.writeContract({
    chain: resolveChainConfig().chain,
    account: getAccount(),
    address,
    abi: PCCProtocolABI,
    functionName: "createEscrow",
    args: [payer, arbiter, token, cwmId],
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

/** Resolve the configured protocol address without throwing */
export function getProtocolAddress(): Address | undefined {
  try {
    return resolveProtocolAddress();
  } catch {
    return undefined;
  }
}
