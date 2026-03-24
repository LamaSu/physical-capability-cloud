/**
 * Yellowcard off-ramp — converts stablecoins to local fiat for operator payouts.
 *
 * Flow (direct settlement):
 *   1. Operator requests withdrawal with destination bank/mobile money
 *   2. We submit a "Payment" to Yellowcard with directSettlement=true
 *   3. Yellowcard provides a crypto deposit address
 *   4. PCC sends stablecoins to that address
 *   5. Yellowcard converts and disburses local fiat to operator
 *   6. Webhook confirms completion
 */
import type { Address, Id } from "@pcc/spec";
import type { FiatRampSession, WithdrawalDestination } from "@pcc/spec";
import type { YellowcardClient } from "./yellowcard-client.js";

export interface OfframpParams {
  /** Operator wallet address (source of crypto) */
  walletAddress: Address;
  /** Amount in USD to withdraw */
  amountUsd: string;
  /** Target fiat currency (NGN, KES, ZAR, BRL, MXN, etc.) */
  fiatCurrency: string;
  /** Country code */
  country: string;
  /** Yellowcard channel ID (bank transfer, mobile money, etc.) */
  channelId: string;
  /** Destination details */
  destination: WithdrawalDestination;
  /** Sender KYC info */
  sender: {
    name: string;
    country: string;
    address: string;
    dob: string;
    email: string;
    idNumber: string;
    idType: string;
  };
  /** Crypto to send (default: USDT) */
  cryptoCurrency?: string;
  /** Network (default: TRC20 — cheapest fees) */
  cryptoNetwork?: string;
  /** Reason for payment */
  reason?: string;
  /** Linked PCC escrow ID */
  escrowId?: Id;
}

export interface OfframpResult {
  session: FiatRampSession;
  /** Yellowcard payment reference */
  reference: string;
  /** Crypto deposit address (where PCC sends stablecoins) */
  depositAddress?: string;
  /** Crypto amount to send */
  cryptoAmount?: string;
  /** Rate used */
  rate?: number;
}

export class YellowcardOfframp {
  private client: YellowcardClient;
  private sessions = new Map<string, FiatRampSession>();

  constructor(client: YellowcardClient) {
    this.client = client;
  }

  /** Submit an off-ramp payment (crypto → local fiat) */
  async submitWithdrawal(params: OfframpParams): Promise<OfframpResult> {
    const body = {
      sender: params.sender,
      destination: {
        accountName: params.destination.accountName,
        accountNumber: params.destination.accountNumber,
        accountType:
          params.destination.type === "mobile_money" ? "momo" : "bank",
        ...(params.destination.networkName
          ? { networkId: params.destination.networkName }
          : {}),
      },
      channelId: params.channelId,
      sequenceId: `pcc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      currency: params.fiatCurrency,
      country: params.country,
      reason: params.reason ?? "service_payment",
      forceAccept: true,
      directSettlement: true,
      settlementInfo: {
        cryptoCurrency: params.cryptoCurrency ?? "USDT",
        cryptoNetwork: params.cryptoNetwork ?? "TRC20",
        cryptoAmount: parseFloat(params.amountUsd),
      },
    };

    const data = await this.client.submitPayment(body);

    const settlementInfo = data.settlementInfo as
      | Record<string, unknown>
      | undefined;

    const session: FiatRampSession = {
      id: `yc_offramp_${data.id as string}`,
      provider: "yellowcard",
      direction: "offramp",
      status: "processing",
      fiatCurrency: params.fiatCurrency,
      fiatAmount: String(data.convertedAmount ?? "0"),
      cryptoCurrency: params.cryptoCurrency ?? "USDT",
      cryptoNetwork: params.cryptoNetwork ?? "TRC20",
      cryptoAmount: String(
        settlementInfo?.cryptoAmount ?? params.amountUsd,
      ),
      walletAddress: params.walletAddress,
      externalId: data.id as string,
      escrowId: params.escrowId,
      rate: String(data.rate ?? ""),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);

    return {
      session,
      reference: (data.reference as string) ?? (data.id as string),
      depositAddress: settlementInfo?.walletAddress as string | undefined,
      cryptoAmount: String(settlementInfo?.cryptoAmount ?? params.amountUsd),
      rate: data.rate as number | undefined,
    };
  }

  /** Handle Yellowcard webhook for payment status updates */
  handleWebhook(
    _eventType: string,
    data: Record<string, unknown>,
  ): FiatRampSession | null {
    const externalId = data.id as string;
    if (!externalId) return null;

    const sessionId = `yc_offramp_${externalId}`;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const statusMap: Record<string, FiatRampSession["status"]> = {
      processing: "processing",
      completed: "completed",
      failed: "failed",
      expired: "expired",
    };

    const newStatus = data.status as string;
    session.status = statusMap[newStatus] ?? session.status;
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
