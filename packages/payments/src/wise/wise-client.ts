/**
 * Wise Platform API client — handles profiles, quotes, transfers, recipients.
 *
 * Wise provides fiat-to-fiat transfers across 40+ currencies. Used in PCC for:
 * - Enterprise operator payouts (institutional bank accounts)
 * - Fiat-only mode wrapper (enterprise users who won't touch crypto)
 * - Treasury management (multi-currency distribution of protocol fees)
 *
 * Auth: Bearer token (API token generated from Wise Business account).
 */

export interface WiseConfig {
  apiToken: string;
  profileId?: string;
  /** sandbox or production */
  environment?: "sandbox" | "production";
  mock?: boolean;
}

export interface WiseProfile {
  id: number;
  type: "personal" | "business";
  fullName: string;
}

export interface WiseQuote {
  id: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: number;
  targetAmount: number;
  rate: number;
  fee: number;
  estimatedDelivery: string;
}

export interface WiseRecipient {
  id: number;
  fullName: string;
  currency: string;
  type: string;
  details: Record<string, unknown>;
}

export interface WiseTransfer {
  id: number;
  reference: string;
  status: "incoming_payment_waiting" | "processing" | "funds_converted" | "outgoing_payment_sent" | "completed" | "cancelled";
  sourceAmount: number;
  sourceCurrency: string;
  targetAmount: number;
  targetCurrency: string;
  rate: number;
  created: string;
  estimatedDelivery: string;
  recipientId: number;
  quoteId: string;
}

const SANDBOX_URL = "https://api.sandbox.transferwise.tech";
const PRODUCTION_URL = "https://api.wise.com";

export class WiseClient {
  private config: WiseConfig;
  private baseUrl: string;

  constructor(config: WiseConfig) {
    this.config = config;
    this.baseUrl = config.environment === "production" ? PRODUCTION_URL : SANDBOX_URL;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.config.mock) {
      return this.mockRequest(method, path, body);
    }

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Wise API error ${resp.status}: ${JSON.stringify(err)}`);
    }

    return resp.json() as Promise<T>;
  }

  private mockRequest<T>(method: string, path: string, body?: unknown): T {
    // Fund transfer: POST /v3/profiles/{id}/transfers/{id}/payments
    // Must match before /transfers and /profiles checks
    if (path.includes("/transfers/") && path.endsWith("/payments") && method === "POST") {
      return { status: "COMPLETED" } as unknown as T;
    }

    // Quotes: POST /v3/profiles/{id}/quotes
    if (path.includes("/quotes") && method === "POST") {
      const b = body as Record<string, unknown> | undefined;
      return {
        id: `quote_mock_${Date.now()}`,
        sourceCurrency: (b?.sourceCurrency as string) ?? "USD",
        targetCurrency: (b?.targetCurrency as string) ?? "GBP",
        sourceAmount: (b?.sourceAmount as number) ?? 100,
        targetAmount: ((b?.sourceAmount as number) ?? 100) * 0.79,
        rate: 0.79,
        fee: 0.45,
        estimatedDelivery: new Date(Date.now() + 20000).toISOString(),
      } as unknown as T;
    }

    // Profiles: GET /v1/profiles
    if (path === "/v1/profiles" && method === "GET") {
      return [
        { id: 12345, type: "business", fullName: "PCC Treasury" },
      ] as unknown as T;
    }

    // Recipient accounts: POST /v1/accounts
    if (path.includes("/accounts") && method === "POST") {
      return {
        id: Math.floor(Math.random() * 100000),
        fullName: (body as Record<string, unknown>)?.accountHolderName ?? "Test Recipient",
        currency: (body as Record<string, unknown>)?.currency ?? "GBP",
        type: "sort_code",
        details: (body as Record<string, unknown>)?.details ?? {},
      } as unknown as T;
    }

    // Create transfer: POST /v1/transfers
    if (path === "/v1/transfers" && method === "POST") {
      const b = body as Record<string, unknown> | undefined;
      return {
        id: Math.floor(Math.random() * 100000),
        reference: (b?.reference as string) ?? `PCC-${Date.now()}`,
        status: "processing",
        sourceAmount: 100,
        sourceCurrency: "USD",
        targetAmount: 79,
        targetCurrency: "GBP",
        rate: 0.79,
        created: new Date().toISOString(),
        estimatedDelivery: new Date(Date.now() + 20000).toISOString(),
        recipientId: b?.targetAccount as number ?? 0,
        quoteId: b?.quoteUuid as string ?? "",
      } as unknown as T;
    }

    // Get transfer: GET /v1/transfers/{id}
    if (path.startsWith("/v1/transfers/") && method === "GET") {
      return {
        id: 1,
        reference: "PCC-test",
        status: "completed",
        sourceAmount: 100,
        sourceCurrency: "USD",
        targetAmount: 79,
        targetCurrency: "GBP",
        rate: 0.79,
        created: new Date().toISOString(),
        estimatedDelivery: new Date().toISOString(),
        recipientId: 1,
        quoteId: "q_1",
      } as unknown as T;
    }

    throw new Error(`Mock not implemented: ${method} ${path}`);
  }

  // --- Public API ---

  /** Get profiles */
  async getProfiles(): Promise<WiseProfile[]> {
    return this.request("GET", "/v1/profiles");
  }

  /** Create a quote */
  async createQuote(params: {
    profileId: number;
    sourceCurrency: string;
    targetCurrency: string;
    sourceAmount: number;
  }): Promise<WiseQuote> {
    return this.request("POST", `/v3/profiles/${params.profileId}/quotes`, {
      sourceCurrency: params.sourceCurrency,
      targetCurrency: params.targetCurrency,
      sourceAmount: params.sourceAmount,
      targetAmountIsFixed: false,
    });
  }

  /** Create a recipient account */
  async createRecipient(params: {
    profileId: number;
    accountHolderName: string;
    currency: string;
    type: string;
    details: Record<string, unknown>;
  }): Promise<WiseRecipient> {
    return this.request("POST", "/v1/accounts", {
      profile: params.profileId,
      accountHolderName: params.accountHolderName,
      currency: params.currency,
      type: params.type,
      details: params.details,
    });
  }

  /** Create a transfer */
  async createTransfer(params: {
    targetAccount: number;
    quoteUuid: string;
    reference: string;
  }): Promise<WiseTransfer> {
    return this.request("POST", "/v1/transfers", {
      targetAccount: params.targetAccount,
      quoteUuid: params.quoteUuid,
      customerTransactionId: `pcc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      details: { reference: params.reference },
    });
  }

  /** Fund a transfer (trigger actual bank transfer) */
  async fundTransfer(profileId: number, transferId: number): Promise<{ status: string }> {
    return this.request("POST", `/v3/profiles/${profileId}/transfers/${transferId}/payments`, {
      type: "BALANCE",
    });
  }

  /** Get transfer status */
  async getTransfer(transferId: number): Promise<WiseTransfer> {
    return this.request("GET", `/v1/transfers/${transferId}`);
  }
}
