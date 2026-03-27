/**
 * Fiat ramp routes — on-ramp (fiat→crypto) and off-ramp (crypto→fiat).
 *
 * Wires Stripe (US/EU on-ramp), Yellowcard (emerging market on/off-ramp),
 * and Wise (enterprise fiat payouts) into PCC's settlement flow.
 *
 * All providers run in mock mode unless env vars are set:
 *   STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY
 *   YELLOWCARD_API_KEY, YELLOWCARD_SECRET_KEY
 *   WISE_API_TOKEN, WISE_PROFILE_ID
 */

import type { FastifyInstance } from "fastify";
import { isAddress, type Address } from "viem";
import {
  StripeOnrampClient,
  StripeCreditService,
  YellowcardClient,
  YellowcardOfframp,
  YellowcardOnramp,
  WiseClient,
  WisePayoutService,
} from "@pcc/payments";

// ---------------------------------------------------------------------------
// Service singletons (lazy-init)
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
    const mock = !process.env.STRIPE_SECRET_KEY;
    stripeOnramp = new StripeOnrampClient({
      secretKey: process.env.STRIPE_SECRET_KEY ?? "sk_test_mock",
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "pk_test_mock",
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      mock,
    });
  }
  return stripeOnramp;
}

function getStripeCredits(): StripeCreditService {
  if (!stripeCredits) {
    stripeCredits = new StripeCreditService({
      secretKey: process.env.STRIPE_SECRET_KEY ?? "sk_test_mock",
      mock: !process.env.STRIPE_SECRET_KEY,
    });
  }
  return stripeCredits;
}

function getYellowcard(): { client: YellowcardClient; offramp: YellowcardOfframp; onramp: YellowcardOnramp } {
  if (!ycClient) {
    const mock = !process.env.YELLOWCARD_API_KEY;
    ycClient = new YellowcardClient({
      apiKey: process.env.YELLOWCARD_API_KEY ?? "yc_mock_key",
      secretKey: process.env.YELLOWCARD_SECRET_KEY ?? "yc_mock_secret",
      environment: (process.env.YELLOWCARD_ENVIRONMENT as "sandbox" | "production") ?? "sandbox",
      mock,
    });
    ycOfframp = new YellowcardOfframp(ycClient);
    ycOnramp = new YellowcardOnramp(ycClient);
  }
  return { client: ycClient, offramp: ycOfframp!, onramp: ycOnramp! };
}

function getWise(): { client: WiseClient; payout: WisePayoutService } {
  if (!wiseClient) {
    const mock = !process.env.WISE_API_TOKEN;
    wiseClient = new WiseClient({
      apiToken: process.env.WISE_API_TOKEN ?? "wise_mock_token",
      profileId: process.env.WISE_PROFILE_ID,
      environment: (process.env.WISE_ENVIRONMENT as "sandbox" | "production") ?? "sandbox",
      mock,
    });
    wisePayout = new WisePayoutService(wiseClient);
  }
  return { client: wiseClient, payout: wisePayout! };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function fiatRampRoutes(app: FastifyInstance) {
  // ── Status ────────────────────────────────────────────────────────

  app.get("/api/fiat-ramp/status", async () => {
    return {
      providers: {
        coinbase: {
          available: true,
          mock: !process.env.COINBASE_APP_ID,
          capabilities: ["onramp"],
          note: "Primary on-ramp. No merchant account needed. User pays via Coinbase or credit card → USDC on Base.",
        },
        stripe: {
          available: true,
          mock: !process.env.STRIPE_SECRET_KEY,
          capabilities: ["onramp", "credits"],
        },
        yellowcard: {
          available: true,
          mock: !process.env.YELLOWCARD_API_KEY,
          capabilities: ["onramp", "offramp"],
        },
        wise: {
          available: true,
          mock: !process.env.WISE_API_TOKEN,
          capabilities: ["payout"],
        },
      },
      recommended: "coinbase",
    };
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

    const appId = process.env.COINBASE_APP_ID ?? "pcc-hackathon";
    const asset = body.asset ?? "USDC";
    const network = body.network ?? "base";
    const fiatCurrency = body.currency ?? "USD";

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

    return {
      provider: "coinbase",
      onrampUrl,
      walletAddress: body.walletAddress,
      asset,
      network,
      fiatCurrency,
      amount: body.amount ?? null,
      instructions: "Open the URL to fund your wallet. Pay with credit card, debit card, or Coinbase account. USDC arrives on Base in ~1 minute.",
      mock: !process.env.COINBASE_APP_ID,
      note: process.env.COINBASE_APP_ID
        ? "Live Coinbase Onramp"
        : "Using default app ID. Set COINBASE_APP_ID env var for production. Get one at https://portal.cdp.coinbase.com",
    };
  });

  /** GET /api/fiat-ramp/coinbase/onramp-url — Quick URL generator (GET for easy linking) */
  app.get("/api/fiat-ramp/coinbase/onramp-url", async (req) => {
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

    const appId = process.env.COINBASE_APP_ID ?? "pcc-hackathon";
    const params = new URLSearchParams();
    params.set("appId", appId);
    params.set("defaultAsset", "USDC");
    params.set("defaultNetwork", "base");
    params.set("addresses", JSON.stringify({ [wallet]: ["base"] }));
    params.set("assets", JSON.stringify(["USDC"]));
    if (amount) params.set("presetFiatAmount", amount);
    if (currency) params.set("fiatCurrency", currency);

    return {
      url: `https://pay.coinbase.com/buy/select-asset?${params.toString()}`,
      wallet,
    };
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
      });

      return {
        session,
        publishableKey: client.publishableKey,
        provider: "stripe",
      };
    } catch (err) {
      return reply.status(502).send({
        error: "stripe_onramp_failed",
        message: err instanceof Error ? err.message : "Failed to create onramp session",
      });
    }
  });

  // ── Stripe: Prepaid Credits ───────────────────────────────────────

  app.post<{
    Body: { userId: string; amountUsd: number };
  }>("/api/fiat-ramp/stripe/credits/deposit", async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body?.userId || !body?.amountUsd) {
      return reply.status(400).send({ error: "userId and amountUsd are required" });
    }

    try {
      const credits = getStripeCredits();
      const result = await credits.createDepositSession(
        body.userId as string,
        body.amountUsd as number,
      );
      return { ...result, provider: "stripe" };
    } catch (err) {
      return reply.status(502).send({
        error: "stripe_credits_failed",
        message: err instanceof Error ? err.message : "Failed to create credit deposit",
      });
    }
  });

  app.get<{
    Params: { userId: string };
  }>("/api/fiat-ramp/stripe/credits/:userId", async (req, reply) => {
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
  }>("/api/fiat-ramp/yellowcard/channels", async (_req) => {
    const { client } = getYellowcard();
    const channels = await client.getChannels(_req.query.country);
    return { channels };
  });

  app.get("/api/fiat-ramp/yellowcard/rates", async () => {
    const { client } = getYellowcard();
    const rates = await client.getRates();
    return { rates };
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
      });

      return { ...result, provider: "yellowcard" };
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
      });

      return { ...result, provider: "yellowcard" };
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

    try {
      const { payout } = getWise();
      const profileId = parseInt(process.env.WISE_PROFILE_ID ?? "12345", 10);
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
      });

      return { ...result, provider: "wise" };
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

    try {
      const { payout } = getWise();
      const profileId = parseInt(process.env.WISE_PROFILE_ID ?? "12345", 10);
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
        };
      });

      const result = await payout.sendBatch(requests);
      return { ...result, provider: "wise" };
    } catch (err) {
      return reply.status(502).send({
        error: "wise_batch_failed",
        message: err instanceof Error ? err.message : "Failed to process batch payout",
      });
    }
  });

  // ── Webhooks ──────────────────────────────────────────────────────

  app.post("/api/fiat-ramp/webhook/stripe", async (req) => {
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

  app.post("/api/fiat-ramp/webhook/yellowcard", async (req) => {
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

  app.get<{
    Querystring: { provider?: string };
  }>("/api/fiat-ramp/sessions", async (req) => {
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

    return { sessions };
  });
}
