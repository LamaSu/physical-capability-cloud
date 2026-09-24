/**
 * Fiat ramp routes — on-ramp (fiat→crypto) and off-ramp (crypto→fiat).
 *
 * Wires Stripe (US/EU on-ramp), Yellowcard (emerging market on/off-ramp),
 * and Wise (enterprise fiat payouts) into PCC's settlement flow.
 *
 * A provider is live only with its COMPLETE configuration (see providerConfig); anything
 * less is mock, and a mock provider answers 503 not_configured unless PCC_DEMO_ROUTES is on
 * (never in production). The gate and the client read the same configuration snapshot:
 *   STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY
 *   YELLOWCARD_API_KEY + YELLOWCARD_SECRET_KEY   (YELLOWCARD_ENVIRONMENT, default sandbox)
 *   WISE_API_TOKEN + WISE_PROFILE_ID             (WISE_ENVIRONMENT, default sandbox)
 *   COINBASE_APP_ID
 *   CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET (CDP_NETWORK base = production)
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { isAddress, type Address } from "viem";
import { hasValidAdminKey } from "../auth/admin-key.js";
import { isDemoRoutesOn, markDemo } from "../config/demo-routes.js";
import {
  StripeOnrampClient,
  StripeCreditService,
  YellowcardClient,
  YellowcardOfframp,
  YellowcardOnramp,
  WiseClient,
  WisePayoutService,
  CdpWalletClient,
  CdpOnrampClient,
  CdpSpendPermissionService,
  isCdpMockAddress,
} from "@pcc/payments";

// ---------------------------------------------------------------------------
// Provider configuration: read ONCE, shared by the gate and the client
// ---------------------------------------------------------------------------
//
// coord-watch #2934: the gate used to read the CURRENT env while each client cached its
// mock setting at first use, so the two could disagree. A key set after a mock client was
// built made the gate say "live" while the mock ran, with no disclosure; the reverse labelled
// a real provider call as demo. Now each provider's configuration is snapshotted once, and
// both the gate (providerMode) and the client constructor read that snapshot. A partial
// configuration is mock, never a live client with a made-up secret.

type RampProvider = "coinbase" | "stripe" | "yellowcard" | "wise" | "cdp";
type RampEnvironment = "production" | "sandbox";

interface RampProviderConfig {
  /** True only with every required setting present. */
  readonly live: boolean;
  /** Where a live provider operates; null when not live. A sandbox moves no real money. */
  readonly environment: RampEnvironment | null;
  /** The required settings, captured once (only read when live). */
  readonly values: Readonly<Record<string, string>>;
}

const REQUIRED: Readonly<Record<RampProvider, readonly string[]>> = {
  coinbase: ["COINBASE_APP_ID"],
  stripe: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"],
  yellowcard: ["YELLOWCARD_API_KEY", "YELLOWCARD_SECRET_KEY"],
  wise: ["WISE_API_TOKEN", "WISE_PROFILE_ID"],
  cdp: ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"],
};

function readProviderConfig(p: RampProvider): RampProviderConfig {
  const values: Record<string, string> = {};
  for (const k of REQUIRED[p]) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim() !== "") values[k] = v.trim();
  }
  const live = REQUIRED[p].every((k) => k in values);
  if (!live) return Object.freeze({ live: false, environment: null, values: Object.freeze({}) });
  let environment: RampEnvironment;
  switch (p) {
    case "stripe":
      environment = values.STRIPE_SECRET_KEY!.startsWith("sk_live_") ? "production" : "sandbox";
      break;
    case "yellowcard":
      environment = process.env.YELLOWCARD_ENVIRONMENT === "production" ? "production" : "sandbox";
      break;
    case "wise":
      environment = process.env.WISE_ENVIRONMENT === "production" ? "production" : "sandbox";
      break;
    case "cdp":
      environment = process.env.CDP_NETWORK === "base" ? "production" : "sandbox";
      break;
    case "coinbase":
      environment = "production";
      break;
  }
  return Object.freeze({ live: true, environment, values: Object.freeze(values) });
}

const providerConfigs = new Map<RampProvider, RampProviderConfig>();

/** The provider's configuration snapshot: read on first use, then fixed for the process. */
function providerConfig(p: RampProvider): RampProviderConfig {
  let c = providerConfigs.get(p);
  if (!c) {
    c = readProviderConfig(p);
    providerConfigs.set(p, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Service singletons (lazy-init), built from the same snapshot
// ---------------------------------------------------------------------------

let stripeOnramp: StripeOnrampClient | undefined;
let stripeCredits: StripeCreditService | undefined;
let ycClient: YellowcardClient | undefined;
let ycOfframp: YellowcardOfframp | undefined;
let ycOnramp: YellowcardOnramp | undefined;
let wiseClient: WiseClient | undefined;
let wisePayout: WisePayoutService | undefined;

function getStripeOnramp(): StripeOnrampClient {
  if (!stripeOnramp) {
    const cfg = providerConfig("stripe");
    stripeOnramp = new StripeOnrampClient({
      secretKey: cfg.live ? cfg.values.STRIPE_SECRET_KEY! : "sk_test_mock",
      publishableKey: cfg.live ? cfg.values.STRIPE_PUBLISHABLE_KEY! : "pk_test_mock",
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      mock: !cfg.live,
    });
  }
  return stripeOnramp;
}

function getStripeCredits(): StripeCreditService {
  if (!stripeCredits) {
    const cfg = providerConfig("stripe");
    stripeCredits = new StripeCreditService({
      secretKey: cfg.live ? cfg.values.STRIPE_SECRET_KEY! : "sk_test_mock",
      mock: !cfg.live,
    });
  }
  return stripeCredits;
}

// ── Legacy Stripe prepaid-credits + unsigned provider webhooks: RETIRED (audit PR2) ──
// Retired because (1) NOTHING consumes the credits — deductCredits is never called
// outside tests; the real billing rail is x402 / on-chain USDC — and (2) the provider
// webhooks verify NO provider signature, so any AUTHENTICATED PCC caller could POST a
// forged event and mint credits / advance a funding session. Being behind an API key is
// NOT provider authentication. Funding is moving to direct USDC into a user-controlled
// wallet (the onramp flow), so this path is being removed rather than hardened.
// Default: 410 Gone. PCC_LEGACY_FIAT_WEBHOOKS=true re-enables the legacy, UNSIGNED,
// in-memory, dev/testnet-ONLY behavior — never enable in production (it is still unsigned).
function legacyFiatCreditsEnabled(): boolean {
  // Never in production. The fiatRampRoutes startup guard hard-fails boot if the flag is
  // set under NODE_ENV=production; this is the matching per-request floor (defense in depth).
  return (
    process.env.PCC_LEGACY_FIAT_WEBHOOKS === "true" &&
    process.env.NODE_ENV !== "production"
  );
}
const RETIRED_FIAT_CREDITS_MSG =
  "Retired: the Stripe prepaid-credits path and the unsigned provider webhooks are " +
  "removed. Fund jobs directly in USDC via the onramp flow. (Legacy dev-only behavior " +
  "is available behind PCC_LEGACY_FIAT_WEBHOOKS=true; never enable in production.)";

function getYellowcard(): { client: YellowcardClient; offramp: YellowcardOfframp; onramp: YellowcardOnramp } {
  if (!ycClient) {
    const cfg = providerConfig("yellowcard");
    ycClient = new YellowcardClient({
      apiKey: cfg.live ? cfg.values.YELLOWCARD_API_KEY! : "yc_mock_key",
      secretKey: cfg.live ? cfg.values.YELLOWCARD_SECRET_KEY! : "yc_mock_secret",
      environment: cfg.environment ?? "sandbox",
      mock: !cfg.live,
    });
    ycOfframp = new YellowcardOfframp(ycClient);
    ycOnramp = new YellowcardOnramp(ycClient);
  }
  return { client: ycClient, offramp: ycOfframp!, onramp: ycOnramp! };
}

function getWise(): { client: WiseClient; payout: WisePayoutService } {
  if (!wiseClient) {
    const cfg = providerConfig("wise");
    wiseClient = new WiseClient({
      apiToken: cfg.live ? cfg.values.WISE_API_TOKEN! : "wise_mock_token",
      profileId: cfg.live ? cfg.values.WISE_PROFILE_ID : undefined,
      environment: cfg.environment ?? "sandbox",
      mock: !cfg.live,
    });
    wisePayout = new WisePayoutService(wiseClient);
  }
  return { client: wiseClient, payout: wisePayout! };
}

/** The Wise profile a live payout uses; a demo payout runs on the mock client (profile 0). */
function wiseProfileId(): number {
  const cfg = providerConfig("wise");
  return cfg.live ? parseInt(cfg.values.WISE_PROFILE_ID!, 10) : 0;
}

let cdpWallet: CdpWalletClient | undefined;
let cdpOnramp: CdpOnrampClient | undefined;
let cdpSpendPerm: CdpSpendPermissionService | undefined;

function getCdp(): {
  wallet: CdpWalletClient;
  onramp: CdpOnrampClient;
  spendPerm: CdpSpendPermissionService;
} {
  if (!cdpWallet) {
    const pc = providerConfig("cdp");
    const cfg = {
      apiKeyId: pc.live ? pc.values.CDP_API_KEY_ID : undefined,
      apiKeySecret: pc.live ? pc.values.CDP_API_KEY_SECRET : undefined,
      walletSecret: pc.live ? pc.values.CDP_WALLET_SECRET : undefined,
      network: (process.env.CDP_NETWORK as "base-sepolia" | "base") ?? "base-sepolia",
      onrampAppId: process.env.CDP_ONRAMP_APP_ID,
      // Every CDP service runs in the SAME mode as the gate's snapshot.
      mock: !pc.live,
    };
    cdpWallet = new CdpWalletClient(cfg);
    cdpOnramp = new CdpOnrampClient(cfg);
    cdpSpendPerm = new CdpSpendPermissionService(cfg);
  }
  return { wallet: cdpWallet, onramp: cdpOnramp!, spendPerm: cdpSpendPerm! };
}

// ── Mock-wallet truthfulness (WP-A fold F6, shell #2499) ────────────────────
// With no CDP credentials the wallet client is in MOCK mode and createWallet()
// returns an address NO key controls. Money sent there is unrecoverable. So:
//   - a mock wallet is never called "usable" (explicit mock:true + an honest note);
//   - a real-money Coinbase onramp URL is never built while the CDP wallet
//     client is mock (503), nor for an address minted in mock mode (409
//     wallet_not_custodial) — isCdpMockAddress recognizes those by construction,
//     so an address minted during a mock period stays refused after real
//     credentials arrive.

const MOCK_WALLET_NOTE =
  "MOCK wallet: this gateway has no CDP credentials, so this address is a " +
  "placeholder that NO key controls. Do not send funds to it — anything sent " +
  "is unrecoverable. Configure CDP_API_KEY_ID / CDP_API_KEY_SECRET / " +
  "CDP_WALLET_SECRET for a real wallet.";

type OnrampRefusal = { status: 400 | 409 | 503; body: { error: string; message: string } };

/** Why a real-money onramp must NOT be built for `walletAddress`, or null. */
function onrampRefusal(walletAddress: string): OnrampRefusal | null {
  if (!isAddress(walletAddress)) {
    return {
      status: 400,
      body: { error: "invalid_wallet_address", message: "walletAddress must be a valid EVM address" },
    };
  }
  if (getCdp().wallet.isMock) {
    return {
      status: 503,
      body: {
        error: "cdp_wallet_mock",
        message:
          "Onramp is disabled while the CDP wallet client is in MOCK mode (no CDP " +
          "credentials): wallets this gateway issues are then placeholders no key " +
          "controls, so it will not build a real-money checkout.",
      },
    };
  }
  if (isCdpMockAddress(walletAddress)) {
    return {
      status: 409,
      body: {
        error: "wallet_not_custodial",
        message:
          "This address was issued by this gateway in MOCK mode; no key controls " +
          "it, so funds sent there would be unrecoverable. Create a real wallet " +
          "(POST /api/fiat-ramp/cdp/wallet) and fund that instead.",
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// ── Provider gate (board N48 / N34) ─────────────────────────────────
//
// Every provider route below used to answer like the real provider even when that
// provider was not configured: Yellowcard deposit/withdraw instructions and payout
// addresses, Wise COMPLETED payouts under profile 12345, Stripe cos_mock_ sessions, a
// Coinbase URL with a made-up app id, a 0 USDC balance for any address. Only
// GET /status admitted it. Now an unconfigured provider fails closed (503
// not_configured) unless PCC_DEMO_ROUTES is on, and then every response says mock/demo.

/**
 * "live" when the provider's configuration snapshot is complete; "demo" when it is not but
 * PCC_DEMO_ROUTES is on (never in production); otherwise sends 503 not_configured and returns
 * null (the caller must return). The client the route then uses is built from the SAME
 * snapshot, so "live" always runs the real client and "demo" always runs the mock.
 */
function providerMode(reply: FastifyReply, p: RampProvider): "live" | "demo" | null {
  if (providerConfig(p).live) return "live";
  if (isDemoRoutesOn()) return "demo";
  void reply.status(503).send({
    error: "not_configured",
    provider: p,
    message: `The ${p} provider is not configured on this gateway, so nothing was created or quoted.`,
  });
  return null;
}

/**
 * Marks a provider response with what produced it: in demo, mock/demo; live, the
 * provider's environment, so a sandbox answer is never mistaken for real money moving.
 */
function markRamp<T extends object>(mode: "live" | "demo", p: RampProvider, body: T) {
  if (mode === "demo") return markDemo("demo", body);
  const environment = providerConfig(p).environment;
  return environment === "sandbox" ? { ...body, environment, sandbox: true as const } : { ...body, environment };
}

/** The caller as the API gate resolved it: the key's operator id or the SIWE address. */
function principalOf(req: { operatorId?: unknown; userId?: unknown }): string | undefined {
  const p = (req as any).operatorId ?? (req as any).userId;
  return typeof p === "string" && p.trim() !== "" ? p : undefined;
}

/** A provider's state for GET /status: from the snapshot, never from current env. */
function providerStatus(p: RampProvider) {
  const cfg = providerConfig(p);
  return { available: cfg.live || isDemoRoutesOn(), mock: !cfg.live, environment: cfg.environment };
}

export async function fiatRampRoutes(app: FastifyInstance) {
  // Production must NEVER re-enable the retired unsigned webhooks / prepaid-credits path.
  // The dev-only escape hatch is ENFORCED here (not merely documented): fail startup if
  // PCC_LEGACY_FIAT_WEBHOOKS is set under NODE_ENV=production.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.PCC_LEGACY_FIAT_WEBHOOKS === "true"
  ) {
    throw new Error(
      "PCC_LEGACY_FIAT_WEBHOOKS=true is forbidden in production: the legacy Stripe " +
        "prepaid-credits path and the unsigned provider webhooks are retired and must " +
        "never be re-enabled in prod (they verify no provider signature). Unset it.",
    );
  }

  if (process.env.NODE_ENV === "production" && process.env.PCC_DEMO_ROUTES === "true") {
    app.log.warn("PCC_DEMO_ROUTES=true is ignored in production: providers answer 503 not_configured, never simulated.");
  }

  // ── Status ────────────────────────────────────────────────────────

  app.get("/api/fiat-ramp/status", async () => {
    return {
      providers: {
        // Each entry reads the same configuration snapshot the provider's routes use.
        coinbase: {
          ...providerStatus("coinbase"),
          capabilities: ["onramp"],
          note: "Primary on-ramp. No merchant account needed. User pays via Coinbase or credit card → USDC on Base.",
        },
        stripe: { ...providerStatus("stripe"), capabilities: ["onramp", "credits"] },
        yellowcard: { ...providerStatus("yellowcard"), capabilities: ["onramp", "offramp"] },
        wise: { ...providerStatus("wise"), capabilities: ["payout"] },
        cdp: { ...providerStatus("cdp"), capabilities: ["wallet", "provision", "spend-permission"] },
      },
      recommended: "coinbase",
      /** When false, an unconfigured provider answers 503 not_configured instead of simulating. */
      demoRoutes: isDemoRoutesOn(),
    };
  });

  // ── CDP funded-key on-ramp (lane #017) ──────────────────────────
  // Net-new vs /coinbase/onramp below: /provision also CREATES the smart wallet
  // (no bring-your-own-address) and issues a SCOPED, REVOCABLE spend-permission —
  // never a raw private key. Card → funded wallet → scoped agent key, one human step.

  // Card-FREE start: a gasless smart wallet so a user can use PCC immediately —
  // gasless USDC on Base via the paymaster (receive payments, hold an identity,
  // operate). No card, no gas. They fund it later (only when they want to SPEND).
  // Pair with POST /api/auth/provision for an API key.
  app.post("/api/fiat-ramp/cdp/wallet", async (_req, reply) => {
    const mode = providerMode(reply, "cdp");
    if (!mode) return reply;
    const { wallet } = getCdp();
    const w = await wallet.createWallet();
    if (wallet.isMock) {
      // Never "usable": no key controls a mock address (F6). Reached only in demo mode.
      return markRamp(mode, "cdp", {
        walletAddress: w.address,
        network: w.network,
        smartAccount: w.smartAccount,
        mock: true,
        usableNow: false,
        note: MOCK_WALLET_NOTE,
      });
    }
    return markRamp(mode, "cdp", {
      walletAddress: w.address,
      network: w.network,
      smartAccount: w.smartAccount,
      mock: false,
      usableNow: true,
      note:
        "Usable on PCC now — gasless on Base, no card, no gas. Pair with POST /api/auth/provision " +
        "for an API key. Fund with a card later (POST /api/fiat-ramp/coinbase/onramp) only to pay for jobs.",
    });
  });

  app.post("/api/fiat-ramp/cdp/provision", async (req, reply) => {
    const mode = providerMode(reply, "cdp");
    if (!mode) return reply;
    const body = (req.body ?? {}) as { presetAmountUSD?: number };
    const { wallet, onramp } = getCdp();
    const w = await wallet.createWallet();
    const session = await onramp.createSession({
      destinationAddress: w.address,
      presetAmountUSD: body.presetAmountUSD,
    });
    return markRamp(mode, "cdp", {
      walletAddress: w.address,
      network: w.network,
      smartAccount: w.smartAccount,
      onrampUrl: session.onrampUrl,
      sessionId: session.sessionId,
      mock: wallet.isMock,
      instructions: wallet.isMock
        ? MOCK_WALLET_NOTE + " The onrampUrl is a non-functional mock; do not pay anything."
        : "Open onrampUrl, pay once by card → USDC lands in the smart wallet on Base (gasless). " +
          "Then POST /api/fiat-ramp/cdp/spend-permission to give your agent a scoped, revocable spending key.",
    });
  });

  app.get("/api/fiat-ramp/cdp/wallet/:address/balance", async (req, reply) => {
    // A simulated balance (0 USDC for any address) reads as "this wallet is empty".
    const mode = providerMode(reply, "cdp");
    if (!mode) return reply;
    const { address } = req.params as { address: string };
    return markRamp(mode, "cdp", await getCdp().wallet.getBalance(address as `0x${string}`));
  });

  app.post("/api/fiat-ramp/cdp/spend-permission", async (req, reply) => {
    const mode = providerMode(reply, "cdp");
    if (!mode) return reply;
    const body = req.body as
      | {
          walletAddress?: string;
          spender?: string;
          allowanceUSDC?: number;
          periodSec?: number;
          expiresAt?: string;
        }
      | undefined;
    if (!body?.walletAddress || !body?.spender || body.allowanceUSDC == null) {
      return reply
        .status(400)
        .send({ error: "walletAddress, spender, allowanceUSDC required" });
    }
    return markRamp(mode, "cdp",
      await getCdp().spendPerm.issue({
        account: body.walletAddress as `0x${string}`,
        spender: body.spender as `0x${string}`,
        allowanceUSDC: body.allowanceUSDC,
        periodSec: body.periodSec ?? 86_400,
        expiresAt: body.expiresAt,
      }),
    );
  });

  app.delete("/api/fiat-ramp/cdp/spend-permission/:id", async (req, reply) => {
    const mode = providerMode(reply, "cdp");
    if (!mode) return reply;
    const { id } = req.params as { id: string };
    return markRamp(mode, "cdp", await getCdp().spendPerm.revoke(id));
  });

  // ── Coinbase Onramp (PRIMARY — no merchant account needed) ──────

  /**
   * POST /api/fiat-ramp/coinbase/onramp
   *
   * Generates a Coinbase Onramp URL. The user opens this URL,
   * pays with credit card or Coinbase account, and receives USDC
   * directly in their wallet on Base. Zero merchant setup.
   *
   * Coinbase CDP App ID: set COINBASE_APP_ID env var, or uses default.
   * Get one free at: https://portal.cdp.coinbase.com
   */
  app.post("/api/fiat-ramp/coinbase/onramp", async (req, reply) => {
    const body = req.body as {
      walletAddress: string;
      amount?: number;
      currency?: string;
      asset?: string;
      network?: string;
    } | undefined;

    if (!body?.walletAddress) {
      return reply.status(400).send({ error: "walletAddress is required" });
    }
    const mode = providerMode(reply, "coinbase");
    if (!mode) return reply;
    // Never build a real-money checkout for an address no key controls (F6), demo or not.
    const refusal = onrampRefusal(String(body.walletAddress));
    if (refusal) return reply.status(refusal.status).send(refusal.body);

    const asset = body.asset ?? "USDC";
    const network = body.network ?? "base";
    const fiatCurrency = body.currency ?? "USD";
    if (mode === "demo") {
      // Demo: no Coinbase app is configured, so no checkout URL is built at all (it used to
      // carry a made-up app id). The response says what a live gateway would return.
      return markRamp(mode, "coinbase", {
        provider: "coinbase",
        onrampUrl: null,
        walletAddress: body.walletAddress,
        asset,
        network,
        fiatCurrency,
        amount: body.amount ?? null,
        note: "Demo mode: no Coinbase app is configured, so no checkout URL was built and nothing can be funded.",
      });
    }
    const appId = providerConfig("coinbase").values.COINBASE_APP_ID!;

    // Build Coinbase Onramp URL
    // Docs: https://docs.cdp.coinbase.com/onramp/docs/api-initializing
    const params = new URLSearchParams();
    params.set("appId", appId);
    params.set("defaultAsset", asset);
    params.set("defaultNetwork", network);
    params.set("fiatCurrency", fiatCurrency);
    if (body.amount) params.set("presetFiatAmount", String(body.amount));

    // Encode addresses as JSON: {"0xAddr": ["base"]}
    const addresses = JSON.stringify({ [body.walletAddress]: [network] });
    params.set("addresses", addresses);

    // Lock to USDC on Base (prevent user from switching to BTC etc.)
    params.set("assets", JSON.stringify([asset]));

    const onrampUrl = `https://pay.coinbase.com/buy/select-asset?${params.toString()}`;

    return markRamp(mode, "coinbase", {
      provider: "coinbase",
      onrampUrl,
      walletAddress: body.walletAddress,
      asset,
      network,
      fiatCurrency,
      amount: body.amount ?? null,
      instructions: "Open the URL to fund your wallet. Pay with credit card, debit card, or Coinbase account. USDC arrives on Base in ~1 minute.",
      mock: false,
      note: "Live Coinbase Onramp",
    });
  });

  /** GET /api/fiat-ramp/coinbase/onramp-url — Quick URL generator (GET for easy linking) */
  app.get("/api/fiat-ramp/coinbase/onramp-url", async (req, reply) => {
    const { wallet, amount, currency } = req.query as {
      wallet?: string;
      amount?: string;
      currency?: string;
    };

    if (!wallet) {
      return {
        error: "wallet query param required",
        example: "/api/fiat-ramp/coinbase/onramp-url?wallet=0x...&amount=50&currency=USD",
      };
    }
    const mode = providerMode(reply, "coinbase");
    if (!mode) return reply;
    // Same rule as POST /coinbase/onramp — this builds the same real-money URL (F6).
    const refusal = onrampRefusal(String(wallet));
    if (refusal) return reply.status(refusal.status).send(refusal.body);

    if (mode === "demo") {
      return markRamp(mode, "coinbase", {
        url: null,
        wallet,
        note: "Demo mode: no Coinbase app is configured, so no checkout URL was built.",
      });
    }
    const appId = providerConfig("coinbase").values.COINBASE_APP_ID!;
    const params = new URLSearchParams();
    params.set("appId", appId);
    params.set("defaultAsset", "USDC");
    params.set("defaultNetwork", "base");
    params.set("addresses", JSON.stringify({ [wallet]: ["base"] }));
    params.set("assets", JSON.stringify(["USDC"]));
    if (amount) params.set("presetFiatAmount", amount);
    if (currency) params.set("fiatCurrency", currency);

    return markRamp(mode, "coinbase", {
      url: `https://pay.coinbase.com/buy/select-asset?${params.toString()}`,
      wallet,
    });
  });

  // ── Stripe: Crypto On-Ramp ────────────────────────────────────────

  app.post<{
    Body: {
      walletAddress: string;
      sourceAmount?: string;
      destinationAmount?: string;
      destinationCurrency?: string;
      destinationNetwork?: string;
      customerEmail?: string;
      escrowId?: string;
    };
  }>("/api/fiat-ramp/stripe/onramp", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body?.walletAddress || !isAddress(body.walletAddress as string)) {
      return reply.status(400).send({ error: "Valid walletAddress is required" });
    }
    const mode = providerMode(reply, "stripe");
    if (!mode) return reply;

    try {
      const client = getStripeOnramp();
      const session = await client.createSession({
        walletAddress: body.walletAddress as Address,
        sourceAmount: body.sourceAmount as string | undefined,
        destinationAmount: body.destinationAmount as string | undefined,
        destinationCurrency: body.destinationCurrency as string | undefined,
        destinationNetwork: body.destinationNetwork as string | undefined,
        customerEmail: body.customerEmail as string | undefined,
        escrowId: body.escrowId as string | undefined,
        createdBy: principalOf(req),
      });

      return markRamp(mode, "stripe", {
        session,
        publishableKey: client.publishableKey,
        provider: "stripe",
      });
    } catch (err) {
      return reply.status(502).send({
        error: "stripe_onramp_failed",
        message: err instanceof Error ? err.message : "Failed to create onramp session",
      });
    }
  });

  // ── Stripe: Prepaid Credits ───────────────────────────────────────

  app.post<{
    Body: { amountUsd: number };
  }>("/api/fiat-ramp/stripe/credits/deposit", async (req, reply) => {
    if (!legacyFiatCreditsEnabled()) {
      return reply.status(410).send({ error: "gone", message: RETIRED_FIAT_CREDITS_MSG });
    }
    // IDOR fix: derive userId from session, not body (red team #10).
    // Previously anyone could fund any other user's credit balance on their behalf
    // (or more dangerously, trigger a deposit session with stolen userId).
    const userId = (req as any).operatorId ?? (req as any).userId;
    if (!userId) {
      return reply.status(401).send({ error: "authentication_required" });
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (typeof body?.amountUsd !== "number" || body.amountUsd <= 0) {
      return reply.status(400).send({ error: "amountUsd (positive number) is required" });
    }

    try {
      const credits = getStripeCredits();
      const result = await credits.createDepositSession(userId, body.amountUsd);
      return { ...result, provider: "stripe" };
    } catch (err) {
      return reply.status(502).send({
        error: "stripe_credits_failed",
        message: "Failed to create credit deposit",
      });
    }
  });

  app.get<{
    Params: { userId: string };
  }>("/api/fiat-ramp/stripe/credits/:userId", async (req, reply) => {
    if (!legacyFiatCreditsEnabled()) {
      return reply.status(410).send({ error: "gone", message: RETIRED_FIAT_CREDITS_MSG });
    }
    // Even on the dev-only legacy path, a caller reads only its own balance (or an admin any).
    const principal = ((req as any).operatorId ?? (req as any).userId ?? null) as string | null;
    const own = typeof principal === "string" && principal.toLowerCase() === req.params.userId.toLowerCase();
    if (!own && !hasValidAdminKey(req.headers["x-admin-key"])) {
      return reply.status(404).send({ error: "No credit balance found" });
    }
    const credits = getStripeCredits();
    const balance = credits.getBalance(req.params.userId);
    if (!balance) {
      return reply.status(404).send({ error: "No credit balance found" });
    }
    return balance;
  });

  // ── Yellowcard: Channels & Rates ──────────────────────────────────

  app.get<{
    Querystring: { country?: string };
  }>("/api/fiat-ramp/yellowcard/channels", async (_req, reply) => {
    const mode = providerMode(reply, "yellowcard");
    if (!mode) return reply;
    const { client } = getYellowcard();
    const channels = await client.getChannels(_req.query.country);
    return markRamp(mode, "yellowcard", { channels });
  });

  app.get("/api/fiat-ramp/yellowcard/rates", async (_req, reply) => {
    // A literal rate table is not a quote.
    const mode = providerMode(reply, "yellowcard");
    if (!mode) return reply;
    const { client } = getYellowcard();
    const rates = await client.getRates();
    return markRamp(mode, "yellowcard", { rates });
  });

  // ── Yellowcard: Off-Ramp (operator withdrawal) ────────────────────

  app.post<{
    Body: {
      walletAddress: string;
      amountUsd: string;
      fiatCurrency: string;
      country: string;
      channelId: string;
      destination: {
        type: string;
        accountName: string;
        accountNumber: string;
        networkName?: string;
        country: string;
      };
      sender: {
        name: string;
        country: string;
        address: string;
        dob: string;
        email: string;
        idNumber: string;
        idType: string;
      };
      cryptoCurrency?: string;
      cryptoNetwork?: string;
      escrowId?: string;
    };
  }>("/api/fiat-ramp/yellowcard/withdraw", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body?.walletAddress || !body?.amountUsd || !body?.fiatCurrency || !body?.channelId || !body?.destination || !body?.sender) {
      return reply.status(400).send({ error: "Missing required fields" });
    }
    // Checked before the sender's identity details reach any client.
    const mode = providerMode(reply, "yellowcard");
    if (!mode) return reply;

    try {
      const { offramp } = getYellowcard();
      const result = await offramp.submitWithdrawal({
        walletAddress: body.walletAddress as Address,
        amountUsd: body.amountUsd as string,
        fiatCurrency: body.fiatCurrency as string,
        country: body.country as string,
        channelId: body.channelId as string,
        destination: body.destination as {
          type: "bank_transfer" | "mobile_money" | "iban" | "spei" | "pix";
          accountName: string;
          accountNumber: string;
          networkName?: string;
          country: string;
        },
        sender: body.sender as {
          name: string;
          country: string;
          address: string;
          dob: string;
          email: string;
          idNumber: string;
          idType: string;
        },
        cryptoCurrency: body.cryptoCurrency as string | undefined,
        cryptoNetwork: body.cryptoNetwork as string | undefined,
        escrowId: body.escrowId as string | undefined,
        createdBy: principalOf(req),
      });

      return markRamp(mode, "yellowcard", { ...result, provider: "yellowcard" });
    } catch (err) {
      return reply.status(502).send({
        error: "yellowcard_withdraw_failed",
        message: err instanceof Error ? err.message : "Failed to submit withdrawal",
      });
    }
  });

  // ── Yellowcard: On-Ramp (emerging market deposit) ─────────────────

  app.post<{
    Body: {
      fiatAmount: string;
      fiatCurrency: string;
      country: string;
      channelId: string;
      recipient: {
        name: string;
        country: string;
        phone: string;
        address: string;
        dob: string;
        idNumber: string;
        idType: string;
      };
      walletAddress: string;
      cryptoCurrency?: string;
      cryptoNetwork?: string;
      escrowId?: string;
    };
  }>("/api/fiat-ramp/yellowcard/deposit", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body?.fiatAmount || !body?.fiatCurrency || !body?.channelId || !body?.recipient || !body?.walletAddress) {
      return reply.status(400).send({ error: "Missing required fields" });
    }
    const mode = providerMode(reply, "yellowcard");
    if (!mode) return reply;

    try {
      const { onramp } = getYellowcard();
      const result = await onramp.submitCollection({
        fiatAmount: body.fiatAmount as string,
        fiatCurrency: body.fiatCurrency as string,
        country: body.country as string,
        channelId: body.channelId as string,
        recipient: body.recipient as {
          name: string;
          country: string;
          phone: string;
          address: string;
          dob: string;
          idNumber: string;
          idType: string;
        },
        walletAddress: body.walletAddress as Address,
        cryptoCurrency: body.cryptoCurrency as string | undefined,
        cryptoNetwork: body.cryptoNetwork as string | undefined,
        escrowId: body.escrowId as string | undefined,
        createdBy: principalOf(req),
      });

      return markRamp(mode, "yellowcard", { ...result, provider: "yellowcard" });
    } catch (err) {
      return reply.status(502).send({
        error: "yellowcard_deposit_failed",
        message: err instanceof Error ? err.message : "Failed to submit collection",
      });
    }
  });

  // ── Wise: Enterprise Payout ───────────────────────────────────────

  app.post<{
    Body: {
      sourceAmount: number;
      sourceCurrency?: string;
      recipient: {
        name: string;
        currency: string;
        type: string;
        details: Record<string, unknown>;
      };
      reference: string;
      escrowId?: string;
    };
  }>("/api/fiat-ramp/wise/payout", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body?.sourceAmount || !body?.recipient || !body?.reference) {
      return reply.status(400).send({ error: "sourceAmount, recipient, and reference are required" });
    }
    const mode = providerMode(reply, "wise");
    if (!mode) return reply;

    try {
      const { payout } = getWise();
      const profileId = wiseProfileId();
      const result = await payout.sendPayout({
        profileId,
        sourceAmount: body.sourceAmount as number,
        sourceCurrency: body.sourceCurrency as string | undefined,
        recipient: body.recipient as {
          name: string;
          currency: string;
          type: string;
          details: Record<string, unknown>;
        },
        reference: body.reference as string,
        escrowId: body.escrowId as string | undefined,
        createdBy: principalOf(req),
      });

      return markRamp(mode, "wise", { ...result, provider: "wise" });
    } catch (err) {
      return reply.status(502).send({
        error: "wise_payout_failed",
        message: err instanceof Error ? err.message : "Failed to create payout",
      });
    }
  });

  // ── Wise: Batch Payout ────────────────────────────────────────────

  app.post<{
    Body: {
      payouts: Array<{
        sourceAmount: number;
        sourceCurrency?: string;
        recipient: {
          name: string;
          currency: string;
          type: string;
          details: Record<string, unknown>;
        };
        reference: string;
        escrowId?: string;
      }>;
    };
  }>("/api/fiat-ramp/wise/batch-payout", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const payouts = (body?.payouts as unknown[]) ?? [];
    if (!Array.isArray(payouts) || payouts.length === 0) {
      return reply.status(400).send({ error: "payouts array is required" });
    }
    const mode = providerMode(reply, "wise");
    if (!mode) return reply;

    try {
      const { payout } = getWise();
      const profileId = wiseProfileId();
      const requests = payouts.map((p: unknown) => {
        const item = p as Record<string, unknown>;
        return {
          profileId,
          sourceAmount: item.sourceAmount as number,
          sourceCurrency: item.sourceCurrency as string | undefined,
          recipient: item.recipient as {
            name: string;
            currency: string;
            type: string;
            details: Record<string, unknown>;
          },
          reference: item.reference as string,
          escrowId: item.escrowId as string | undefined,
          createdBy: principalOf(req),
        };
      });

      const result = await payout.sendBatch(requests);
      return markRamp(mode, "wise", { ...result, provider: "wise" });
    } catch (err) {
      return reply.status(502).send({
        error: "wise_batch_failed",
        message: err instanceof Error ? err.message : "Failed to process batch payout",
      });
    }
  });

  // ── Webhooks ──────────────────────────────────────────────────────

  app.post("/api/fiat-ramp/webhook/stripe", async (req, reply) => {
    // RETIRED (audit PR2): unsigned webhook — any authenticated caller could forge a
    // Stripe event and mint credits. 410 unless the legacy dev-only flag is set.
    if (!legacyFiatCreditsEnabled()) {
      return reply.status(410).send({ error: "gone", message: RETIRED_FIAT_CREDITS_MSG });
    }
    const body = req.body as { type?: string; data?: { object?: Record<string, unknown> } } | undefined;
    if (!body?.type || !body?.data?.object) {
      return { received: false };
    }

    const client = getStripeOnramp();
    const session = client.handleWebhook(body.type, body.data.object);
    if (session) return { received: true, session };

    const credits = getStripeCredits();
    if (body.type === "checkout.session.completed") {
      const balance = credits.handleCheckoutWebhook(body.data.object);
      if (balance) return { received: true, balance };
    }

    return { received: true };
  });

  app.post("/api/fiat-ramp/webhook/yellowcard", async (req, reply) => {
    // RETIRED (audit PR2): unsigned webhook. Yellow Card also stays disabled until its
    // inbound X-YC-Signature (base64 HMAC-SHA256 of the raw body, per the Yellow Card
    // docs) is verified against a real signed sample. 410 unless the legacy flag is set.
    if (!legacyFiatCreditsEnabled()) {
      return reply.status(410).send({ error: "gone", message: RETIRED_FIAT_CREDITS_MSG });
    }
    const body = req.body as { event?: string; data?: Record<string, unknown> } | undefined;
    if (!body?.event || !body?.data) {
      return { received: false };
    }

    const { offramp, onramp } = getYellowcard();
    const offSession = offramp.handleWebhook(body.event, body.data);
    if (offSession) return { received: true, session: offSession };

    const onSession = onramp.handleWebhook(body.event, body.data);
    if (onSession) return { received: true, session: onSession };

    return { received: true };
  });

  // ── Session Listing ───────────────────────────────────────────────

  // Owner-scoped (board N48). This listing used to return EVERY account's ramp sessions,
  // wallet addresses and amounts included, to any key. A session records only the
  // wallet it pays into or out of, so a caller sees the sessions for its own wallet
  // (the API key's operator id or the SIWE address, when that is a wallet address);
  // an admin (X-Admin-Key) sees all.
  app.get<{
    Querystring: { provider?: string };
  }>("/api/fiat-ramp/sessions", async (req, reply) => {
    const admin = hasValidAdminKey(req.headers["x-admin-key"]);
    const principal = ((req as any).operatorId ?? (req as any).userId ?? null) as string | null;
    if (!admin && !principal) {
      return reply.status(401).send({ error: "authentication_required" });
    }
    const provider = req.query.provider;
    const sessions = [];

    if (!provider || provider === "stripe") {
      sessions.push(...getStripeOnramp().listSessions());
    }
    if (!provider || provider === "yellowcard") {
      const { offramp, onramp } = getYellowcard();
      sessions.push(...offramp.listSessions());
      sessions.push(...onramp.listSessions());
    }
    if (!provider || provider === "wise") {
      sessions.push(...getWise().payout.listSessions());
    }

    if (admin) return { sessions, scope: "all" };
    // A session is the caller's when the caller created it, or when it pays into or out of
    // the caller's wallet. Sessions created before creators were recorded match by wallet only.
    const me = String(principal).toLowerCase();
    const wallet = isAddress(String(principal), { strict: false }) ? me : null;
    return {
      sessions: sessions.filter(
        (s) =>
          String(s.createdBy ?? "").toLowerCase() === me ||
          (wallet !== null && String(s.walletAddress ?? "").toLowerCase() === wallet),
      ),
      scope: "caller",
      matchedBy: wallet ? ["created_by", "wallet"] : ["created_by"],
    };
  });

  // ── Testnet USDC Faucet (FREE — no fees, no KYC, no merchant) ───

  /**
   * POST /api/faucet/usdc
   *
   * Mints testnet USDC to any wallet address. Free. No fees.
   * Uses the deployed MockUSDC contract on Sepolia which has a
   * public mint() function.
   *
   * For testnet/hackathon use. In production, replace with real
   * USDC acquisition (direct transfer, Coinbase, etc.)
   */
  app.post("/api/faucet/usdc", async (req, reply) => {
    const body = req.body as { walletAddress: string; amount?: number } | undefined;

    if (!body?.walletAddress) {
      return reply.status(400).send({ error: "walletAddress is required" });
    }

    const amount = body.amount ?? 100; // Default: 100 USDC
    const maxDrip = 1000; // Max 1000 USDC per request
    if (amount <= 0 || amount > maxDrip) {
      return reply.status(400).send({ error: `Amount must be 1-${maxDrip} USDC` });
    }

    const MOCK_USDC = "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb";
    const amountRaw = BigInt(amount) * BigInt(1e6); // 6 decimals

    // Check if we have a private key for on-chain minting
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PCC_GATEWAY_PRIVATE_KEY;

    if (privateKey) {
      try {
        // Real on-chain mint via viem
        const { createWalletClient, http, encodeFunctionData } = await import("viem");
        const { privateKeyToAccount } = await import("viem/accounts");
        const { sepolia } = await import("viem/chains");

        const account = privateKeyToAccount(privateKey as `0x${string}`);
        const client = createWalletClient({
          account,
          chain: sepolia,
          transport: http("https://rpc.sepolia.org"),
        });

        const mintData = encodeFunctionData({
          abi: [{ name: "mint", type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
          functionName: "mint",
          args: [body.walletAddress as `0x${string}`, amountRaw],
        });

        const txHash = await client.sendTransaction({
          to: MOCK_USDC as `0x${string}`,
          data: mintData,
        });

        // A returned hash means the transaction was SUBMITTED, not that it minted.
        return {
          success: true,
          provider: "faucet",
          submitted: true,
          confirmed: false,
          walletAddress: body.walletAddress,
          amount: `${amount}.00`,
          currency: "mUSDC",
          network: "sepolia",
          txHash,
          tokenContract: MOCK_USDC,
          note: "Testnet mint transaction submitted; it is not confirmed here. Check the wallet's balance on Sepolia.",
        };
      } catch (err) {
        // A failed mint is a failure. It used to fall through to a mock "success" with a
        // made-up transaction hash.
        console.warn("[faucet] On-chain mint failed:", err instanceof Error ? err.message : err);
        // A transport failure can come after the transaction reached the network, so the
        // outcome is unknown: never "nothing was minted", never a made-up success.
        return reply.status(502).send({
          success: false,
          error: "mint_failed",
          submitted: "unknown",
          message:
            "The mint could not be confirmed: the transaction may or may not have been sent. " +
            "Check the wallet's balance before retrying.",
        });
      }
    }

    if (!isDemoRoutesOn()) {
      return reply.status(503).send({
        success: false,
        error: "not_configured",
        message: "The faucet has no minting key on this gateway, so nothing was minted.",
      });
    }
    // Demo only: nothing is minted, and the response says so. No transaction hash exists.
    return {
      success: false,
      provider: "faucet",
      mock: true,
      demo: true,
      minted: false,
      walletAddress: body.walletAddress,
      amount: `${amount}.00`,
      currency: "mUSDC",
      network: "sepolia",
      txHash: null,
      tokenContract: MOCK_USDC,
      note: "Demo faucet: nothing was minted.",
    };
  });

  /** GET /api/faucet/usdc — Quick drip via query params */
  app.get("/api/faucet/usdc", async (req, reply) => {
    const { wallet, amount } = req.query as { wallet?: string; amount?: string };

    if (!wallet) {
      return {
        endpoint: "POST /api/faucet/usdc",
        body: { walletAddress: "0x...", amount: 100 },
        description: "Free testnet USDC faucet. Mints mUSDC to any wallet on Sepolia. No fees, no KYC.",
        limits: { maxPerRequest: 1000, currency: "mUSDC", network: "sepolia" },
        tokenContract: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
        quickUrl: "/api/faucet/usdc?wallet=0x...&amount=100",
      };
    }

    // GET never mints, so it never reports a drip. It used to answer success with an
    // amount for any wallet.
    void amount;
    return reply.status(405).send({
      success: false,
      error: "use_post",
      message: "GET does not mint. POST /api/faucet/usdc with { walletAddress, amount } to mint.",
    });
  });
}
