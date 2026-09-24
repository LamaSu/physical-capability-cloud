/**
 * AEGIS content scanning gate — Fastify middleware.
 *
 * Scans incoming request bodies for adversarial content before they
 * reach any handler. Uses the same ContentScanner interface as the
 * A2A SecurityMiddleware, so the same PatternScanner (or future
 * DESTILL API backend) works in both layers.
 *
 * Integration point: registered BEFORE auth and REST routes in server.ts.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ContentScanResult } from "@pcc/spec";
import { PatternScanner, type ContentScanner } from "@pcc/a2a";

export interface AegisGateConfig {
  /** Content scanner backend (default: PatternScanner) */
  scanner?: ContentScanner;
  /** Route prefixes to scan (default: ["/api/"]) */
  scanPrefixes?: string[];
  /** Routes to skip scanning (exact match on "METHOD /path") */
  skipRoutes?: string[];
  /** What to do on REVIEW decisions (default: "pass") */
  reviewAction?: "pass" | "block";
  /** Callback when a request is blocked */
  onBlock?: (req: FastifyRequest, result: ContentScanResult) => void;
}

const DEFAULT_SKIP_ROUTES = [
  "GET /api/health",
  "GET /api/x402/stats",
  "GET /api/x402/routes",
  "GET /api/producers/status",
  "GET /api/agents/status",
  "GET /api/agents/cards",
];

/**
 * Extract text content from a request body for scanning.
 * Recursively finds all string values in the JSON body.
 */
function extractTextFields(body: unknown, depth = 0): string[] {
  if (depth > 5) return []; // prevent deep recursion
  if (typeof body === "string") return body.length > 0 ? [body] : [];
  if (Array.isArray(body)) return body.flatMap((v) => extractTextFields(v, depth + 1));
  if (body && typeof body === "object") {
    return Object.values(body).flatMap((v) => extractTextFields(v, depth + 1));
  }
  return [];
}

export async function aegisGate(app: FastifyInstance, opts?: AegisGateConfig) {
  const scanner = opts?.scanner ?? new PatternScanner();
  const scanPrefixes = opts?.scanPrefixes ?? ["/api/"];
  const skipRoutes = new Set([...DEFAULT_SKIP_ROUTES, ...(opts?.skipRoutes ?? [])]);
  const reviewAction = opts?.reviewAction ?? "pass";

  // Track stats
  let totalScanned = 0;
  let totalBlocked = 0;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Only scan relevant prefixes
    const path = req.url.split("?")[0];
    if (!scanPrefixes.some((p) => path.startsWith(p))) return;

    // Skip GET requests (no body) and explicitly skipped routes
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const routeKey = `${req.method} ${path}`;
    if (skipRoutes.has(routeKey)) return;
  });

  // Use preHandler to access parsed body (onRequest fires before body parsing)
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0];
    if (!scanPrefixes.some((p) => path.startsWith(p))) return;
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const routeKey = `${req.method} ${path}`;
    if (skipRoutes.has(routeKey)) return;

    const body = req.body;
    if (!body || typeof body !== "object") return;

    const textFields = extractTextFields(body);
    if (textFields.length === 0) return;

    const content = textFields.join("\n");
    const result = await scanner.scan(content, {
      intentType: routeKey,
    });

    totalScanned++;

    if (result.decision === "BLOCK") {
      totalBlocked++;
      opts?.onBlock?.(req, result);
      return reply.code(403).send({
        error: "AEGIS_BLOCKED",
        zone: result.zone,
        confidence: result.confidence,
        triggeredLayers: result.triggeredLayers,
      });
    }

    if (result.decision === "REVIEW" && reviewAction === "block") {
      totalBlocked++;
      opts?.onBlock?.(req, result);
      return reply.code(403).send({
        error: "AEGIS_REVIEW_BLOCKED",
        zone: result.zone,
        confidence: result.confidence,
      });
    }

    // Attach scan result to request for downstream use
    (req as any).aegisScan = result;
  });

  // Stats endpoint
  app.get("/api/aegis/stats", async () => ({
    scanner: scanner.name,
    scanned: totalScanned,
    blocked: totalBlocked,
    passRate: totalScanned > 0 ? (totalScanned - totalBlocked) / totalScanned : 1,
  }));
}
