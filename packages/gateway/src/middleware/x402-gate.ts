/**
 * Fastify payment gate — supports both x402 (legacy) and MPP (mppx).
 *
 * Registers as a Fastify plugin. Protected routes return 402
 * with payment requirements unless the request carries valid payment.
 *
 * Protocol selection via environment variable:
 *   MPP_ENABLED=true   -> Use mppx/Tempo (new, recommended)
 *   MPP_ENABLED=false   -> Use x402 (legacy fallback, default)
 *
 * x402 mode: mock (always verifies). Set PCC_X402_FACILITATOR_URL for real.
 * MPP mode: uses mppx with Tempo charge method + WWW-Authenticate headers.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { X402Middleware, type RoutePaymentMap, type X402Config } from "@pcc/payments";
import { MppMiddleware } from "@pcc/payments";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PCC_TREASURY = (process.env.PCC_TREASURY_ADDRESS ?? "0x0000000000000000000000000000000000000001") as `0x${string}`;

const x402Config: X402Config = {
  facilitatorUrl: process.env.PCC_X402_FACILITATOR_URL ?? "http://localhost:4020",
  network: "eip155:84532", // Base Sepolia
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia USDC
  treasuryAddress: PCC_TREASURY,
};

/**
 * Routes that require x402 payment.
 * key = "METHOD /path"
 * value = route payment config
 */
const protectedRoutes: RoutePaymentMap = {
  "POST /api/capabilities/quote": {
    price: "$0.01",
    scheme: "exact",
    network: "eip155:84532",
    payTo: PCC_TREASURY,
    description: "Quote a workflow — returns pricing breakdown",
  },
  "POST /api/capabilities/simulate": {
    price: "$0.05",
    scheme: "exact",
    network: "eip155:84532",
    payTo: PCC_TREASURY,
    description: "Dry-run simulation — estimate time, cost, and resource usage",
  },
  "POST /api/capabilities/route": {
    price: "$0.02",
    scheme: "exact",
    network: "eip155:84532",
    payTo: PCC_TREASURY,
    description: "Optimization routing — find best kernel assignment",
  },
  "GET /api/capabilities/search": {
    price: "$0.001",
    scheme: "exact",
    network: "eip155:84532",
    payTo: PCC_TREASURY,
    description: "Search capabilities across all kernels",
  },
};

// ---------------------------------------------------------------------------
// MPP Configuration (new — mppx/Tempo)
// ---------------------------------------------------------------------------

const TEMPO_RECIPIENT = (process.env.TEMPO_RECIPIENT ?? PCC_TREASURY) as `0x${string}`;
const TEMPO_CURRENCY = (process.env.TEMPO_CURRENCY ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;

/** MPP route map — same routes, expressed in mppx format (amount in atomic units) */
const mppRoutes: import("@pcc/spec").MppRouteMap = {
  "POST /api/capabilities/quote": {
    amount: MppMiddleware.parsePrice("$0.01"),
    description: "Quote a workflow — returns pricing breakdown",
  },
  "POST /api/capabilities/simulate": {
    amount: MppMiddleware.parsePrice("$0.05"),
    description: "Dry-run simulation — estimate time, cost, and resource usage",
  },
  "POST /api/capabilities/route": {
    amount: MppMiddleware.parsePrice("$0.02"),
    description: "Optimization routing — find best kernel assignment",
  },
  "GET /api/capabilities/search": {
    amount: MppMiddleware.parsePrice("$0.001"),
    description: "Search capabilities across all kernels",
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const middleware = new X402Middleware(x402Config, protectedRoutes);

/** Payment stats tracking */
interface PaymentStats {
  totalRequests: number;
  paidRequests: number;
  gatedRequests: number;
  totalRevenue: string; // In USDC atomic units
  recentPayments: Array<{
    path: string;
    payer: string;
    amount: string;
    timestamp: string;
  }>;
}

const stats: PaymentStats = {
  totalRequests: 0,
  paidRequests: 0,
  gatedRequests: 0,
  totalRevenue: "0",
  recentPayments: [],
};

export async function x402Gate(app: FastifyInstance) {
  // Payment gate is controlled by env var — disabled by default for dev
  const enabled = process.env.PCC_X402_ENABLED === "true";

  // MPP feature flag — when true, use mppx/Tempo instead of x402
  const mppEnabled = process.env.MPP_ENABLED === "true";
  const protocol = mppEnabled ? "mpp" : "x402";

  // Lazily create MPP middleware only when MPP_ENABLED=true
  let mppMiddleware: MppMiddleware | null = null;
  if (mppEnabled && enabled) {
    const secretKey = process.env.MPP_SECRET_KEY;
    if (!secretKey) {
      app.log.warn("[payment-gate] MPP_ENABLED=true but MPP_SECRET_KEY not set — falling back to x402");
    } else {
      mppMiddleware = new MppMiddleware({
        secretKey,
        realm: process.env.MPP_REALM,
        recipient: TEMPO_RECIPIENT,
        currency: TEMPO_CURRENCY,
        testnet: process.env.MPP_TESTNET !== "false",
        routes: mppRoutes,
      });
    }
  }

  // --- MPP path (mppx/Tempo) ---
  if (mppMiddleware) {
    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      if (!enabled) return;
      stats.totalRequests++;

      const path = req.url.split("?")[0];
      const check = mppMiddleware!.getRouteHandler(req.method, path);

      if (!check.isProtected) return; // Free route

      // Create a Web API Request from the Fastify request for mppx
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
      }

      const webRequest = new Request(
        `${req.protocol}://${req.hostname}${req.url}`,
        {
          method: req.method,
          headers,
        },
      );

      try {
        const handler = mppMiddleware!.createChargeHandler(check.routeConfig);
        const result = await handler(webRequest);

        if (result.status === 402) {
          // Payment required — send 402 with WWW-Authenticate header
          stats.gatedRequests++;
          const challengeResponse = result.challenge as Response;
          const wwwAuth = challengeResponse.headers.get("WWW-Authenticate") ?? "";

          reply.status(402).headers({
            "WWW-Authenticate": wwwAuth,
            "Content-Type": "application/json",
          }).send({
            error: "payment_required",
            protocol: "mpp",
            message: check.routeConfig.description,
          });
          return;
        }

        // Payment verified — track and continue
        stats.paidRequests++;
        stats.recentPayments.unshift({
          path: req.url,
          payer: "mpp-verified",
          amount: check.routeConfig.amount,
          timestamp: new Date().toISOString(),
        });
        if (stats.recentPayments.length > 50) stats.recentPayments.pop();
      } catch (err) {
        // Fail CLOSED — payment verification errors block the request (HIGH-05 fix)
        app.log.error({ err }, "[payment-gate] MPP payment check error — blocking request");
        stats.gatedRequests++;
        reply.status(402).headers({ "Content-Type": "application/json" }).send({
          error: "payment_verification_failed",
          message: "Payment verification encountered an error. Please try again.",
        });
        return;
      }
    });
  }

  // --- x402 path (legacy fallback) ---
  if (!mppMiddleware) {
    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      if (!enabled) return; // x402 disabled — all routes free

      stats.totalRequests++;

      const paymentSig = req.headers["payment-signature"] as string | undefined;
      const result = middleware.checkPayment(req.method, req.url.split("?")[0], paymentSig);

      if (!result.requiresPayment) {
        if (paymentSig) {
          // Payment was provided — verify and track
          try {
            const payload = middleware.decodePaymentSignature(paymentSig);
            const verification = await middleware.verifyPayment(payload);
            if (verification.valid) {
              stats.paidRequests++;
              stats.recentPayments.unshift({
                path: req.url,
                payer: verification.payer ?? "unknown",
                amount: payload.accepted.amount,
                timestamp: new Date().toISOString(),
              });
              if (stats.recentPayments.length > 50) stats.recentPayments.pop();
            }
          } catch {
            // If payment decode fails, still let through (middleware said not required)
          }
        }
        return; // Free or paid — continue
      }

      // 402 — payment required
      stats.gatedRequests++;
      const encoded = middleware.encodeHeader(result.payload);
      reply.status(402).headers({
        "PAYMENT-REQUIRED": encoded,
        "Content-Type": "application/json",
      }).send({
        error: "payment_required",
        message: result.payload.resource.description,
        x402Version: 2,
      });
    });
  }

  // Payment stats endpoint (admin/debug)
  app.get("/api/x402/stats", async () => {
    return {
      enabled,
      protocol,
      ...stats,
      protectedRoutes: Object.entries(protectedRoutes).map(([key, rc]) => ({
        route: key,
        price: rc.price,
        description: rc.description,
      })),
    };
  });

  // List all protected routes (public — helps clients know what needs payment)
  app.get("/api/x402/routes", async () => {
    if (mppMiddleware) {
      return {
        protocol: "mpp",
        routes: mppMiddleware.getProtectedRoutes(),
      };
    }
    return {
      x402Version: 2,
      network: x402Config.network,
      payTo: x402Config.treasuryAddress,
      routes: Object.entries(protectedRoutes).map(([key, rc]) => ({
        method: key.split(" ")[0],
        path: key.split(" ")[1],
        price: rc.price,
        scheme: rc.scheme,
        description: rc.description,
      })),
    };
  });
}
