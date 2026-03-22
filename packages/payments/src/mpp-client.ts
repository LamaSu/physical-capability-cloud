/**
 * MPP Client -- handles automatic payment for MPP-protected resources.
 *
 * Drop-in replacement for X402Client. Uses mppx/client to automatically
 * handle 402 Payment Required responses with Tempo charge method.
 *
 * The old x402-client.ts is DEPRECATED but preserved for fallback.
 *
 * Usage:
 *   import { MppClient } from "@pcc/payments";
 *   const client = MppClient.create({ account });
 *   const res = await client.fetch("https://api.pcc.dev/quote", { method: "POST", body });
 *
 * If the server returns 402 with WWW-Authenticate header, the client
 * automatically creates a Tempo payment credential and retries.
 */

import { Mppx, tempo } from "mppx/client";
import type { Address } from "@pcc/spec";

export interface MppClientConfig {
  /**
   * Viem account for signing transactions.
   * Can be a local account (privateKeyToAccount) or an address string.
   * When passing an address string, you must also provide getClient.
   */
  account: `0x${string}` | { address: `0x${string}` };
  /**
   * Optional custom fetch function to wrap.
   * Defaults to globalThis.fetch.
   */
  fetchFn?: typeof globalThis.fetch;
  /**
   * Whether to polyfill globalThis.fetch with payment-aware wrapper.
   * Default: false (safer for library usage -- does not modify globals)
   */
  polyfill?: boolean;
}

/**
 * MPP Client wrapping mppx/client with Tempo charge method.
 *
 * Provides a `fetch()` function that automatically handles 402 responses
 * by creating Tempo payment credentials and retrying the request.
 */
export class MppClient {
  private mppx: ReturnType<typeof Mppx.create>;

  private constructor(mppx: ReturnType<typeof Mppx.create>) {
    this.mppx = mppx;
  }

  /**
   * Create an MppClient instance.
   *
   * @param config - Client configuration with account for signing
   * @returns MppClient instance with payment-aware fetch
   */
  static create(config: MppClientConfig): MppClient {
    const account = typeof config.account === "string"
      ? config.account
      : config.account.address;

    const mppx = Mppx.create({
      methods: [
        tempo.charge({ account }),
      ],
      fetch: config.fetchFn,
      polyfill: config.polyfill ?? false,
    });

    return new MppClient(mppx);
  }

  /**
   * Payment-aware fetch that automatically handles 402 responses.
   *
   * If the server returns 402 with WWW-Authenticate header containing
   * a Tempo challenge, the client automatically:
   * 1. Parses the challenge
   * 2. Creates a signed payment credential
   * 3. Retries the request with Authorization header
   */
  async fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    return this.mppx.fetch(url, init);
  }

  /**
   * Access the raw (non-payment-aware) fetch function.
   * Useful for requests that should not be intercepted.
   */
  get rawFetch(): typeof globalThis.fetch {
    return this.mppx.rawFetch;
  }

  /**
   * Restore globalThis.fetch if polyfill was enabled.
   * Only needed if polyfill: true was set in config.
   */
  static restore(): void {
    Mppx.restore();
  }
}
