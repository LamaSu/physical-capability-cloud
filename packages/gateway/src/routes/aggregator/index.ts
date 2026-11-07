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
import { Sentry, isSentryEnabled } from "../../sentry.js";

/** Process-singleton registry used by every aggregator route. */
let _registry: IndexedToolRegistry | undefined;

export function getAggregatorRegistry(): IndexedToolRegistry {
  if (!_registry) _registry = new IndexedToolRegistry();
  return _registry;
}

/** For tests — reset the singleton (and the one-alert-per-process latch) between cases. */
export function _resetAggregatorRegistryForTests(): void {
  _registry = undefined;
  _x402Gate = undefined;
  _misconfiguredAlertRaised = false;
}

/**
 * Process-singleton x402 gate config — built once from env at first use.
 * Only a USABLE config is cached. A misconfigured result is deliberately not
 * cached, so a later fix to the environment is never hidden by it.
 */
let _x402Gate: X402GateConfig | undefined;

// ---------------------------------------------------------------------------
// x402 gate state: tri-state, fail closed (N67)
// ---------------------------------------------------------------------------

/**
 * Returned by {@link getX402GateConfig} when the operator ENABLED the gate
 * (`PCC_X402_ENABLED=true`) but its required configuration is unusable.
 *
 * Callers MUST treat this as CLOSED (refuse paid calls) and never as
 * "disabled". It is intentionally not assignable to `X402GateConfig` (no
 * `enabled` / `payTo` / `network` ...): a caller that forgets to handle it
 * fails to type-check instead of silently skipping the gate.
 */
export interface X402GateMisconfigured {
  readonly misconfigured: true;
  /**
   * Operator-facing reasons, one per problem. Names the env var and the
   * problem class only. Never includes the raw value of a variable that could
   * hold a secret (a pasted private key is a realistic treasury typo).
   */
  readonly reasons: readonly string[];
}

/**
 * Tri-state result of {@link getX402GateConfig}:
 *   - `undefined`              → gate DISABLED by configuration (`PCC_X402_ENABLED` is not "true");
 *                                every aggregator call is free. Intentional.
 *   - `X402GateConfig`         → gate ON and usable.
 *   - `X402GateMisconfigured`  → gate ENABLED but unusable → fail CLOSED.
 */
export type X402GateState = X402GateConfig | X402GateMisconfigured | undefined;

/** Type guard: true only for the fail-closed state. */
export function isX402GateMisconfigured(
  state: X402GateState,
): state is X402GateMisconfigured {
  return (
    state !== undefined &&
    "misconfigured" in state &&
    state.misconfigured === true
  );
}

/** Chain used when `PCC_X402_CHAIN` is UNSET (the documented default). */
const DEFAULT_X402_CHAIN = "base-sepolia";

/** Chain names `PCC_X402_CHAIN` accepts, for operator-facing messages. */
const KNOWN_X402_CHAINS = ["base-mainnet", "base", "base-sepolia"] as const;

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS_RE = /^0x0{40}$/;

/**
 * Build (or return cached) the x402 gate state from the environment.
 *
 * Env vars consumed:
 *   PCC_X402_ENABLED           — "true" (any case) enables the gate; anything else
 *                                disables it (default off). Disabled by configuration
 *                                is the ONLY way this function returns undefined.
 *   PCC_X402_FACILITATOR_URL   — facilitator base URL (default per chain)
 *   PCC_X402_CHAIN             — "base-mainnet" | "base" | "base-sepolia". UNSET defaults
 *                                to base-sepolia. Any other value, including an empty
 *                                string, is a configuration error (fail closed): a typo
 *                                in a mainnet value must never silently price and verify
 *                                on testnet.
 *   PCC_AGGREGATOR_TREASURY    — payee address. Required when enabled: it must be 0x plus
 *                                40 hex characters and must not be the zero address.
 *   PCC_X402_HMAC_KEY          — 32-byte hex for price-tag HMAC
 *   PCC_AGGREGATOR_HMAC_KEY    — fallback HMAC key (re-uses receipt-signer's key)
 *   CDP_API_KEY_ID/SECRET      — production Coinbase facilitator credentials
 *
 * Returns:
 *   - `undefined` when the gate is disabled by configuration (free by design);
 *   - a {@link X402GateMisconfigured} when it is enabled but the treasury or
 *     chain is unusable. This raises one alert per process (see
 *     {@link raiseMisconfiguredAlertOnce}); callers refuse paid calls with a 503;
 *   - the cached {@link X402GateConfig} otherwise.
 */
export function getX402GateConfig(): X402GateState {
  if (_x402Gate) return _x402Gate;
  const enabled = (process.env.PCC_X402_ENABLED ?? "").toLowerCase() === "true";
  // Disabled by configuration: the ONLY path that returns undefined.
  if (!enabled) return undefined;

  // From here on the operator has asked for a payment gate. A problem with its
  // required configuration must fail CLOSED. It must never fall back to
  // "disabled" (every paid call free) or to a different chain.
  const chainEnv = process.env.PCC_X402_CHAIN;
  const chainName = (chainEnv ?? DEFAULT_X402_CHAIN).toLowerCase();
  const chain = resolveChainConfig(chainName);
  const treasury = validateTreasury(process.env.PCC_AGGREGATOR_TREASURY);

  if (!chain || !treasury.ok) {
    const reasons: string[] = [];
    if (!chain) {
      reasons.push(
        `PCC_X402_CHAIN=${describeChainValue(chainEnv ?? "")} is not a known chain (expected one of ${KNOWN_X402_CHAINS.join(", ")}, or unset for ${DEFAULT_X402_CHAIN})`,
      );
    }
    if (!treasury.ok) {
      reasons.push(`PCC_AGGREGATOR_TREASURY ${treasury.problem}`);
    }
    const state: X402GateMisconfigured = Object.freeze({
      misconfigured: true as const,
      reasons: Object.freeze(reasons),
    });
    raiseMisconfiguredAlertOnce(state.reasons);
    return state;
  }

  const facilitatorUrl =
    process.env.PCC_X402_FACILITATOR_URL ?? chain.defaultFacilitatorUrl;
  const hmacSecretHex = resolveHmacKey();
  _x402Gate = {
    enabled,
    network: chain.network,
    usdcAddress: chain.usdcAddress,
    payTo: treasury.address,
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

type ChainConfig = {
  network: string;
  usdcAddress: Address;
  defaultFacilitatorUrl: string;
};

/**
 * Map a (lower-cased) `PCC_X402_CHAIN` value to its chain config.
 * Returns `undefined` for an unknown value; the caller fails closed. There is
 * deliberately no `default:` arm that falls back to testnet. (A `switch` rather
 * than an object lookup so prototype keys like "constructor" cannot resolve.)
 */
function resolveChainConfig(chain: string): ChainConfig | undefined {
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
      return {
        network: "eip155:84532",
        usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
        defaultFacilitatorUrl: "https://x402.org/facilitator",
      };
    default:
      return undefined;
  }
}

/**
 * Validate the payee address. Same shape the gate already required (0x plus 40
 * hex), now also rejecting the zero address, which would burn every payment.
 * The problem text never echoes the value: it may be a pasted private key.
 */
function validateTreasury(
  raw: string | undefined,
): { ok: true; address: Address } | { ok: false; problem: string } {
  if (raw === undefined) return { ok: false, problem: "is not set" };
  if (raw.trim() === "") return { ok: false, problem: "is empty or blank" };
  if (!EVM_ADDRESS_RE.test(raw)) {
    return {
      ok: false,
      problem: "is not a valid address (expected 0x followed by 40 hex characters)",
    };
  }
  if (ZERO_ADDRESS_RE.test(raw)) {
    return {
      ok: false,
      problem: "is the zero address (every payment would be burned)",
    };
  }
  return { ok: true, address: raw as Address };
}

/** Quote a chain value for an operator message only when it is short and benign. */
function describeChainValue(raw: string): string {
  return /^[\w.:-]{0,40}$/.test(raw)
    ? JSON.stringify(raw)
    : "<value omitted: unprintable or longer than 40 characters>";
}

/** True once the one-per-process misconfiguration alert has fired. */
let _misconfiguredAlertRaised = false;

/**
 * Raise ONE alert per process, the first time the gate is found misconfigured.
 *
 * Gateway alerting facility: Sentry (`src/sentry.ts`, already used by
 * `server.ts` for 5xx errors). Sentry silently no-ops when no DSN is
 * configured, so the alert is ALSO always written to stderr under the stable
 * prefix "[x402] MISCONFIGURED:" (greppable / log-alertable). A money gate
 * must never fail closed silently. Alerting is best-effort and must never throw
 * into request handling.
 */
function raiseMisconfiguredAlertOnce(reasons: readonly string[]): void {
  if (_misconfiguredAlertRaised) return;
  _misconfiguredAlertRaised = true;
  const message =
    `[x402] MISCONFIGURED: PCC_X402_ENABLED=true but the payment gate configuration is unusable (${reasons.join("; ")}). ` +
    "Failing CLOSED: paid aggregator calls are refused with 503 payment_gate_misconfigured until this is fixed.";
  try {
    // eslint-disable-next-line no-console
    console.error(message);
    if (isSentryEnabled()) {
      Sentry.captureMessage(message, {
        level: "fatal",
        tags: { service: "pcc-gateway", component: "x402-gate" },
        extra: { reasons },
      });
    }
  } catch {
    // Alerting is best-effort.
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
  // Evaluate the x402 gate config at registration so a misconfigured deploy
  // alerts at boot instead of on the first paid call. The alert itself is
  // raised (once per process) inside getX402GateConfig(); this adds a
  // structured log line. Nothing is refused here: the 503 is per paid request.
  const gate = getX402GateConfig();
  if (isX402GateMisconfigured(gate)) {
    app.log.error(
      { code: "payment_gate_misconfigured", reasons: gate.reasons },
      "[x402] MISCONFIGURED: aggregator payment gate is enabled but unusable; paid calls will be refused with 503",
    );
  }

  await app.register(ingestRoutes);
  await app.register(searchRoutes);
  await app.register(invokeRoutes);
  await app.register(receiptsRoutes);
  await app.register(agntcyAdminRoutes);
}
