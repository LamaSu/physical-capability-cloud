import { randomUUID } from "node:crypto";
import type { CdpConfig, CdpNetwork, OnrampSession } from "./types.js";

export interface CreateOnrampParams {
  /** Where the bought USDC lands (the CDP smart wallet). */
  destinationAddress: `0x${string}`;
  /** Optional preset fiat amount (USD) for the widget. */
  presetAmountUSD?: number;
}

/**
 * CdpOnrampClient — card → USDC on Base, into a destination wallet. The single human
 * step in the whole flow is opening `onrampUrl` and paying once.
 *
 * Mock-first (matches Stripe/Yellowcard). Real-mode uses CDP headless Onramp: create a
 * session server-side, return the hosted/embedded widget URL.
 */
export class CdpOnrampClient {
  private readonly network: CdpNetwork;
  private readonly mock: boolean;

  constructor(cfg: CdpConfig = {}) {
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
    throw new Error("CDP_REAL_NOT_WIRED: wire CDP headless Onramp session/URL");
  }

  async getSession(sessionId: string): Promise<Pick<OnrampSession, "sessionId" | "status">> {
    if (this.mock) {
      // Mock funds settle instantly.
      return { sessionId, status: "completed" };
    }
    throw new Error("CDP_REAL_NOT_WIRED: wire CDP onramp session status");
  }
}
