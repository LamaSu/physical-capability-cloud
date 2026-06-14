import { randomUUID } from "node:crypto";
import type { CdpConfig, CdpNetwork, OnrampSession } from "./types.js";

export interface CreateOnrampParams {
  /** Where the bought USDC lands (the CDP smart wallet). */
  destinationAddress: `0x${string}`;
  /** Optional preset fiat amount (USD) for the widget. */
  presetAmountUSD?: number;
}

/**
 * CdpOnrampClient — card -> USDC on Base, into a destination wallet. The single human
 * step in the whole flow is opening `onrampUrl` and paying once.
 *
 * Mock/real switch is presence-of-creds. Onramp is real-money, so it targets Base
 * MAINNET; on testnet there's nothing to buy — fund via the wallet client's faucet
 * instead. Real-mode builds the hosted Coinbase Onramp URL from the project's
 * Onramp App ID (cfg.onrampAppId / CDP_ONRAMP_APP_ID).
 */
export class CdpOnrampClient {
  private readonly network: CdpNetwork;
  private readonly mock: boolean;
  private readonly cfg: CdpConfig;

  constructor(cfg: CdpConfig = {}) {
    this.cfg = cfg;
    this.network = cfg.network ?? "base-sepolia";
    this.mock = cfg.mock ?? !cfg.apiKeyId;
  }

  get isMock(): boolean {
    return this.mock;
  }

  async createSession(params: CreateOnrampParams): Promise<OnrampSession> {
    const sessionId = "cdp_onramp_" + randomUUID();
    if (this.mock) {
      const amt = params.presetAmountUSD ? `&presetFiatAmount=${params.presetAmountUSD}` : "";
      return {
        sessionId,
        onrampUrl:
          `https://pay.coinbase.com/buy/mock?sessionId=${sessionId}` +
          `&address=${params.destinationAddress}&asset=USDC&network=${this.network}${amt}`,
        destinationAddress: params.destinationAddress,
        asset: "USDC",
        network: this.network,
        status: "created",
        createdAt: new Date().toISOString(),
      };
    }
    // Real hosted Coinbase Onramp URL. Funds settle on Base mainnet (onramp is real money).
    const appId = this.cfg.onrampAppId ?? "";
    const addresses = encodeURIComponent(JSON.stringify({ [params.destinationAddress]: ["base"] }));
    const assets = encodeURIComponent(JSON.stringify(["USDC"]));
    const amt = params.presetAmountUSD
      ? `&presetFiatAmount=${params.presetAmountUSD}&fiatCurrency=USD`
      : "";
    return {
      sessionId,
      onrampUrl:
        `https://pay.coinbase.com/buy/select-asset?appId=${appId}` +
        `&addresses=${addresses}&assets=${assets}&defaultNetwork=base${amt}`,
      destinationAddress: params.destinationAddress,
      asset: "USDC",
      network: this.network,
      status: "created",
      createdAt: new Date().toISOString(),
    };
  }

  async getSession(sessionId: string): Promise<Pick<OnrampSession, "sessionId" | "status">> {
    // Settlement status is observed on-chain via the wallet balance (getBalance), not a
    // CDP session poll — the hosted widget owns the card flow. Report "created" until the
    // destination wallet shows the funds.
    return { sessionId, status: "created" };
  }
}
