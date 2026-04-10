/**
 * Fastify payment gate — supports both MPP (mppx/Tempo, default) and x402 (legacy).
 *
 * Registers as a Fastify plugin. Protected routes return 402
 * with payment requirements unless the request carries valid payment.
 *
 * Protocol selection via environment variable:
 *   (default)           -> MPP (mppx/Tempo) — requires MPP_SECRET_KEY
 *   PCC_X402_LEGACY=true -> x402 (legacy, deprecated)
 *   MPP_ENABLED=true    -> backwards-compat alias for MPP (same as default now)
 *
 * x402 mode: mock (always verifies). Set PCC_X402_FACILITATOR_URL for real.
 * MPP mode: uses mppx with Tempo charge method + WWW-Authenticate headers.
 *
 * @deprecated x402 path — activate with PCC_X402_LEGACY=true
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { X402Middleware, type RoutePaymentMap, type X402Config } from "@pcc/payments";
import { MppMiddleware } from "@pcc/payments";

// ---------------------------------------------------------------------------
// Shared route pricing — single source of truth for both protocols
// ---------------------------------------------------------------------------

interface RoutePricing {
  /** Human-readable dollar price e.g. "$0.01" */
  price: string;
  description: string;
}

/** Canonical payment route map — both protocols are derived from this. */
export const PAYMENT_ROUTES: Record<string, RoutePricing> = {
  "POST /api/capabilities/quote": {
    price: "$0.01",
    description: "Quote a workflow — returns pricing breakdown",
  },
  "POST /api/capabilities/simulate": {
    price: "$0.05",
    description: "Dry-run simulation — estimate time, cost, and resource usage",
  },
  "POST /api/capabilities/route": {
    price: "$0.02",
    description: "Optimization routing — find best kernel assignment",
  },
  "GET /api/capabilities/search": {
    price: "$0.001",
    description: "Search capabilities across all kernels",
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PCC_TREASURY = (process.env.PCC_TREASURY_ADDRESS ?? "0x0000000000000000000000000000000000000001") as `0x${string}`;
const NETWORK = "eip155:84532"; // Base Sepolia
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC

const x402Config: X402Config = {
  facilitatorUrl: process.env.PCC_X402_FACILITATOR_URL ?? "http://localhost:4020",
  network: NETWORK,
  usdcAddress: USDC_ADDRESS,
  treasuryAddress: PCC_TREASURY,
};

/** Build the x402 RoutePaymentMap from the shared PAYMENT_ROUTES constant. */
function buildX402Routes(): RoutePaymentMap {
  const result: RoutePaymentMap = {};
  for (const [routeKey, { price, description }] of Object.entries(PAYMENT_ROUTES)) {
    const [, ...pathParts] = routeKey.split(" ");
    result[routeKey] = {
      price,
      scheme: "exact",
      network: NETWORK,
      payTo: PCC_TREASURY,
      description,
    };
  }
  return result;
}

const TEMPO_RECIPIENT = (process.env.TEMPO_RECIPIENT ?? PCC_TREASURY) as `0x${string}`;
const TEMPO_CURRENCY = (process.env.TEMPO_CURRENCY ?? USDC_ADDRESS) as `0x${string}`;

/** Build the MPP route map from the shared PAYMENT_ROUTES constant. */
function buildMppRoutes(): import("@pcc/spec").MppRouteMap {
  const result: import("@pcc/spec").MppRouteMap = {};
  for (const [routeKey, { price, description }] of Object.entries(PAYMENT_ROUTES)) {
    result[routeKey] = {
      amount: MppMiddleware.parsePrice(price),
      description,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Derived route maps (built from PAYMENT_ROUTES)
// ---------------------------------------------------------------------------

const protectedRoutes: RoutePaymentMap = buildX402Routes();
const mppRoutes = buildMppRoutes();

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

export async function paymentGate(app: FastifyInstance) {
  // Payment gate is controlled by env var — disabled by default for dev
  // Support both old (PCC_X402_ENABLED) and new (PCC_PAYMENT_ENABLED) names
  const enabled =
    process.env.PCC_PAYMENT_ENABLED === "true" ||
    process.env.PCC_X402_ENABLED === "true";

  // MPP is the default. x402 is legacy — opt-in with PCC_X402_LEGACY=true.
  // MPP_ENABLED=true is a backwards-compat alias (was the opt-in flag before the inversion).
  const x402Legacy =
    process.env.PCC_X402_LEGACY === "true" ||
    (process.env.MPP_ENABLED === undefined && process.env.PCC_X402_LEGACY === undefined
      ? false // new default: MPP
      : process.env.MPP_ENABLED === "false"); // explicit opt-out of MPP = x402 legacy

  const useMpp = !x402Legacy;
  const protocol = useMpp ? "mpp" : "x402";

  // Lazily create MPP middleware only when MPP is requested
  let mppMiddleware: MppMiddleware | null = null;
  if (useMpp && enabled) {
    const secretKey = process.env.MPP_SECRET_KEY;
    if (!secretKey) {
      app.log.warn("[payment-gate] MPP is the default but MPP_SECRET_KEY is not set — falling back to x402. Set MPP_SECRET_KEY or use PCC_X402_LEGACY=true to silence this warning.");
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

  // --- x402 path (legacy, deprecated) ---
  // @deprecated Use MPP (default) instead. Activate with PCC_X402_LEGACY=true.
  if (!mppMiddleware) {
    if (x402Legacy && enabled) {
      app.log.warn(
        "[payment-gate] x402 is deprecated. Set MPP_SECRET_KEY and remove PCC_X402_LEGACY=true to upgrade to MPP.",
      );
    }

    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      if (!enabled) return; // payment disabled — all routes free

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
        // Deprecation signal to clients
        "X-PCC-Deprecated": "x402",
      }).send({
        error: "payment_required",
        message: result.payload.resource.description,
        x402Version: 2,
        deprecated: true,
        upgrade: "Set MPP_SECRET_KEY on the server and use WWW-Authenticate/Authorization headers (MPP/Tempo protocol).",
      });
    });
  }

  // Payment stats endpoint (admin/debug)
  // Note: URL kept as /api/x402/stats for backwards compat — deprecated when MPP is active
  app.get("/api/x402/stats", async () => {
    return {
      enabled,
      protocol,
      deprecated: protocol === "x402",
      ...stats,
      protectedRoutes: Object.entries(PAYMENT_ROUTES).map(([key, rc]) => ({
        route: key,
        price: rc.price,
        description: rc.description,
      })),
    };
  });

  // List all protected routes (public — helps clients know what needs payment)
  // Note: URL kept as /api/x402/routes for backwards compat — deprecated when MPP is active
  app.get("/api/x402/routes", async () => {
    if (mppMiddleware) {
      return {
        protocol: "mpp",
        deprecated: false,
        routes: mppMiddleware.getProtectedRoutes(),
      };
    }
    return {
      protocol: "x402",
      deprecated: true,
      x402Version: 2,
      network: x402Config.network,
      payTo: x402Config.treasuryAddress,
      routes: Object.entries(PAYMENT_ROUTES).map(([key, rc]) => ({
        method: key.split(" ")[0],
        path: key.split(" ")[1],
        price: rc.price,
        scheme: "exact",
        description: rc.description,
      })),
    };
  });
}

/**
 * @deprecated Use `paymentGate` instead. This alias exists for backwards compatibility
 * with any code that imports `x402Gate` directly. Will be removed in a future release.
 */
export const x402Gate = paymentGate;
