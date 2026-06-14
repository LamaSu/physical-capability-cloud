import { randomUUID } from "node:crypto";
import type { CdpConfig, CdpNetwork, CdpWallet } from "./types.js";

/**
 * CdpWalletClient — creates/reads CDP smart wallets (self-custodial, server-managed).
 * Smart accounts on Base get gasless USDC via the CDP paymaster.
 *
 * Mock-first: with no apiKeyId it returns deterministic fakes so the gateway, tests,
 * and the settlement loop work without live CDP — matching the Stripe/Yellowcard
 * modules. Real-mode wiring uses the CDP server-wallet SDK (`@coinbase/cdp-sdk`):
 *   const cdp = new CdpClient({ apiKeyId, apiSecret, walletSecret });
 *   const account = await cdp.evm.createAccount();           // or createSmartAccount()
 */
export class CdpWalletClient {
  private readonly network: CdpNetwork;
  private readonly mock: boolean;

  constructor(cfg: CdpConfig = {}) {
    this.network = cfg.network ?? "base-sepolia";
    this.mock = cfg.mock ?? !cfg.apiKeyId;
  }

  get isMock(): boolean {
    return this.mock;
  }

  /** Create a new CDP smart wallet on Base. */
  async createWallet(): Promise<CdpWallet> {
    if (this.mock) {
      return {
        address: mockAddress(),
        network: this.network,
        smartAccount: true,
        createdAt: new Date().toISOString(),
      };
    }
    throw new Error(
      "CDP_REAL_NOT_WIRED: install + /vet @coinbase/cdp-sdk, then wire cdp.evm.createSmartAccount()",
    );
  }

  /** USDC balance for an address on the configured network. */
  async getBalance(
    address: `0x${string}`,
  ): Promise<{ address: `0x${string}`; usdc: number; network: CdpNetwork }> {
    if (this.mock) {
      return { address, usdc: 0, network: this.network };
    }
    throw new Error("CDP_REAL_NOT_WIRED: wire CDP token-balance read");
  }
}

/** Deterministic-shape mock EVM address (20 bytes). */
function mockAddress(): `0x${string}` {
  const hex = (randomUUID() + randomUUID()).replace(/-/g, "");
  return ("0x" + hex.slice(0, 40)) as `0x${string}`;
}
