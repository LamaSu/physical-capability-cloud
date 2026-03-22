/**
 * MPP Payment Middleware -- server-side.
 *
 * Wraps the mppx library (Machine-Payable Protocol) to provide a
 * server-side payment gate using Tempo charge method. This is the
 * successor to x402-middleware.ts for the PCC gateway.
 *
 * The old x402-middleware.ts is DEPRECATED but preserved for fallback.
 * This module provides the same logical interface (check routes, gate
 * requests, verify/settle) but uses mppx's WWW-Authenticate / Authorization
 * header protocol instead of x402's custom PAYMENT-REQUIRED / PAYMENT-SIGNATURE.
 *
 * Environment variables:
 *   MPP_SECRET_KEY    - HMAC secret for challenge IDs (required in production)
 *   MPP_REALM         - Server realm (auto-detected if not set)
 *   TEMPO_RECIPIENT   - Treasury/recipient address
 *   TEMPO_CURRENCY    - ERC-20 token address (default: Base Sepolia USDC)
 *   MPP_TESTNET       - "true" to use testnet mode
 */

import { Mppx, tempo } from "mppx/server";
import type {
  MppConfig,
  MppRouteConfig,
  MppRouteMap,
} from "@pcc/spec";

export type { MppRouteMap };

export interface MppMiddlewareConfig extends MppConfig {
  /** Protected routes -- "METHOD /path" -> MppRouteConfig */
  routes: MppRouteMap;
}

/** Result from an mppx charge handler */
export interface MppChargeResult {
  status: 402 | 200;
  /** Present when status=402: the 402 Response with WWW-Authenticate header */
  challenge?: Response;
  /** Present when status=200: function to attach Payment-Receipt header to response */
  withReceipt?: (response: Response) => Response;
}

/**
 * Framework-agnostic MPP middleware logic.
 *
 * Wraps mppx's Mppx.create() with Tempo charge method to provide:
 * - Route-based payment gating (like X402Middleware.checkPayment)
 * - Payment challenge generation (WWW-Authenticate headers)
 * - Payment credential verification (Authorization headers)
 *
 * Usage in Fastify: see x402-gate.ts (MPP_ENABLED=true branch)
 */
export class MppMiddleware {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mppx types are deeply generic, not portable across resolution modes
  private mppx: any;
  private routes: MppRouteMap;
  private config: MppMiddlewareConfig;

  constructor(config: MppMiddlewareConfig) {
    this.config = config;
    this.routes = config.routes;

    this.mppx = Mppx.create({
      methods: [
        tempo.charge({
          currency: config.currency,
          recipient: config.recipient,
          testnet: config.testnet ?? true,
        }),
      ],
      secretKey: config.secretKey,
      realm: config.realm,
    });
  }

  /**
   * Check if a route is protected and create a handler for it.
   * Returns null for free routes, or a handler function for protected routes.
   */
  getRouteHandler(method: string, path: string): {
    isProtected: true;
    routeConfig: MppRouteConfig;
  } | {
    isProtected: false;
  } {
    const routeKey = `${method.toUpperCase()} ${path}`;
    const routeConfig = this.routes[routeKey];
    if (!routeConfig) {
      return { isProtected: false };
    }
    return { isProtected: true, routeConfig };
  }

  /**
   * Create an mppx charge handler for a specific request.
   * Returns a function that takes a Request and returns the mppx result.
   *
   * The result is either:
   * - { status: 402, challenge } - payment needed, send challenge as response
   * - { status: 200, withReceipt } - payment verified, attach receipt to response
   */
  createChargeHandler(routeConfig: MppRouteConfig): (input: Request) => Promise<MppChargeResult> {
    const handler = this.mppx.charge({
      amount: routeConfig.amount,
      description: routeConfig.description,
      externalId: routeConfig.externalId,
    });
    // Wrap the mppx handler to return our simplified MppChargeResult
    return async (input: Request): Promise<MppChargeResult> => {
      const result = await handler(input);
      if (result.status === 402) {
        return { status: 402, challenge: result.challenge as Response };
      }
      return { status: 200, withReceipt: result.withReceipt as (r: Response) => Response };
    };
  }

  /**
   * Access the underlying mppx instance for advanced usage.
   * Returns an opaque reference -- callers should import mppx types directly
   * if they need typed access.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMppx(): unknown {
    return this.mppx;
  }

  /** The server realm configured for this middleware */
  get realm(): string {
    return this.mppx.realm;
  }

  /**
   * Get protected route list for discovery endpoints.
   */
  getProtectedRoutes(): Array<{
    method: string;
    path: string;
    amount: string;
    description: string;
  }> {
    return Object.entries(this.routes).map(([key, rc]) => ({
      method: key.split(" ")[0],
      path: key.split(" ")[1],
      amount: rc.amount,
      description: rc.description,
    }));
  }

  /**
   * Parse a human-readable price like "$0.10" to atomic units.
   * USDC has 6 decimals. This matches X402Middleware.parsePrice for compatibility.
   */
  static parsePrice(price: string): string {
    const match = price.match(/^\$?(\d+\.?\d*)$/);
    if (!match) return "0";
    return Math.round(parseFloat(match[1]) * 1_000_000).toString();
  }
}
