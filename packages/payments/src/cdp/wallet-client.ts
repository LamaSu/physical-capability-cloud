import { randomUUID } from "node:crypto";
import type { CdpConfig, CdpNetwork, CdpWallet } from "./types.js";

/**
 * CdpWalletClient — creates/reads CDP smart wallets (self-custodial, server-managed).
 * Smart accounts on Base get gasless USDC via the CDP paymaster.
 *
 * Mock/real switch is presence-of-creds: `mock = cfg.mock ?? !cfg.apiKeyId`. With no
 * apiKeyId it returns deterministic fakes (gateway/tests/settlement work offline); with
 * creds it calls the real @coinbase/cdp-sdk. The SDK is imported lazily so mock-only
 * consumers don't need it loaded.
 */
export class CdpWalletClient {
  private readonly network: CdpNetwork;
  private readonly mock: boolean;
  private readonly cfg: CdpConfig;
  private cdpClient: import("@coinbase/cdp-sdk").CdpClient | undefined;

  constructor(cfg: CdpConfig = {}) {
    this.cfg = cfg;
    this.network = cfg.network ?? "base-sepolia";
    this.mock = cfg.mock ?? !cfg.apiKeyId;
  }

  get isMock(): boolean {
    return this.mock;
  }

  private async cdp(): Promise<import("@coinbase/cdp-sdk").CdpClient> {
    if (!this.cdpClient) {
      const { CdpClient } = await import("@coinbase/cdp-sdk");
      this.cdpClient = new CdpClient({
        apiKeyId: this.cfg.apiKeyId,
        apiKeySecret: this.cfg.apiKeySecret,
        walletSecret: this.cfg.walletSecret,
      });
    }
    return this.cdpClient;
  }

  /** Create a new CDP smart wallet on Base (fresh owner EOA + ERC-4337 smart account). */
  async createWallet(): Promise<CdpWallet> {
    if (this.mock) {
      return {
        address: mockAddress(),
        network: this.network,
        smartAccount: true,
        createdAt: new Date().toISOString(),
      };
    }
    const cdp = await this.cdp();
    const owner = await cdp.evm.createAccount();
    const smart = await cdp.evm.createSmartAccount({ owner });
    return {
      address: smart.address as `0x${string}`,
      network: this.network,
      smartAccount: true,
      createdAt: new Date().toISOString(),
    };
  }

  /** USDC balance for an address on the configured network. */
  async getBalance(
    address: `0x${string}`,
  ): Promise<{ address: `0x${string}`; usdc: number; network: CdpNetwork }> {
    if (this.mock) {
      return { address, usdc: 0, network: this.network };
    }
    const cdp = await this.cdp();
    // Result-shape parsing is defensive (validated by the live smoke); the CALL is typed.
    const res = (await cdp.evm.listTokenBalances({
      address,
      network: this.network,
    })) as unknown as {
      balances?: Array<{
        token?: { symbol?: string; decimals?: number };
        amount?: { amount?: bigint };
      }>;
    };
    let usdc = 0;
    for (const b of res.balances ?? []) {
      if ((b.token?.symbol ?? "").toUpperCase() === "USDC") {
        const decimals = b.token?.decimals ?? 6;
        usdc = Number(b.amount?.amount ?? 0n) / 10 ** decimals;
      }
    }
    return { address, usdc, network: this.network };
  }

  /**
   * Faucet testnet funds (base-sepolia only). Lets the entire flow be proven on testnet
   * with no card and no real money. No-op-shaped on mainnet (the API rejects it there).
   */
  async requestFaucet(
    address: `0x${string}`,
    token: "usdc" | "eth" = "usdc",
  ): Promise<{ transactionHash: string }> {
    if (this.mock) {
      return { transactionHash: "0x" + "f".repeat(64) };
    }
    const cdp = await this.cdp();
    const res = (await cdp.evm.requestFaucet({
      address,
      network: this.network as "base-sepolia",
      token,
    })) as unknown as { transactionHash: string };
    return { transactionHash: res.transactionHash };
  }
}

/** Deterministic-shape mock EVM address (20 bytes). */
function mockAddress(): `0x${string}` {
  const hex = (randomUUID() + randomUUID()).replace(/-/g, "");
  return ("0x" + hex.slice(0, 40)) as `0x${string}`;
}
