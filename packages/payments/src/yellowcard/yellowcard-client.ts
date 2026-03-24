/**
 * Yellowcard API client — handles auth, channels, rates, networks.
 *
 * Yellowcard uses HMAC-SHA256 authentication. Every request needs:
 * - YC-Timestamp header (unix ms)
 * - Authorization: YcHmacV1 <api-key>:<signature>
 * - Signature = HMAC-SHA256(timestamp + method + path + body, secret)
 */
import { createHmac } from "node:crypto";

export interface YellowcardConfig {
  apiKey: string;
  secretKey: string;
  /** sandbox or production */
  environment?: "sandbox" | "production";
  mock?: boolean;
}

export interface YellowcardChannel {
  id: string;
  name: string;
  /** "bank" | "momo" (mobile money) */
  type: string;
  country: string;
  currency: string;
  /** "collection" | "payment" | "both" */
  direction: string;
}

export interface YellowcardNetwork {
  id: string;
  name: string;
  channelId: string;
  country: string;
}

export interface YellowcardRate {
  code: string;
  /** Fiat currency code */
  currency: string;
  /** Buy rate (fiat per 1 USD) */
  buy: number;
  /** Sell rate (fiat per 1 USD) */
  sell: number;
  /** Last updated */
  updatedAt: string;
}

const SANDBOX_URL = "https://sandbox.yellowcard.engineering/business";
const PRODUCTION_URL = "https://api.yellowcard.engineering/business";

export class YellowcardClient {
  private config: YellowcardConfig;
  private baseUrl: string;

  constructor(config: YellowcardConfig) {
    this.config = config;
    this.baseUrl =
      config.environment === "production" ? PRODUCTION_URL : SANDBOX_URL;
  }

  /** Generate HMAC auth headers */
  protected getHeaders(
    method: string,
    path: string,
    body?: string,
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const message = timestamp + method.toUpperCase() + path + (body ?? "");
    const signature = createHmac("sha256", this.config.secretKey)
      .update(message)
      .digest("hex");

    return {
      Authorization: `YcHmacV1 ${this.config.apiKey}:${signature}`,
      "YC-Timestamp": timestamp,
      "Content-Type": "application/json",
    };
  }

  // --- Mock responses for testing ---

  private mockRequest<T>(_method: string, path: string, _body?: unknown): T {
    const basePath = path.split("?")[0];

    if (basePath === "/channels") {
      return [
        {
          id: "ch_ng_bank",
          name: "Bank Transfer",
          type: "bank",
          country: "NG",
          currency: "NGN",
          direction: "both",
        },
        {
          id: "ch_ke_momo",
          name: "Mobile Money",
          type: "momo",
          country: "KE",
          currency: "KES",
          direction: "both",
        },
        {
          id: "ch_za_bank",
          name: "Bank Transfer",
          type: "bank",
          country: "ZA",
          currency: "ZAR",
          direction: "both",
        },
        {
          id: "ch_br_pix",
          name: "PIX",
          type: "bank",
          country: "BR",
          currency: "BRL",
          direction: "both",
        },
        {
          id: "ch_mx_spei",
          name: "SPEI",
          type: "bank",
          country: "MX",
          currency: "MXN",
          direction: "both",
        },
      ] as unknown as T;
    }

    if (basePath === "/rates") {
      return [
        {
          code: "NG",
          currency: "NGN",
          buy: 1617.3,
          sell: 1600.0,
          updatedAt: new Date().toISOString(),
        },
        {
          code: "KE",
          currency: "KES",
          buy: 129.5,
          sell: 128.0,
          updatedAt: new Date().toISOString(),
        },
        {
          code: "ZA",
          currency: "ZAR",
          buy: 18.4,
          sell: 18.1,
          updatedAt: new Date().toISOString(),
        },
        {
          code: "BR",
          currency: "BRL",
          buy: 5.8,
          sell: 5.7,
          updatedAt: new Date().toISOString(),
        },
      ] as unknown as T;
    }

    if (basePath === "/networks") {
      return [
        {
          id: "nw_access_bank",
          name: "Access Bank",
          channelId: "ch_ng_bank",
          country: "NG",
        },
        {
          id: "nw_mpesa",
          name: "M-PESA",
          channelId: "ch_ke_momo",
          country: "KE",
        },
        {
          id: "nw_fnb",
          name: "First National Bank",
          channelId: "ch_za_bank",
          country: "ZA",
        },
      ] as unknown as T;
    }

    if (basePath === "/collections") {
      const mockId = `yc_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        id: mockId,
        status: "processing",
        currency: "NGN",
        amount: 50,
        rate: 1617.3,
        createdAt: new Date().toISOString(),
        bankInfo: {
          name: "PAGA",
          accountNumber: "4550440202",
          accountName: "PCC Escrow",
        },
      } as unknown as T;
    }

    if (basePath === "/payments") {
      const mockId = `yc_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        id: mockId,
        status: "processing",
        currency: "NGN",
        amount: 50,
        rate: 1617.3,
        createdAt: new Date().toISOString(),
        settlementInfo: {
          cryptoNetwork: "TRC20",
          cryptoCurrency: "USDT",
          walletAddress: "TCM1FNSZaKQhodGEfPfyZ7FdRT9vrMD677",
          cryptoAmount: 48.37,
          cryptoUSDRate: 1,
        },
      } as unknown as T;
    }

    throw new Error(`Mock not implemented for path: ${path}`);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.config.mock) {
      return this.mockRequest(method, path, body);
    }

    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers = this.getHeaders(method, path, bodyStr);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: bodyStr,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(
        `Yellowcard API error ${resp.status}: ${JSON.stringify(err)}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  // --- Public API methods ---

  /** Get available payment channels for a country */
  async getChannels(country?: string): Promise<YellowcardChannel[]> {
    const path = country ? `/channels?country=${country}` : "/channels";
    return this.request("GET", path);
  }

  /** Get current exchange rates */
  async getRates(): Promise<YellowcardRate[]> {
    return this.request("GET", "/rates");
  }

  /** Get networks for a channel */
  async getNetworks(channelId: string): Promise<YellowcardNetwork[]> {
    return this.request("GET", `/networks?channelId=${channelId}`);
  }

  /** Submit a payment (off-ramp: crypto → fiat) */
  async submitPayment(body: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/payments", body);
  }

  /** Submit a collection (on-ramp: fiat → crypto) */
  async submitCollection(body: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", "/collections", body);
  }
}
