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
  if (!enabled) return undefined;
  const chain = (process.env.PCC_X402_CHAIN ?? "base-sepolia").toLowerCase();
  const { network, usdcAddress, defaultFacilitatorUrl } =
    resolveChainConfig(chain);
  const facilitatorUrl =
    process.env.PCC_X402_FACILITATOR_URL ?? defaultFacilitatorUrl;
  const payTo = (process.env.PCC_AGGREGATOR_TREASURY ?? "") as Address;
  if (!payTo || !/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    // Misconfigured: log + treat as disabled so we don't gate calls with no payee.
    // eslint-disable-next-line no-console
    console.warn(
      "[x402] PCC_X402_ENABLED=true but PCC_AGGREGATOR_TREASURY is missing or invalid; gate disabled",
    );
    return undefined;
  }
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
