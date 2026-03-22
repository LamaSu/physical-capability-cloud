/**
 * PGTR Client -- Payment-Gated Transaction Relay (ERC-8194) client.
 *
 * Enables keyless agent authentication by bundling EIP-3009 USDC payment
 * authorizations with target contract calls. The client:
 *
 *   1. Builds the relay request (target + callData + payment amount)
 *   2. Sends it to the gateway's PGTR relay endpoint
 *   3. The gateway relayer calls PCCForwarder.relay() on-chain
 *   4. Returns the transaction hash
 *
 * Usage:
 *   import { PGTRClient } from "@pcc/payments";
 *   const client = new PGTRClient({ gatewayUrl: "https://gateway.pcc.dev" });
 *   const result = await client.relayAction({
 *     target: escrowAddress,
 *     selector: "0x12345678",
 *     callData: "0x...",
 *     paymentAmount: "100000",  // $0.10 USDC
 *     payer: agentAddress,
 *     nonce: "0x...",
 *     expiry: Math.floor(Date.now() / 1000) + 300,
 *     v: 27, r: "0x...", s: "0x..."
 *   });
 */

import type {
  Address,
  PGTRRelayRequest,
  PGTRRelayResult,
} from "@pcc/spec";

export interface PGTRClientConfig {
  /** Gateway base URL (e.g., "http://localhost:3200") */
  gatewayUrl: string;
  /** Optional custom fetch function */
  fetchFn?: typeof globalThis.fetch;
  /** Optional authorization header for gateway auth */
  authToken?: string;
}

/**
 * Client for the PCC PGTR relay system.
 *
 * Sends relay requests to the gateway, which forwards them to the
 * PCCForwarder contract on-chain.
 */
export class PGTRClient {
  private gatewayUrl: string;
  private fetchFn: typeof globalThis.fetch;
  private authToken?: string;

  constructor(config: PGTRClientConfig) {
    this.gatewayUrl = config.gatewayUrl.replace(/\/$/, "");
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.authToken = config.authToken;
  }

  /**
   * Relay a payment-gated action through the PCCForwarder.
   *
   * The caller must have already signed an EIP-3009 transferWithAuthorization
   * for the USDC payment. The v/r/s components and nonce are included in the
   * request.
   *
   * @param request - The relay request with target, callData, payment auth
   * @returns The relay result with transaction hash
   * @throws Error if the relay fails (network, validation, or on-chain revert)
   */
  async relayAction(request: PGTRRelayRequest): Promise<PGTRRelayResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await this.fetchFn(`${this.gatewayUrl}/api/pgtr/relay`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMsg: string;
      try {
        const parsed = JSON.parse(errorBody);
        errorMsg = parsed.message || parsed.error || errorBody;
      } catch {
        errorMsg = errorBody;
      }
      throw new Error(
        `PGTR relay failed (${response.status}): ${errorMsg}`,
      );
    }

    const result: PGTRRelayResult = await response.json();
    return result;
  }

  /**
   * Check if the PGTR relay endpoint is available.
   *
   * @returns true if the relay endpoint responds, false otherwise
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchFn(
        `${this.gatewayUrl}/api/pgtr/status`,
        { method: "GET" },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Build an EIP-3009 nonce from random bytes.
   * Convenience helper for callers.
   *
   * @returns A random 32-byte hex string suitable for EIP-3009 nonce
   */
  static generateNonce(): string {
    const bytes = new Uint8Array(32);
    if (typeof globalThis.crypto !== "undefined") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      // Fallback for environments without crypto
      for (let i = 0; i < 32; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return (
      "0x" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
  }
}
