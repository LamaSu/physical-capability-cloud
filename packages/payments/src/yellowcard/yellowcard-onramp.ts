/**
 * Yellowcard on-ramp — collects local fiat from users, delivers stablecoins.
 *
 * Flow (direct settlement):
 *   1. User wants to fund their PCC wallet or escrow bond
 *   2. We submit a "Collection" to Yellowcard with directSettlement=true
 *   3. Yellowcard returns bank details for the user to deposit fiat
 *   4. User sends fiat (bank transfer or mobile money)
 *   5. Yellowcard converts to stablecoins and sends to PCC wallet
 *   6. Webhook confirms completion
 */
import type { Address, Id } from "@pcc/spec";
import type { FiatRampSession } from "@pcc/spec";
import type { YellowcardClient } from "./yellowcard-client.js";

export interface OnrampParams {
  /** Amount in local fiat currency */
  fiatAmount: string;
  /** Fiat currency (NGN, KES, ZAR, BRL, MXN, etc.) */
  fiatCurrency: string;
  /** Country code */
  country: string;
  /** Channel ID */
  channelId: string;
  /** Recipient details (for KYC) */
  recipient: {
    name: string;
    country: string;
    phone: string;
    address: string;
    dob: string;
    idNumber: string;
    idType: string;
  };
  /** Source payment info */
  source?: {
    accountType: string;
    accountNumber?: string;
  };
  /** Crypto destination wallet */
  walletAddress: Address;
  /** Target crypto (default: USDC) */
  cryptoCurrency?: string;
  /** Network (default: TRC20) */
  cryptoNetwork?: string;
  /** Linked escrow */
  escrowId?: Id;
}

export interface OnrampResult {
  session: FiatRampSession;
  /** Reference number */
  reference: string;
  /** Bank details for user to deposit fiat */
  bankInfo?: {
    name: string;
    accountNumber: string;
    accountName: string;
  };
  /** Rate used */
  rate?: number;
  /** Expected crypto amount */
  cryptoAmount?: string;
}

export class YellowcardOnramp {
  private client: YellowcardClient;
  private sessions = new Map<string, FiatRampSession>();

  constructor(client: YellowcardClient) {
    this.client = client;
  }

  /** Submit a collection (local fiat → crypto) */
  async submitCollection(params: OnrampParams): Promise<OnrampResult> {
    const body = {
      recipient: params.recipient,
      source: params.source ?? { accountType: "bank" },
      channelId: params.channelId,
      sequenceId: `pcc_col_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      amount: parseFloat(params.fiatAmount),
      currency: params.fiatCurrency,
      country: params.country,
      reason: "investment",
      forceAccept: true,
      directSettlement: true,
      settlementInfo: {
        walletAddress: params.walletAddress,
        cryptoCurrency: params.cryptoCurrency ?? "USDC",
        cryptoNetwork: params.cryptoNetwork ?? "TRC20",
      },
    };

    const data = await this.client.submitCollection(body);

    const bankInfo = data.bankInfo as
      | { name: string; accountNumber: string; accountName: string }
      | undefined;
    const settlementInfo = data.settlementInfo as
      | Record<string, unknown>
      | undefined;

    const session: FiatRampSession = {
      id: `yc_onramp_${data.id as string}`,
      provider: "yellowcard",
      direction: "onramp",
      status: "pending_payment",
      fiatCurrency: params.fiatCurrency,
      fiatAmount: params.fiatAmount,
      cryptoCurrency: params.cryptoCurrency ?? "USDC",
      cryptoNetwork: params.cryptoNetwork ?? "TRC20",
      cryptoAmount: String(settlementInfo?.cryptoAmount ?? ""),
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
      bankInfo,
      rate: data.rate as number | undefined,
      cryptoAmount: String(settlementInfo?.cryptoAmount ?? ""),
    };
  }

  /** Handle Yellowcard webhook */
  handleWebhook(
    _eventType: string,
    data: Record<string, unknown>,
  ): FiatRampSession | null {
    const externalId = data.id as string;
    if (!externalId) return null;

    const sessionId = `yc_onramp_${externalId}`;
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
