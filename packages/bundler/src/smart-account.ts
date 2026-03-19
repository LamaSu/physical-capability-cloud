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
  type Transport,
  type PublicClient,
  encodeFunctionData,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base, localhost } from "viem/chains";

import type {
  BundlerConfig,
  SmartAccountConfig,
  SmartAccountState,
  QueuedOperation,
} from "./types.js";

// ---------------------------------------------------------------------------
// EntryPoint v0.7 constants (Base Sepolia + Base Mainnet)
// ---------------------------------------------------------------------------

export const ENTRY_POINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

// SimpleAccount factory (deployed by eth-infinitism on all major chains)
export const SIMPLE_ACCOUNT_FACTORY_V07: Address = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985";

// ---------------------------------------------------------------------------
// SmartAccountClient
// ---------------------------------------------------------------------------

/**
 * A viem-based smart account client that wraps an EOA signer.
 *
 * Instead of sending raw transactions, it constructs UserOperations and
 * submits them to a bundler. The bundler packs multiple UserOps into a
 * single on-chain transaction via the EntryPoint contract.
 */
export class SmartAccountClient {
  readonly signerAddress: Address;
  readonly smartAccountAddress: Address;
  readonly implementation: "simple" | "kernel" | "safe";
  readonly chain: Chain;

  private signer: Account;
  private publicClient: PublicClient;
  private bundlerUrl: string;
  private paymasterUrl?: string;
  private deployed = false;
  private nonce = 0n;
  private saltNonce: bigint;

  constructor(config: SmartAccountConfig) {
    this.signer = privateKeyToAccount(config.privateKey);
    this.signerAddress = this.signer.address;
    this.implementation = config.implementation ?? "simple";
    this.chain = config.bundler.chain;
    this.bundlerUrl = config.bundler.bundlerUrl;
    this.paymasterUrl = config.bundler.paymasterUrl;
    this.saltNonce = config.saltNonce ?? 0n;

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.bundler.rpcUrl),
    });

    // Compute counterfactual address from factory + signer + salt
    this.smartAccountAddress = this.computeCounterfactualAddress();
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
   * Returns the UserOp hash (not a tx hash — the bundler will include it in a future block).
   */
  async sendUserOp(callData: Hex): Promise<Hex> {
    await this.refreshNonce();

    const initCode = this.deployed ? "0x" as Hex : this.getInitCode();

    // Estimate gas via bundler RPC
    const gasEstimate = await this.estimateUserOpGas(callData, initCode);

    // Get fee data from chain
    const feeData = await this.publicClient.estimateFeesPerGas();

    const userOp = {
      sender: this.smartAccountAddress,
      nonce: `0x${this.nonce.toString(16)}`,
      initCode,
      callData,
      callGasLimit: `0x${gasEstimate.callGasLimit.toString(16)}`,
      verificationGasLimit: `0x${gasEstimate.verificationGasLimit.toString(16)}`,
      preVerificationGas: `0x${gasEstimate.preVerificationGas.toString(16)}`,
      maxFeePerGas: `0x${(feeData.maxFeePerGas ?? 1000000000n).toString(16)}`,
      maxPriorityFeePerGas: `0x${(feeData.maxPriorityFeePerGas ?? 100000000n).toString(16)}`,
      paymasterAndData: "0x" as Hex,
      signature: "0x" as Hex,
    };

    // Request paymaster sponsorship if configured
    if (this.paymasterUrl) {
      const sponsorship = await this.requestSponsorship(userOp);
      if (sponsorship) {
        userOp.paymasterAndData = sponsorship;
      }
    }

    // Sign the UserOp
    userOp.signature = await this.signUserOp(userOp);

    // Submit to bundler
    const userOpHash = await this.submitToBundler(userOp);
    this.nonce += 1n;

    return userOpHash;
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

  private computeCounterfactualAddress(): Address {
    // In production, this is computed via CREATE2 from the factory.
    // For now, derive deterministically from signer + salt for consistency.
    // The real address comes from the factory's getAddress() view function.
    const hash = BigInt(this.signerAddress) ^ this.saltNonce;
    const bytes = hash.toString(16).padStart(40, "0").slice(0, 40);
    return `0x${bytes}` as Address;
  }

  private getInitCode(): Hex {
    // Factory address + createAccount(owner, salt) calldata
    const createCalldata = encodeFunctionData({
      abi: SIMPLE_ACCOUNT_FACTORY_ABI,
      functionName: "createAccount",
      args: [this.signerAddress, this.saltNonce],
    });
    return `${SIMPLE_ACCOUNT_FACTORY_V07}${createCalldata.slice(2)}` as Hex;
  }

  private async checkDeployment(): Promise<void> {
    const code = await this.publicClient.getCode({ address: this.smartAccountAddress });
    this.deployed = !!code && code !== "0x";
  }

  private async refreshNonce(): Promise<void> {
    try {
      const nonce = await this.publicClient.readContract({
        address: ENTRY_POINT_V07,
        abi: ENTRY_POINT_NONCE_ABI,
        functionName: "getNonce",
        args: [this.smartAccountAddress, 0n],
      });
      this.nonce = nonce as bigint;
    } catch {
      // Account not deployed yet — nonce is 0
      this.nonce = 0n;
    }
  }

  private async estimateUserOpGas(
    callData: Hex,
    initCode: Hex,
  ): Promise<{ callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint }> {
    try {
      const result = await this.bundlerRpc("eth_estimateUserOperationGas", [
        {
          sender: this.smartAccountAddress,
          nonce: `0x${this.nonce.toString(16)}`,
          initCode,
          callData,
          paymasterAndData: "0x",
          signature: "0x" + "ff".repeat(65), // dummy signature for estimation
        },
        ENTRY_POINT_V07,
      ]);
      return {
        callGasLimit: BigInt(result.callGasLimit),
        verificationGasLimit: BigInt(result.verificationGasLimit),
        preVerificationGas: BigInt(result.preVerificationGas),
      };
    } catch {
      // Fallback: use conservative defaults
      return {
        callGasLimit: 500_000n,
        verificationGasLimit: 500_000n,
        preVerificationGas: 100_000n,
      };
    }
  }

  private async signUserOp(userOp: Record<string, unknown>): Promise<Hex> {
    // Hash the UserOp fields and sign with the EOA signer
    const message = JSON.stringify({
      sender: userOp.sender,
      nonce: userOp.nonce,
      callData: userOp.callData,
      callGasLimit: userOp.callGasLimit,
      verificationGasLimit: userOp.verificationGasLimit,
      preVerificationGas: userOp.preVerificationGas,
      maxFeePerGas: userOp.maxFeePerGas,
      maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
    });

    return this.signer.signMessage!({ message }) as Promise<Hex>;
  }

  private async requestSponsorship(userOp: Record<string, unknown>): Promise<Hex | null> {
    if (!this.paymasterUrl) return null;

    try {
      const result = await fetch(this.paymasterUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "pm_sponsorUserOperation",
          params: [userOp, ENTRY_POINT_V07],
        }),
      });
      const json = await result.json();
      return json.result?.paymasterAndData as Hex ?? null;
    } catch {
      return null;
    }
  }

  private async submitToBundler(userOp: Record<string, unknown>): Promise<Hex> {
    const result = await this.bundlerRpc("eth_sendUserOperation", [userOp, ENTRY_POINT_V07]);
    return result as Hex;
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

const SIMPLE_ACCOUNT_FACTORY_ABI = [
  {
    name: "createAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "ret", type: "address" }],
  },
] as const;

const ENTRY_POINT_NONCE_ABI = [
  {
    name: "getNonce",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;
