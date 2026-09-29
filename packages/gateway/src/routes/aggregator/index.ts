/**
 * Universal aggregator routes barrel.
 *
 * Registers all /api/aggregator/* routes on the gateway.
 * Wired into server.ts via `await app.register(aggregatorRoutes)`.
 *
 * Routes (Phase 1):
 *   POST  /api/aggregator/ingest/mcp        — admin-gated MCP source ingest
 *   POST  /api/aggregator/ingest/openapi    — admin-gated OpenAPI ingest
 *   POST  /api/aggregator/ingest/agntcy     — admin-gated AGNTCY ADS ingest
 *   POST  /api/aggregator/publish/agntcy    — admin-gated AGNTCY publish
 *   GET   /api/aggregator/agntcy/status     — AGNTCY bridge state + counters
 *   GET   /api/aggregator/tools/search      — public registry query
 *   POST  /api/aggregator/invoke/:toolId    — public invoke proxy + receipt
 *   GET   /api/aggregator/receipts/:cid     — public receipt lookup
 *
 * The IndexedToolRegistry is process-singleton (Phase 1 in-memory).
 * Phase 2 swaps in a DB-backed registry while preserving these route shapes.
 */

import type { FastifyInstance } from "fastify";
import {
  IndexedToolRegistry,
  NonceCache,
  type X402GateConfig,
} from "@pcc/aggregator";
import type { Address } from "@pcc/spec";
import { ingestRoutes } from "./ingest.js";
import { searchRoutes } from "./search.js";
import { invokeRoutes } from "./invoke.js";
import { receiptsRoutes } from "./receipts.js";
import { randomBytes } from "node:crypto";
import { agntcyAdminRoutes } from "./agntcy.js";
import { configuredAddress } from "../../config/payment-recipient.js";
import { Sentry } from "../../sentry.js";

/** Process-singleton registry used by every aggregator route. */
let _registry: IndexedToolRegistry | undefined;

export function getAggregatorRegistry(): IndexedToolRegistry {
  if (!_registry) _registry = new IndexedToolRegistry();
  return _registry;
}

/** For tests — reset the singleton between cases. */
export function _resetAggregatorRegistryForTests(): void {
  _registry = undefined;
  _x402Gate = undefined;
  _x402Misconfigured = false;
  _x402MisconfiguredAlerted = false;
}

/**
 * N67 (operator item 80; astra pack 58 verdict, weakest link): x402 is ON, but the
 * treasury (PCC_AGGREGATOR_TREASURY) is missing or fails the recipient policy.
 * Priced invocations then fail CLOSED (503 payment_not_configured); they used to
 * be served free, because the gate switched itself off. A free tool needs no
 * treasury and is unaffected. An alert is raised once per process (an error log
 * and Sentry).
 */
let _x402Misconfigured = false;
let _x402MisconfiguredAlerted = false;

/** True when x402 is ON but its treasury is missing or invalid (see above). */
export function x402GateMisconfigured(): boolean {
  getX402GateConfig();
  return _x402Misconfigured;
}

/** Process-singleton x402 gate config — built once from env at first use. */
let _x402Gate: X402GateConfig | undefined;

/**
 * Build (or return cached) X402GateConfig from environment.
 *
 * Env vars consumed:
 *   PCC_X402_ENABLED           — "true" to enable, anything else disables (default off)
 *   PCC_X402_FACILITATOR_URL   — facilitator base URL (default x402.org testnet)
 *   PCC_X402_CHAIN             — "base-mainnet" | "base-sepolia" (default base-sepolia)
 *   PCC_AGGREGATOR_TREASURY    — payee address (required when enabled)
 *   PCC_X402_HMAC_KEY          — 32-byte hex for price-tag HMAC
 *   PCC_AGGREGATOR_HMAC_KEY    — fallback HMAC key (re-uses receipt-signer's key)
 *   CDP_API_KEY_ID/SECRET      — production Coinbase facilitator credentials
 *
 * Returns undefined when disabled.
 */
export function getX402GateConfig(): X402GateConfig | undefined {
  if (_x402Gate) return _x402Gate;
  const enabled = (process.env.PCC_X402_ENABLED ?? "").toLowerCase() === "true";
  if (!enabled) {
    _x402Misconfigured = false;
    return undefined;
  }
  const chain = (process.env.PCC_X402_CHAIN ?? "base-sepolia").toLowerCase();
  const { network, usdcAddress, defaultFacilitatorUrl } =
    resolveChainConfig(chain);
  const facilitatorUrl =
    process.env.PCC_X402_FACILITATOR_URL ?? defaultFacilitatorUrl;
  // The SAME recipient policy as the main payment gate (WP-A round 8, astra failclosed
  // r2 FC-10): EIP-55 checksum for mixed case, and no zero/sentinel, repeated-digit or
  // known-placeholder address, in any casing. A shape check alone let a placeholder
  // payee be advertised in every priceTag.
  const payTo = configuredAddress(process.env.PCC_AGGREGATOR_TREASURY) as Address | null;
  if (!payTo) {
    // Misconfigured: priced calls FAIL CLOSED (invoke.ts answers 503
    // payment_not_configured). Never treated as payments being off (N67).
    _x402Misconfigured = true;
    if (!_x402MisconfiguredAlerted) {
      _x402MisconfiguredAlerted = true;
      const msg =
        "[x402] PCC_X402_ENABLED=true but PCC_AGGREGATOR_TREASURY is missing or invalid: " +
        "priced aggregator calls are REFUSED (503 payment_not_configured) until it is fixed";
      // eslint-disable-next-line no-console
      console.error(msg);
      try {
        Sentry.captureMessage(msg, "error");
      } catch {
        // Alerting never changes the gate's answer.
      }
    }
    return undefined;
  }
  _x402Misconfigured = false;
  const hmacSecretHex = resolveHmacKey();
  _x402Gate = {
    enabled,
    network,
    usdcAddress,
    payTo,
    maxTimeoutSeconds: 300,
    facilitator: {
      url: facilitatorUrl,
      cdpApiKeyId: process.env.CDP_API_KEY_ID,
      cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
    },
    hmacSecretHex,
    nonceCache: new NonceCache({ ttlMs: 10 * 60 * 1000 }),
  };
  return _x402Gate;
}

function resolveChainConfig(chain: string): {
  network: string;
  usdcAddress: Address;
  defaultFacilitatorUrl: string;
} {
  switch (chain) {
    case "base":
    case "base-mainnet":
      return {
        network: "eip155:8453",
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
        defaultFacilitatorUrl:
          "https://api.cdp.coinbase.com/platform/v2/x402",
      };
    case "base-sepolia":
    default:
      return {
        network: "eip155:84532",
        usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
        defaultFacilitatorUrl: "https://x402.org/facilitator",
      };
  }
}

function resolveHmacKey(): string {
  const k1 = process.env.PCC_X402_HMAC_KEY;
  if (k1 && /^[0-9a-fA-F]{64}$/.test(k1)) return k1.toLowerCase();
  const k2 = process.env.PCC_AGGREGATOR_HMAC_KEY;
  if (k2 && /^[0-9a-fA-F]{64}$/.test(k2)) return k2.toLowerCase();
  // Ephemeral fallback — production deploys MUST set one of the above so
  // the gateway can verify priceTags across restarts.
  // eslint-disable-next-line no-console
  console.warn(
    "[x402] no PCC_X402_HMAC_KEY or PCC_AGGREGATOR_HMAC_KEY set; using ephemeral key (priceTags will not verify across restarts)",
  );
  return randomBytes(32).toString("hex");
}

export async function aggregatorRoutes(app: FastifyInstance): Promise<void> {
  await app.register(ingestRoutes);
  await app.register(searchRoutes);
  await app.register(invokeRoutes);
  await app.register(receiptsRoutes);
  await app.register(agntcyAdminRoutes);
}
