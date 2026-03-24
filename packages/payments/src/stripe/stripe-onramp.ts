/**
 * Stripe Crypto Onramp client — creates sessions for fiat-to-crypto conversion.
 *
 * Wraps the Stripe /v1/crypto/onramp_sessions API. Used to let PCC users
 * fund escrow accounts by paying with credit card / ACH / Apple Pay.
 *
 * Production: calls real Stripe API.
 * Mock: returns simulated sessions for testing without Stripe keys.
 */
import type { Address, Id } from "@pcc/spec";
import type { FiatRampSession } from "@pcc/spec";

export interface StripeOnrampConfig {
  secretKey: string;
  publishableKey: string;
  webhookSecret?: string;
  /** Use mock mode (no real Stripe calls) */
  mock?: boolean;
}

export interface CreateOnrampSessionParams {
  /** User's wallet address on Base */
  walletAddress: Address;
  /** Amount in USD to convert */
  sourceAmount?: string;
  /** Or specify destination crypto amount */
  destinationAmount?: string;
  /** Target crypto (default: usdc) */
  destinationCurrency?: string;
  /** Target network (default: base) */
  destinationNetwork?: string;
  /** Lock wallet address (prevent user from changing) */
  lockWalletAddress?: boolean;
  /** Pre-fill customer info for KYC */
  customerEmail?: string;
  /** Linked PCC escrow ID */
  escrowId?: Id;
}

export interface StripeOnrampSession {
  id: string;
  clientSecret: string;
  status: "initialized" | "requires_payment" | "fulfillment_processing" | "fulfillment_complete" | "rejected";
  redirectUrl?: string;
}

export class StripeOnrampClient {
  private config: StripeOnrampConfig;
  private sessions = new Map<string, FiatRampSession>();

  constructor(config: StripeOnrampConfig) {
    this.config = config;
  }

  get publishableKey(): string {
    return this.config.publishableKey;
  }

  /** Create an onramp session for a user to buy crypto */
  async createSession(params: CreateOnrampSessionParams): Promise<StripeOnrampSession> {
    if (this.config.mock) {
      return this.createMockSession(params);
    }
    return this.createRealSession(params);
  }

  private async createRealSession(params: CreateOnrampSessionParams): Promise<StripeOnrampSession> {
    const body = new URLSearchParams();
    body.set("wallet_addresses[ethereum]", params.walletAddress);
    if (params.sourceAmount) body.set("source_amount", params.sourceAmount);
    if (params.destinationAmount) body.set("destination_amount", params.destinationAmount);
    body.set("destination_currency", params.destinationCurrency ?? "usdc");
    body.set("destination_network", params.destinationNetwork ?? "base");
    if (params.lockWalletAddress) body.set("lock_wallet_address", "true");
    if (params.customerEmail) body.set("customer_information[email]", params.customerEmail);

    const resp = await fetch("https://api.stripe.com/v1/crypto/onramp_sessions", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(this.config.secretKey + ":").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Stripe onramp error ${resp.status}: ${JSON.stringify(err)}`);
    }

    const data = await resp.json() as Record<string, unknown>;

    // Track session internally
    const session: FiatRampSession = {
      id: `stripe_${data.id as string}`,
      provider: "stripe",
      direction: "onramp",
      status: "created",
      fiatCurrency: "USD",
      fiatAmount: params.sourceAmount ?? "0",
      cryptoCurrency: params.destinationCurrency ?? "usdc",
      cryptoNetwork: params.destinationNetwork ?? "base",
      walletAddress: params.walletAddress,
      externalId: data.id as string,
      escrowId: params.escrowId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);

    return {
      id: data.id as string,
      clientSecret: data.client_secret as string,
      status: data.status as StripeOnrampSession["status"],
      redirectUrl: data.redirect_url as string | undefined,
    };
  }

  private createMockSession(params: CreateOnrampSessionParams): StripeOnrampSession {
    const id = `cos_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: FiatRampSession = {
      id: `stripe_${id}`,
      provider: "stripe",
      direction: "onramp",
      status: "created",
      fiatCurrency: "USD",
      fiatAmount: params.sourceAmount ?? "0",
      cryptoCurrency: params.destinationCurrency ?? "usdc",
      cryptoNetwork: params.destinationNetwork ?? "base",
      walletAddress: params.walletAddress,
      externalId: id,
      escrowId: params.escrowId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);

    return {
      id,
      clientSecret: `cos_${id}_secret_mock`,
      status: "initialized",
    };
  }

  /** Handle a Stripe webhook event for onramp session updates */
  handleWebhook(eventType: string, data: Record<string, unknown>): FiatRampSession | null {
    if (eventType !== "crypto.onramp_session_updated") return null;

    const externalId = data.id as string;
    const sessionId = `stripe_${externalId}`;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const stripeStatus = data.status as string;
    const statusMap: Record<string, FiatRampSession["status"]> = {
      initialized: "created",
      requires_payment: "pending_payment",
      fulfillment_processing: "processing",
      fulfillment_complete: "completed",
      rejected: "failed",
    };

    session.status = statusMap[stripeStatus] ?? session.status;
    session.updatedAt = new Date().toISOString();
    if (session.status === "completed") {
      session.completedAt = new Date().toISOString();
    }

    this.sessions.set(sessionId, session);
    return session;
  }

  /** Get a tracked session by internal ID */
  getSession(sessionId: string): FiatRampSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** List all tracked sessions */
  listSessions(): FiatRampSession[] {
    return Array.from(this.sessions.values());
  }
}
