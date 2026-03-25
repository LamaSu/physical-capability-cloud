/**
 * Smart Account Factory — upgrades EOA signers into ERC-4337 smart accounts.
 *
 * Uses permissionless.js (viem-native) to create smart account clients that
 * route transactions through bundlers instead of directly to the mempool.
 *
 * Smart accounts enable:
 * - Batched transactions (multicall in one UserOp)
 * - Gas sponsorship via paymasters
 * - Session keys for agent autonomy
 * - Counterfactual deployment (address exists before on-chain deployment)
 */

import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { createSmartAccountClient as permissionlessCreateSmartAccountClient } from "permissionless";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";

import type {
  BundlerConfig,
  SmartAccountConfig,
  SmartAccountState,
  QueuedOperation,
  CoinbasePaymasterConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// EntryPoint v0.7 constants (Base Sepolia + Base Mainnet)
// ---------------------------------------------------------------------------

export const ENTRY_POINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

// SimpleAccount factory (deployed by eth-infinitism on all major chains)
export const SIMPLE_ACCOUNT_FACTORY_V07: Address = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985";

// Coinbase CDP Paymaster URL pattern
const COINBASE_PAYMASTER_BASE_URL = "https://api.developer.coinbase.com/rpc/v1";

// ---------------------------------------------------------------------------
// SmartAccountClient
// ---------------------------------------------------------------------------

/**
 * A viem-based smart account client that wraps an EOA signer.
 *
 * Delegates to permissionless.js for:
 * - Correct CREATE2 address computation via toSimpleSmartAccount
 * - ERC-4337 compliant UserOp signing (keccak256(abi.encode(userOpHash, entryPoint, chainId)))
 * - Nonce management, gas estimation, and paymaster integration
 */
export class SmartAccountClient {
  readonly signerAddress: Address;
  smartAccountAddress: Address;
  readonly implementation: "simple" | "kernel" | "safe";
  readonly chain: Chain;

  private bundlerUrl: string;
  private paymasterUrl?: string;
  private deployed = false;
  private nonce = 0n;
  private saltNonce: bigint;
  publicClient: PublicClient;

  // permissionless account — set after async init
  _account: Awaited<ReturnType<typeof toSimpleSmartAccount>> | null = null;

  /**
   * Direct constructor — accepts pre-computed addresses.
   * Prefer `SmartAccountClient.create()` for proper CREATE2 address derivation.
   *
   * This constructor is kept public for testing/mocking compatibility.
   * In production code, always use `SmartAccountClient.create()`.
   *
   * When called without addresses (e.g., in tests), placeholder zero addresses
   * are used — always use `SmartAccountClient.create()` for real deployments.
   */
  constructor(
    config: SmartAccountConfig,
    smartAccountAddress?: Address,
    signerAddress?: Address,
  ) {
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

    this.signerAddress = signerAddress ?? (config?.privateKey
      ? (privateKeyToAccount(config.privateKey as Hex).address)
      : ZERO_ADDRESS);
    this.smartAccountAddress = smartAccountAddress ?? ZERO_ADDRESS;
    this.implementation = config?.implementation ?? "simple";
    this.chain = config?.bundler?.chain ?? ({} as Chain);
    this.bundlerUrl = config?.bundler?.bundlerUrl ?? "";
    this.paymasterUrl = config?.bundler?.paymasterUrl;
    this.saltNonce = config?.saltNonce ?? 0n;

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config?.bundler?.rpcUrl),
    });
  }

  /**
   * Factory method — async because toSimpleSmartAccount does CREATE2 address derivation
   * by calling getSenderAddress on-chain (or falling back to local computation).
   * This replaces the buggy XOR/truncation approach.
   */
  static async create(config: SmartAccountConfig): Promise<SmartAccountClient> {
    const signer = privateKeyToAccount(config.privateKey);
    const chain = config.bundler.chain;

    const publicClient = createPublicClient({
      chain,
      transport: http(config.bundler.rpcUrl),
    });

    // Use permissionless toSimpleSmartAccount for proper CREATE2 address computation.
    // This calls getSenderAddress via the EntryPoint which uses CREATE2:
    //   address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
    const account = await toSimpleSmartAccount({
      client: publicClient,
      owner: signer,
      entryPoint: {
        address: ENTRY_POINT_V07,
        version: "0.7",
      },
      factoryAddress: SIMPLE_ACCOUNT_FACTORY_V07,
      index: config.saltNonce ?? 0n,
    });

    const smartAccountAddress = await account.getAddress();
    const client = new SmartAccountClient(config, smartAccountAddress, signer.address);
    client._account = account;
    client.publicClient = publicClient;

    return client;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Get the smart account state */
  async getState(): Promise<SmartAccountState> {
    await this.checkDeployment();
    return {
      address: this.smartAccountAddress,
      deployed: this.deployed,
      signerAddress: this.signerAddress,
      nonce: this.nonce,
      implementation: this.implementation,
    };
  }

  /**
   * Encode a contract call as calldata for the smart account's `execute()`.
   * This is what goes into the UserOp's callData field.
   */
  encodeExecute(target: Address, value: bigint, data: Hex): Hex {
    return encodeFunctionData({
      abi: SIMPLE_ACCOUNT_EXECUTE_ABI,
      functionName: "execute",
      args: [target, value, data],
    });
  }

  /**
   * Encode multiple calls as a batched `executeBatch()` on the smart account.
   * This is the throughput multiplier — N contract calls in one UserOp.
   */
  encodeBatch(calls: Array<{ target: Address; value: bigint; data: Hex }>): Hex {
    return encodeFunctionData({
      abi: SIMPLE_ACCOUNT_BATCH_ABI,
      functionName: "executeBatch",
      args: [
        calls.map((c) => c.target),
        calls.map((c) => c.value),
        calls.map((c) => c.data),
      ],
    });
  }

  /**
   * Encode a queued operation into calldata.
   */
  encodeOperation(op: QueuedOperation): { target: Address; value: bigint; data: Hex } {
    const data = encodeFunctionData({
      abi: op.abi as any,
      functionName: op.functionName,
      args: op.args as any,
    });
    return {
      target: op.target,
      value: op.value ?? 0n,
      data,
    };
  }

  /**
   * Send a UserOperation to the bundler.
   *
   * Uses createSmartAccountClient from permissionless which handles:
   * - Correct ERC-4337 UserOp signing: keccak256(abi.encode(userOpHash, entryPoint, chainId))
   * - Nonce management
   * - Gas estimation
   * - Paymaster integration
   *
   * Returns the UserOp hash (not a tx hash).
   */
  async sendUserOp(callData: Hex): Promise<Hex> {
    if (!this._account) {
      throw new Error("SmartAccountClient not initialized. Use SmartAccountClient.create()");
    }

    // Build the permissionless smart account client
    const smClient = permissionlessCreateSmartAccountClient({
      account: this._account,
      chain: this.chain,
      bundlerTransport: http(this.bundlerUrl),
      ...(this.paymasterUrl
        ? {
            paymaster: createPimlicoClient({
              transport: http(this.paymasterUrl),
              entryPoint: {
                address: ENTRY_POINT_V07,
                version: "0.7",
              },
            }),
          }
        : {}),
    });

    // sendUserOperation handles signing with proper ERC-4337 hash
    const userOpHash = await smClient.sendUserOperation({
      calls: [
        {
          to: this.smartAccountAddress,
          data: callData,
          value: 0n,
        },
      ],
    });

    this.nonce += 1n;
    return userOpHash as Hex;
  }

  /**
   * Wait for a UserOp to be included on-chain.
   * Polls the bundler's eth_getUserOperationReceipt.
   */
  async waitForUserOp(userOpHash: Hex, timeoutMs = 60_000): Promise<{
    transactionHash: Hex;
    success: boolean;
    blockNumber: bigint;
  }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const receipt = await this.bundlerRpc("eth_getUserOperationReceipt", [userOpHash]);
        if (receipt?.receipt) {
          return {
            transactionHash: receipt.receipt.transactionHash as Hex,
            success: receipt.receipt.status === "0x1",
            blockNumber: BigInt(receipt.receipt.blockNumber),
          };
        }
      } catch {
        // Not mined yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`UserOp ${userOpHash} not mined within ${timeoutMs}ms`);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async checkDeployment(): Promise<void> {
    const code = await this.publicClient.getCode({ address: this.smartAccountAddress });
    this.deployed = !!code && code !== "0x";
  }

  private async bundlerRpc(method: string, params: unknown[]): Promise<any> {
    const response = await fetch(this.bundlerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });
    const json = await response.json();
    if (json.error) {
      throw new Error(`Bundler RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    return json.result;
  }
}

// ---------------------------------------------------------------------------
// createGaslessClient — convenience factory for Coinbase Paymaster
// ---------------------------------------------------------------------------

/**
 * Creates a SmartAccountClient configured with Coinbase CDP Paymaster.
 *
 * The Coinbase paymaster URL acts as BOTH bundler AND paymaster:
 *   https://api.developer.coinbase.com/rpc/v1/base-sepolia/<API_KEY>
 *
 * Usage:
 *   const client = await createGaslessClient({
 *     privateKey: "0x...",
 *     coinbaseConfig: { cdpApiKey: "...", chain: "base-sepolia" }
 *   });
 */
export async function createGaslessClient(params: {
  privateKey: Hex;
  coinbaseConfig: CoinbasePaymasterConfig;
  saltNonce?: bigint;
}): Promise<SmartAccountClient> {
  const { privateKey, coinbaseConfig, saltNonce } = params;

  // Build paymaster+bundler URL
  const paymasterBundlerUrl = coinbaseConfig.paymasterBundlerUrl
    ?? buildCoinbasePaymasterUrl(coinbaseConfig);

  // Coinbase uses the same URL for bundler and paymaster
  const chain = coinbaseConfig.chain === "base" ? base : baseSepolia;

  const config: SmartAccountConfig = {
    privateKey,
    implementation: "simple",
    saltNonce: saltNonce ?? 0n,
    bundler: {
      bundlerUrl: paymasterBundlerUrl,
      paymasterUrl: paymasterBundlerUrl,
      chain,
      rpcUrl: paymasterBundlerUrl,
      entryPoint: "0.7",
    },
  };

  return SmartAccountClient.create(config);
}

/**
 * Build the Coinbase CDP Paymaster URL from an API key.
 */
export function buildCoinbasePaymasterUrl(config: CoinbasePaymasterConfig): string {
  if (config.paymasterBundlerUrl) return config.paymasterBundlerUrl;
  if (!config.cdpApiKey) {
    throw new Error("Either cdpApiKey or paymasterBundlerUrl is required for Coinbase paymaster");
  }
  const chainPath = config.chain === "base" ? "base" : "base-sepolia";
  return `${COINBASE_PAYMASTER_BASE_URL}/${chainPath}/${config.cdpApiKey}`;
}

// ---------------------------------------------------------------------------
// ABIs (minimal — just what we need for smart account interaction)
// ---------------------------------------------------------------------------

const SIMPLE_ACCOUNT_EXECUTE_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address" },
      { name: "value", type: "uint256" },
      { name: "func", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const SIMPLE_ACCOUNT_BATCH_ABI = [
  {
    name: "executeBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "func", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;
