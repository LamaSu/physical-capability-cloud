/**
 * x402 Client — handles automatic payment for x402-protected resources.
 *
 * Usage:
 *   const client = new X402Client({ walletAddress, signFn });
 *   const data = await client.fetch("https://api.pcc.dev/quote", { method: "POST", body: cwm });
 *
 * If the server returns 402, the client automatically:
 *   1. Reads the PAYMENT-REQUIRED header
 *   2. Constructs and signs a payment authorization
 *   3. Retries the request with PAYMENT-SIGNATURE header
 */

import type { X402PaymentRequired, X402PaymentPayload, Address } from "@pcc/spec";

export interface X402ClientConfig {
  walletAddress: Address;
  /** Sign function — in production, use ethers.js or viem wallet */
  signFn: (message: string) => Promise<string>;
}

export class X402Client {
  private config: X402ClientConfig;

  constructor(config: X402ClientConfig) {
    this.config = config;
  }

  /**
   * Fetch a resource, automatically handling x402 payment if needed.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    // First attempt
    const response = await globalThis.fetch(url, init);

    if (response.status !== 402) {
      return response; // No payment needed
    }

    // Read payment requirements
    const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      throw new Error("402 response missing PAYMENT-REQUIRED header");
    }

    const paymentRequired: X402PaymentRequired = JSON.parse(
      Buffer.from(paymentRequiredHeader, "base64").toString("utf-8"),
    );

    if (paymentRequired.accepts.length === 0) {
      throw new Error("No payment methods accepted");
    }

    // Select first accepted method
    const accepted = paymentRequired.accepts[0];

    // Construct payment authorization
    const nonce = `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    const now = Math.floor(Date.now() / 1000);

    const authorization = {
      from: this.config.walletAddress,
      to: accepted.payTo as Address,
      value: accepted.amount,
      validAfter: (now - 60).toString(),
      validBefore: (now + accepted.maxTimeoutSeconds).toString(),
      nonce,
    };

    // Sign (mock for MVP)
    const signature = await this.config.signFn(JSON.stringify(authorization));

    const paymentPayload: X402PaymentPayload = {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted,
      payload: {
        signature,
        authorization,
      },
    };

    // Retry with payment
    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const retryInit: RequestInit = {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string>),
        "PAYMENT-SIGNATURE": paymentHeader,
      },
    };

    return globalThis.fetch(url, retryInit);
  }
}
