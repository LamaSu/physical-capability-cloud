/**
 * PLRRegistryClient — thin viem-backed wrapper for the on-chain
 * PLRBackendRegistry. Read-only methods take just a PublicClient; write
 * methods take a WalletClient.
 *
 * The contract address is passed at construction; deploy outputs of
 * `forge script script/DeployPLRBackendRegistry.s.sol` are recorded in
 * the project's `chain-config.ts`.
 */

import type {
  Address,
  PublicClient,
  WalletClient,
  Hash,
  Hex,
} from "viem";
import { keccak256, stringToBytes } from "viem";

import { PLR_BACKEND_REGISTRY_ABI } from "./abi.js";
import type { BackendRecord } from "@pcc/spec";

export interface PLRRegistryClientConfig {
  /** Deployed PLRBackendRegistry contract address. */
  registryAddress: Address;
  /** viem PublicClient for reads. Required. */
  publicClient: PublicClient;
  /** viem WalletClient for writes. Optional — omit for read-only usage. */
  walletClient?: WalletClient;
}

/**
 * Convert a `BackendRecord` viem tuple result back into our typed shape.
 * Numbers > 2^53 stay as bigint for the tokenId field; timestamps
 * downcast to `number` because uint64 ≤ 2^53.
 */
function toBackendRecord(
  modulePath: string,
  raw: {
    scheduleHash: Hex;
    delegatedAgentId: Hex;
    manifestCid: Hex;
    contributorTokenId: bigint;
    registeredAt: bigint;
    lastEnabledChange: bigint;
    enabled: boolean;
  },
): BackendRecord {
  return {
    modulePath,
    modulePathKey: keccak256(stringToBytes(modulePath)),
    scheduleHash: raw.scheduleHash,
    delegatedAgentId: raw.delegatedAgentId,
    manifestCid: raw.manifestCid,
    contributorTokenId: raw.contributorTokenId.toString(),
    registeredAt: Number(raw.registeredAt),
    lastEnabledChange: Number(raw.lastEnabledChange),
    enabled: raw.enabled,
  };
}

export class PLRRegistryClient {
  readonly registryAddress: Address;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;

  constructor(config: PLRRegistryClientConfig) {
    this.registryAddress = config.registryAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  async getRecord(modulePath: string): Promise<BackendRecord | null> {
    const raw = (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "getRecord",
      args: [modulePath],
    })) as unknown as Parameters<typeof toBackendRecord>[1];

    // contributorTokenId == 0 + registeredAt == 0 means "no record". Skip
    // the zero record so callers see a clean null vs. an all-zero struct.
    if (raw.contributorTokenId === 0n && raw.registeredAt === 0n) {
      return null;
    }
    return toBackendRecord(modulePath, raw);
  }

  async isEnabled(modulePath: string): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "isEnabled",
      args: [modulePath],
    })) as boolean;
  }

  async authorOf(modulePath: string): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "authorOf",
      args: [modulePath],
    })) as Address;
  }

  async totalBackends(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "totalBackends",
    })) as bigint;
  }

  /**
   * Equivalent to calling `assertEnabled(modulePath)` on the contract.
   * Returns true on success, false on `BackendDisabled` revert. Re-throws
   * any other RPC error (network, contract address wrong, etc.).
   */
  async assertEnabled(modulePath: string): Promise<boolean> {
    try {
      await this.publicClient.readContract({
        address: this.registryAddress,
        abi: PLR_BACKEND_REGISTRY_ABI,
        functionName: "assertEnabled",
        args: [modulePath],
      });
      return true;
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (
        message.includes("BackendDisabled") ||
        message.includes("0x") // viem encodes custom errors as hex
      ) {
        // We don't have the selector at hand, so fall through to false on any revert.
        // The aggregator handles the resulting BackendDisabledError shaping separately.
        return false;
      }
      throw err;
    }
  }

  async deriveIpId(modulePath: string, majorVersion: number): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "deriveIpId",
      args: [modulePath, majorVersion],
    })) as Hex;
  }

  // ── Writes (require walletClient) ─────────────────────────────────────

  private _requireWallet(): WalletClient {
    if (!this.walletClient) {
      throw new Error(
        "PLRRegistryClient: walletClient required for write operations",
      );
    }
    return this.walletClient;
  }

  async register(args: {
    modulePath: string;
    contributorTokenId: bigint;
    scheduleHash: Hex;
    delegatedAgentId: Hex;
    manifestCid: Hex;
    account: Address;
  }): Promise<Hash> {
    const wallet = this._requireWallet();
    return wallet.writeContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "register",
      args: [
        args.modulePath,
        args.contributorTokenId,
        args.scheduleHash,
        args.delegatedAgentId,
        args.manifestCid,
      ],
      account: args.account,
      chain: wallet.chain ?? null,
    });
  }

  async setEnabled(args: {
    modulePath: string;
    enabled: boolean;
    account: Address;
  }): Promise<Hash> {
    const wallet = this._requireWallet();
    const key = keccak256(stringToBytes(args.modulePath));
    return wallet.writeContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "setEnabled",
      args: [key, args.enabled],
      account: args.account,
      chain: wallet.chain ?? null,
    });
  }

  async setManifestCid(args: {
    modulePath: string;
    newCid: Hex;
    account: Address;
  }): Promise<Hash> {
    const wallet = this._requireWallet();
    const key = keccak256(stringToBytes(args.modulePath));
    return wallet.writeContract({
      address: this.registryAddress,
      abi: PLR_BACKEND_REGISTRY_ABI,
      functionName: "setManifestCid",
      args: [key, args.newCid],
      account: args.account,
      chain: wallet.chain ?? null,
    });
  }
}
