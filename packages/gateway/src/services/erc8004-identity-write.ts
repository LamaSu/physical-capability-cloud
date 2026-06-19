/**
 * ERC-8004 Identity Registry write helper.
 *
 * Mirrors `packages/gateway/src/contracts/protocol-client.ts` (env-driven,
 * lazy singletons, viem-based) but targets the Daydreams canonical
 * IdentityRegistry singleton on Base Sepolia at:
 *
 *   0x8004A818BFB912233c491871b3d84c89A494BD9e
 *
 * This module is the WRITE path missing from the trust commitment. The
 * READ path is already wired in `packages/gateway/src/routes/well-known.ts`,
 * which advertises this registry on `/.well-known/agent-registration.json`.
 *
 * Env vars (resolved lazily so tests can mock or skip the wallet entirely):
 *   IDENTITY_REGISTRY_ADDRESS — registry address (default: Daydreams Base Sepolia singleton)
 *   IDENTITY_REGISTRY_CHAIN_ID — chain ID (default: 84532 = Base Sepolia)
 *   BASE_SEPOLIA_RPC / PCC_RPC_URL — RPC endpoint (default: https://sepolia.base.org)
 *   PCC_GATEWAY_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY — signer (write path)
 *
 * Idempotency contract: the IdentityRegistry IS an ERC-721 token; each
 * `register()` mints a NEW agentId regardless of whether the same agentURI
 * was registered before. To remain idempotent at the gateway layer, the
 * caller MUST check whether an `onchain_agent_id` already exists in the DB
 * row BEFORE calling `registerAgentOnChain` — that lookup is part of the
 * route's responsibility, not this helper's.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  IdentityRegistryClient,
  REGISTRY_ADDRESSES,
} from "@pcc/identity-8004";

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------

const DEFAULT_BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const DEFAULT_CHAIN_ID = 84532;

function resolveChainId(): number {
  const raw = process.env.IDENTITY_REGISTRY_CHAIN_ID;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_CHAIN_ID;
}

function resolveChain(chainId: number): Chain {
  if (chainId === 84532) return baseSepolia;
  // Fallback: viem will accept the chainId via wallet client without a full
  // Chain object, but having one helps tx confirmation. For unknown chains
  // we fall back to baseSepolia with the wrong id — callers should set
  // IDENTITY_REGISTRY_CHAIN_ID = 84532 in production.
  return { ...baseSepolia, id: chainId };
}

function resolveRegistryAddress(chainId: number): `0x${string}` {
  const override = process.env.IDENTITY_REGISTRY_ADDRESS as `0x${string}` | undefined;
  if (override) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(override)) {
      throw new Error(`IDENTITY_REGISTRY_ADDRESS is not a valid EVM address: ${override}`);
    }
    return override;
  }
  const known = REGISTRY_ADDRESSES[chainId];
  if (known) return known.identityRegistry;
  throw new Error(
    `No ERC-8004 IdentityRegistry address known for chain ${chainId}. ` +
    `Set IDENTITY_REGISTRY_ADDRESS or use a supported chain.`,
  );
}

function resolveRpcUrl(): string {
  return (
    process.env.BASE_SEPOLIA_RPC ??
    process.env.PCC_RPC_URL ??
    DEFAULT_BASE_SEPOLIA_RPC
  );
}

function resolvePrivateKey(): `0x${string}` | undefined {
  const key =
    (process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}` | undefined) ??
    (process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined);
  if (!key) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "Identity write private key is not a valid 0x-prefixed 32-byte hex string",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------

let _publicClient: PublicClient | undefined;
let _walletClient: WalletClient | undefined;
let _account: Account | undefined;
let _registry: IdentityRegistryClient | undefined;

/** Reset cached clients — exposed for tests, not for production. */
export function resetClientsForTest(): void {
  _publicClient = undefined;
  _walletClient = undefined;
  _account = undefined;
  _registry = undefined;
}

function getPublicClient(): PublicClient {
  if (!_publicClient) {
    const chainId = resolveChainId();
    _publicClient = createPublicClient({
      chain: resolveChain(chainId),
      transport: http(resolveRpcUrl()),
    }) as PublicClient;
  }
  return _publicClient;
}

function getWalletClient(): WalletClient {
  if (!_walletClient) {
    const key = resolvePrivateKey();
    if (!key) {
      throw new Error(
        "Identity registry write requires PCC_GATEWAY_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY",
      );
    }
    const chainId = resolveChainId();
    _account = privateKeyToAccount(key);
    _walletClient = createWalletClient({
      account: _account,
      chain: resolveChain(chainId),
      transport: http(resolveRpcUrl()),
    });
  }
  return _walletClient;
}

function getRegistry(write: boolean): IdentityRegistryClient {
  // Re-build registry if we need write but only have read (or vice versa)
  const needsWallet = write;
  const have = _registry;
  if (have && (!needsWallet || _walletClient)) return have;
  const chainId = resolveChainId();
  _registry = new IdentityRegistryClient({
    publicClient: getPublicClient(),
    walletClient: needsWallet ? getWalletClient() : undefined,
    registryAddress: resolveRegistryAddress(chainId),
  });
  return _registry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Are write operations available (private key configured)? */
export function isIdentityWriteEnabled(): boolean {
  try {
    return resolvePrivateKey() !== undefined;
  } catch {
    return false;
  }
}

/** Resolved registry address (for logging / diagnostics). */
export function getIdentityRegistryAddress(): `0x${string}` {
  return resolveRegistryAddress(resolveChainId());
}

/** Signer address — undefined if no key configured. */
export function getIdentityWriteSigner(): `0x${string}` | undefined {
  const key = resolvePrivateKey();
  if (!key) return undefined;
  return privateKeyToAccount(key).address;
}

/**
 * Pre-flight check before broadcasting a write.
 *
 * Returns the signer's Base Sepolia ETH balance and a minimum-funded
 * flag. Used to skip real-chain integration tests when the deployer is
 * underfunded (per sierra2's audit, the canonical wallet had
 * 0.0000078 ETH on Base Sepolia — enough for a single agent register
 * at the ~0.000005 ETH typical gas cost, but worth checking explicitly).
 */
export async function checkSignerFunding(): Promise<{
  signer: `0x${string}` | undefined;
  balanceWei: bigint;
  balanceEth: string;
  sufficientForOneRegister: boolean;
}> {
  const signer = getIdentityWriteSigner();
  if (!signer) {
    return {
      signer: undefined,
      balanceWei: 0n,
      balanceEth: "0",
      sufficientForOneRegister: false,
    };
  }
  const balanceWei = await getPublicClient().getBalance({ address: signer });
  // Empirical: agent register on the Daydreams singleton costs ~0.0000051 ETH
  // at 0.1 gwei (Base Sepolia floor). Require 5x headroom = 25 µETH.
  const minRequired = 25_000_000_000_000n; // 0.000025 ETH in wei
  return {
    signer,
    balanceWei,
    balanceEth: formatEther(balanceWei),
    sufficientForOneRegister: balanceWei >= minRequired,
  };
}

export interface RegisterAgentOnChainInput {
  /** Agent DID (e.g. did:pcc:abc123) or other stable identity string. */
  agentDid: string;
  /** Public URL where the agent's registration file lives. */
  agentUrl: string;
  /** Optional 32-byte content hash of the agent's capability declaration. */
  capabilityHash?: `0x${string}`;
}

export interface RegisterAgentOnChainResult {
  agentId: bigint;
  txHash: `0x${string}`;
  registryAddress: `0x${string}`;
  chainId: number;
}

/**
 * Write a new agent identity to the ERC-8004 IdentityRegistry.
 *
 * NOT idempotent at the contract level — calling this twice mints two
 * separate agentIds. The route layer is responsible for checking an
 * existing on-chain id BEFORE invoking this helper.
 *
 * The `agentURI` written on-chain is the agent registration file URL —
 * `${agentUrl}/.well-known/agent-registration.json` — to match the
 * pattern already advertised by `well-known.ts`.
 */
export async function registerAgentOnChain(
  input: RegisterAgentOnChainInput,
): Promise<RegisterAgentOnChainResult> {
  if (!isIdentityWriteEnabled()) {
    throw new Error(
      "ERC-8004 identity write is disabled — set PCC_GATEWAY_PRIVATE_KEY",
    );
  }

  const registry = getRegistry(true);
  const chainId = resolveChainId();
  const registryAddress = resolveRegistryAddress(chainId);

  // Build the agentURI: prefer a normalized .well-known location.
  const agentURI = input.agentUrl.endsWith(".json")
    ? input.agentUrl
    : `${input.agentUrl.replace(/\/$/, "")}/.well-known/agent-registration.json`;

  const metadata = [
    { metadataKey: "did", metadataValue: utf8ToHex(input.agentDid) },
  ];
  if (input.capabilityHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.capabilityHash)) {
      throw new Error(
        `capabilityHash must be 0x-prefixed 32-byte hex (got ${input.capabilityHash})`,
      );
    }
    metadata.push({
      metadataKey: "capabilityHash",
      metadataValue: input.capabilityHash,
    });
  }

  // We need both the agentId AND the txHash; IdentityRegistryClient.register
  // only returns the agentId. We re-implement the write here to keep the
  // tx hash for audit/reporting (the receipt is the proof of write).
  const args =
    metadata.length > 0
      ? [
          agentURI,
          metadata.map((m) => ({
            metadataKey: m.metadataKey,
            metadataValue: m.metadataValue as `0x${string}`,
          })),
        ]
      : [agentURI];

  // viem 2.x typing for writeContract is strict; this matches the existing
  // client's invocation pattern (see identity-registry.ts).
  const walletClient = getWalletClient();
  const publicClient = getPublicClient();
  const { identityRegistryAbi } = await import("@pcc/identity-8004");

  const txHash = await walletClient.writeContract({
    chain: walletClient.chain ?? null,
    account: walletClient.account!,
    address: registryAddress,
    abi: identityRegistryAbi,
    functionName: "register",
    args: args as any,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(
      `IdentityRegistry.register reverted (tx ${txHash}, status ${receipt.status})`,
    );
  }

  const { parseEventLogs } = await import("viem");
  const events = parseEventLogs({
    abi: identityRegistryAbi,
    eventName: "Registered",
    logs: receipt.logs,
  });
  if (events.length === 0) {
    throw new Error(
      `IdentityRegistry.register succeeded but emitted no Registered event (tx ${txHash})`,
    );
  }
  const agentId = (events[0] as any).args.agentId as bigint;

  // Sanity: avoid unused-import warning if registry was constructed but
  // never queried. The registry instance is still useful for the read-back
  // verification in tests, so we keep it cached.
  void registry;

  return { agentId, txHash, registryAddress, chainId };
}

/**
 * Read back the agentURI for an agentId — useful for verification after
 * registration. Returns null if the read reverts (agent does not exist).
 */
export async function readAgentURI(agentId: bigint): Promise<string | null> {
  try {
    return await getRegistry(false).getAgentURI(agentId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utf8ToHex(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `0x${hex}` as `0x${string}`;
}
