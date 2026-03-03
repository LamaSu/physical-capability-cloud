/**
 * x402 Payment Middleware — server-side.
 *
 * Wraps protected routes with HTTP 402 payment gates. When a client
 * requests a protected resource without payment, the middleware returns
 * 402 with PAYMENT-REQUIRED header. When the client retries with a
 * PAYMENT-SIGNATURE header, the middleware verifies + settles the payment
 * and passes through to the route handler.
 *
 * In production: use @x402/express or @x402/hono with a real facilitator.
 * This is a framework-agnostic implementation for the PCC MVP.
 */

import type {
  X402PaymentRequired,
  X402PaymentPayload,
  X402SettlementResponse,
  X402RouteConfig,
  Address,
} from "@pcc/spec";

export interface X402Config {
  /** Facilitator URL for verify + settle */
  facilitatorUrl: string;
  /** Network in CAIP-2 format */
  network: string;
  /** USDC contract address on the target chain */
  usdcAddress: Address;
  /** Our treasury address */
  treasuryAddress: Address;
}

/** Route pattern → payment config */
export type RoutePaymentMap = Record<string, X402RouteConfig>;

/**
 * Framework-agnostic x402 middleware logic.
 *
 * Returns helper functions that can be wired into any HTTP framework.
 */
export class X402Middleware {
  private config: X402Config;
  private routes: RoutePaymentMap;

  constructor(config: X402Config, routes: RoutePaymentMap) {
    this.config = config;
    this.routes = routes;
  }

  /**
   * Check if a request requires payment and hasn't paid yet.
   * Returns the PaymentRequired payload if payment needed, null if paid/free.
   */
  checkPayment(
    method: string,
    path: string,
    paymentSignatureHeader?: string,
  ): { requiresPayment: true; payload: X402PaymentRequired } | { requiresPayment: false } {
    const routeKey = `${method.toUpperCase()} ${path}`;
    const routeConfig = this.routes[routeKey];

    if (!routeConfig) {
      return { requiresPayment: false }; // Free route
    }

    if (paymentSignatureHeader) {
      // Payment provided — in production, verify with facilitator
      return { requiresPayment: false };
    }

    // No payment — return 402
    const priceInAtomicUnits = this.parsePrice(routeConfig.price);

    const paymentRequired: X402PaymentRequired = {
      x402Version: 2,
      resource: {
        url: path,
        description: routeConfig.description,
      },
      accepts: [
        {
          scheme: routeConfig.scheme,
          network: this.config.network,
          amount: priceInAtomicUnits,
          asset: this.config.usdcAddress,
          payTo: routeConfig.payTo,
          maxTimeoutSeconds: 300,
        },
      ],
    };

    return { requiresPayment: true, payload: paymentRequired };
  }

  /**
   * Verify a payment payload. In production: call facilitator /verify.
   * For MVP: always returns valid (mock).
   */
  async verifyPayment(paymentPayload: X402PaymentPayload): Promise<{
    valid: boolean;
    payer?: Address;
    error?: string;
  }> {
    // MVP: mock verification — always valid
    const payer = paymentPayload.payload.authorization.from;
    return { valid: true, payer };
  }

  /**
   * Settle a payment. In production: call facilitator /settle.
   * For MVP: returns mock settlement.
   */
  async settlePayment(paymentPayload: X402PaymentPayload): Promise<X402SettlementResponse> {
    // MVP: mock settlement
    return {
      success: true,
      payer: paymentPayload.payload.authorization.from,
      transaction: `0x${"0".repeat(64)}`, // mock tx hash
      network: this.config.network,
    };
  }

  /**
   * Encode a PaymentRequired payload to base64 for the header.
   */
  encodeHeader(payload: X402PaymentRequired): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }

  /**
   * Decode a PAYMENT-SIGNATURE header from base64.
   */
  decodePaymentSignature(header: string): X402PaymentPayload {
    return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  }

  /** Parse "$0.10" → "100000" (USDC has 6 decimals) */
  private parsePrice(price: string): string {
    const match = price.match(/^\$?(\d+\.?\d*)$/);
    if (!match) return "0";
    return Math.round(parseFloat(match[1]) * 1_000_000).toString();
  }
}
