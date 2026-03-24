/**
 * Wise batch payout service — sends fiat to operators' bank accounts.
 *
 * Used for:
 * - Enterprise operator payouts (after USDC is off-ramped to fiat)
 * - Fiat-only mode (enterprise users never see crypto)
 * - Treasury distribution (protocol fees → multi-currency payouts)
 */
import type { Address } from "@pcc/spec";
import type { FiatRampSession } from "@pcc/spec";
import type { WiseClient, WiseQuote, WiseRecipient, WiseTransfer } from "./wise-client.js";

export interface PayoutRecipient {
  /** Operator name */
  name: string;
  /** Target currency (GBP, EUR, NGN, etc.) */
  currency: string;
  /** Account type (sort_code, iban, aba, etc.) */
  type: string;
  /** Bank details */
  details: Record<string, unknown>;
}

export interface PayoutRequest {
  /** PCC profile ID on Wise */
  profileId: number;
  /** Amount in source currency (USD) */
  sourceAmount: number;
  /** Source currency (default: USD) */
  sourceCurrency?: string;
  /** Recipient details */
  recipient: PayoutRecipient;
  /** Reference for tracking */
  reference: string;
  /** Linked escrow ID */
  escrowId?: string;
}

export interface PayoutResult {
  session: FiatRampSession;
  quote: WiseQuote;
  recipient: WiseRecipient;
  transfer: WiseTransfer;
}

export interface BatchPayoutResult {
  successful: PayoutResult[];
  failed: Array<{ request: PayoutRequest; error: string }>;
  totalSourceAmount: number;
  totalTargetAmount: number;
}

export class WisePayoutService {
  private client: WiseClient;
  private sessions = new Map<string, FiatRampSession>();

  constructor(client: WiseClient) {
    this.client = client;
  }

  /** Execute a single payout */
  async sendPayout(params: PayoutRequest): Promise<PayoutResult> {
    // 1. Create quote
    const quote = await this.client.createQuote({
      profileId: params.profileId,
      sourceCurrency: params.sourceCurrency ?? "USD",
      targetCurrency: params.recipient.currency,
      sourceAmount: params.sourceAmount,
    });

    // 2. Create recipient
    const recipient = await this.client.createRecipient({
      profileId: params.profileId,
      accountHolderName: params.recipient.name,
      currency: params.recipient.currency,
      type: params.recipient.type,
      details: params.recipient.details,
    });

    // 3. Create transfer
    const transfer = await this.client.createTransfer({
      targetAccount: recipient.id,
      quoteUuid: quote.id,
      reference: params.reference,
    });

    // 4. Fund transfer
    await this.client.fundTransfer(params.profileId, transfer.id);

    // Track session
    const session: FiatRampSession = {
      id: `wise_${transfer.id}`,
      provider: "wise",
      direction: "offramp",
      status: "processing",
      fiatCurrency: params.recipient.currency,
      fiatAmount: String(quote.targetAmount),
      cryptoCurrency: "USDC",
      cryptoNetwork: "base",
      cryptoAmount: String(params.sourceAmount),
      walletAddress: "0x0000000000000000000000000000000000000000" as Address,
      externalId: String(transfer.id),
      escrowId: params.escrowId,
      rate: String(quote.rate),
      fees: {
        providerFee: String(quote.fee),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);

    return { session, quote, recipient, transfer };
  }

  /** Execute batch payouts — continues even if some fail */
  async sendBatch(requests: PayoutRequest[]): Promise<BatchPayoutResult> {
    const result: BatchPayoutResult = {
      successful: [],
      failed: [],
      totalSourceAmount: 0,
      totalTargetAmount: 0,
    };

    for (const req of requests) {
      try {
        const payout = await this.sendPayout(req);
        result.successful.push(payout);
        result.totalSourceAmount += req.sourceAmount;
        result.totalTargetAmount += payout.quote.targetAmount;
      } catch (err) {
        result.failed.push({
          request: req,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /** Check transfer status and update session */
  async checkStatus(transferId: number): Promise<FiatRampSession | null> {
    const sessionId = `wise_${transferId}`;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const transfer = await this.client.getTransfer(transferId);

    const statusMap: Record<string, FiatRampSession["status"]> = {
      incoming_payment_waiting: "pending_payment",
      processing: "processing",
      funds_converted: "processing",
      outgoing_payment_sent: "processing",
      completed: "completed",
      cancelled: "failed",
    };

    session.status = statusMap[transfer.status] ?? session.status;
    session.updatedAt = new Date().toISOString();
    if (session.status === "completed") {
      session.completedAt = new Date().toISOString();
    }

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(id: string): FiatRampSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): FiatRampSession[] {
    return Array.from(this.sessions.values());
  }
}
