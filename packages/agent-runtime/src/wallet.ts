/**
 * Agent Wallet — each agent controls a wallet that can sign messages,
 * approve token transfers, and fund escrow contracts.
 *
 * Uses viem for Ethereum interaction. In v1 we use local private keys.
 * In production: HSM, MPC wallets, or Coinbase Wallet SDK.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type WalletClient,
  type PublicClient,
  type Account,
  type Chain,
  type Transport,
  type Address,
  parseEther,
  parseUnits,
  formatUnits,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia, base, localhost } from "viem/chains";

export interface WalletConfig {
  /** Private key (hex). If not provided, generates a new one. */
  privateKey?: `0x${string}`;
  /** Chain to use */
  chain?: "base" | "base-sepolia" | "localhost";
  /** RPC URL override */
  rpcUrl?: string;
}

const CHAINS: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
  localhost,
};

export class AgentWallet {
  readonly address: Address;
  readonly account: Account;
  private walletClient: WalletClient;
  private publicClient: PublicClient;
  private chain: Chain;

  constructor(config: WalletConfig = {}) {
    const key = config.privateKey ?? generatePrivateKey();
    this.account = privateKeyToAccount(key);
    this.address = this.account.address;
    this.chain = CHAINS[config.chain ?? "base-sepolia"] ?? baseSepolia;

    const transport = http(config.rpcUrl);

    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport,
    });

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport,
    });
  }

  /** Sign a message (for A2A message authentication) */
  async signMessage(message: string): Promise<string> {
    return this.walletClient.signMessage({
      account: this.account,
      message,
    });
  }

  /** Get ETH balance */
  async getBalance(): Promise<string> {
    const balance = await this.publicClient.getBalance({ address: this.address });
    return formatUnits(balance, 18);
  }

  /** Get ERC-20 token balance */
  async getTokenBalance(tokenAddress: Address): Promise<string> {
    const data = await this.publicClient.readContract({
      address: tokenAddress,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [this.address],
    });
    return formatUnits(data as bigint, 6); // USDC = 6 decimals
  }

  /** Approve ERC-20 spending (e.g., for escrow contract) */
  async approveToken(
    tokenAddress: Address,
    spender: Address,
    amount: string,
  ): Promise<string> {
    const hash = await this.walletClient.writeContract({
      chain: this.chain,
      account: this.account,
      address: tokenAddress,
      abi: [
        {
          name: "approve",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ] as const,
      functionName: "approve",
      args: [spender, parseUnits(amount, 6)],
    });
    return hash;
  }

  /** Fund an escrow contract (after approval) */
  async fundEscrow(escrowAddress: Address): Promise<string> {
    const hash = await this.walletClient.writeContract({
      chain: this.chain,
      account: this.account,
      address: escrowAddress,
      abi: [
        {
          name: "fund",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [],
          outputs: [],
        },
      ] as const,
      functionName: "fund",
      args: [],
    });
    return hash;
  }

  /** Generic contract call */
  async callContract(
    address: Address,
    abi: readonly any[],
    functionName: string,
    args: readonly any[],
  ): Promise<string> {
    const hash = await this.walletClient.writeContract({
      chain: this.chain,
      account: this.account,
      address,
      abi: abi as any,
      functionName,
      args: args as any,
    });
    return hash;
  }

  /** Read from a contract (no gas) */
  async readContract(
    address: Address,
    abi: readonly any[],
    functionName: string,
    args: readonly any[] = [],
  ): Promise<unknown> {
    return this.publicClient.readContract({
      address,
      abi: abi as any,
      functionName,
      args: args as any,
    });
  }

  /** Sign EIP-712 typed data (for x402 payments) */
  async signTypedData(domain: any, types: any, message: any): Promise<string> {
    return this.walletClient.signTypedData({
      account: this.account,
      domain,
      types,
      primaryType: Object.keys(types)[0],
      message,
    });
  }

  getChain(): Chain {
    return this.chain;
  }
}
