/**
 * Fastify x402 payment gate.
 *
 * Registers as a Fastify plugin. Protected routes return 402
 * with payment requirements unless the request carries a valid
 * PAYMENT-SIGNATURE header.
 *
 * Currently in mock mode — always verifies payments.
 * Switch to real facilitator by setting PCC_X402_FACILITATOR_URL.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { X402Middleware, type RoutePaymentMap, type X402Config } from "@pcc/payments";

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
  // x402 is controlled by env var — disabled by default for dev
  const enabled = process.env.PCC_X402_ENABLED === "true";

  // Pre-handler hook for all requests
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

  // Payment stats endpoint (admin/debug)
  app.get("/api/x402/stats", async () => {
    return {
      enabled,
      ...stats,
      protectedRoutes: Object.entries(protectedRoutes).map(([key, rc]) => ({
        route: key,
        price: rc.price,
        description: rc.description,
      })),
    };
  });

  // List all x402-protected routes (public — helps clients know what needs payment)
  app.get("/api/x402/routes", async () => {
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
