/**
 * API Gate middleware.
 *
 * Requires either a valid API key or SIWE session for all /api/* routes,
 * except explicitly public routes (health, auth, feedback, landing page assets).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveApiKey } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";

/** Routes that don't require any auth */
const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/auth/provision",        // Key provisioning is public
  "/api/auth/validate",         // Key validation is public (checks key itself)
  "/api/feedback",
  "/api/onboard/check/",        // Invite code validation is public
  // REMOVED: "/api/onboard/registrations" — prefix match was too broad, exposed admin
  // endpoints (approve/reject/activate) without auth. Now uses exact match below.
  "/api/dht/",                  // DHT discovery is public (distributed capability queries)
  "/api/marketplace/",          // Marketplace browsing is public (see what's available)
  "/.well-known/",
];

const PUBLIC_EXACT = [
  "/api/capabilities/types",   // Discovery is public (see what's available)
  "/api/capabilities",         // Capability listing is public
  "/api/kernels",              // Kernel listing is public (find operators)
  "/api/agents/status",        // Network status is public
  "/api/onboard/registrations", // EXACT match only — GET listing is public, but
                                // sub-paths like /approve, /reject, /activate require auth
];

// Capability detail routes are public — discovery, widget embedding, etc.
// Covers: /api/capabilities/:id  AND  /api/capabilities/:id/button
const PUBLIC_CAPABILITY_DETAIL_RE = /^\/api\/capabilities\/[^/]+(?:\/button)?$/;

function isPublicRoute(url: string): boolean {
  const path = url.split("?")[0];
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (PUBLIC_EXACT.includes(path)) return true;
  if (PUBLIC_CAPABILITY_DETAIL_RE.test(path)) return true;
  return false;
}

export async function apiGate(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Only gate /api/* routes
    if (!req.url.startsWith("/api/")) return;

    // Skip public routes
    if (isPublicRoute(req.url)) return;

    // Try API key first (most common for agents)
    const apiKey = resolveApiKey(req);
    if (apiKey) {
      req.apiKeyId = apiKey.id;
      req.operatorId = apiKey.operatorId;
      req.userId = apiKey.operatorId as `0x${string}`;
      return;
    }

    // Try SIWE session (dashboard users)
    const session = resolveSession(req);
    if (session) {
      req.userId = session.address;
      return;
    }

    // No auth — reject
    return reply.status(401).send({
      error: "api_key_required",
      message: "This endpoint requires authentication. Provide an API key via Authorization: Bearer pcc_live_... header, or sign in with your wallet.",
      provision_url: "/api/auth/provision",
      docs: "https://capability.network/whitepaper.md",
    });
  });
}
