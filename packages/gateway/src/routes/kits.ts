/**
 * Capability Kit registry routes (kits K1 slice 1). The registry, its
 * write-once storage and its integrity rules live in services/kit-registry.ts.
 *
 *   GET  /api/kits                      list published kits (filters: csdUrl, deviceFamily, interface, q; limit, offset)
 *   GET  /api/kits/:digest              one verified kit: its manifest and publication time
 *   POST /api/kits                      publish a complete kit (an API key with a publishing scope; the principal is recorded, never shown)
 *   POST /api/kits/:digest/fork         publish a kit whose parentKitDigest is :digest (same rule)
 *
 * The publishing role is checked HERE, not left to the scope-checker's
 * defaults (astra k1-511): an API key holding template_author, operator, admin
 * or *. A SIWE session carries no scopes and is refused.
 *
 * There is no update or delete: a published version never changes, and an edit
 * is a new manifest. Deprecation needs publisher ownership under WP-A's identity
 * rules, so it is slice 2. No response carries the publisher.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getCallerScopes } from "../middleware/scope-checker.js";
import { getKitRegistry, KitIntegrityError, KitRegistryError, type KitRegistry } from "../services/kit-registry.js";

/** The API-key scopes that may publish or fork a kit (as for template authoring). */
export const KIT_PUBLISH_SCOPES: readonly string[] = ["*", "template_author", "operator", "admin"];

const ListQuerySchema = z
  .object({
    csdUrl: z.string().min(1).max(200).optional(),
    deviceFamily: z.string().min(1).max(120).optional(),
    interface: z.string().min(1).max(120).optional(),
    q: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

/** The authenticated principal, as the gateway's auth layer records it; null when there is none. */
function principalOf(req: FastifyRequest): string | null {
  const r = req as unknown as { operatorId?: unknown; userId?: unknown };
  const id = r.operatorId ?? r.userId;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * Whether this caller may publish: an API key holding one of KIT_PUBLISH_SCOPES,
 * decided HERE (astra k1-511), so it holds for any deployment configuration.
 * A SIWE session carries no scopes, so it cannot show a publishing role and is
 * refused until sessions have one.
 */
function publishRefusal(
  req: FastifyRequest,
  callerScopes: (req: FastifyRequest) => string[],
): { status: number; error: string; message: string } | null {
  const r = req as unknown as { apiKeyId?: unknown };
  if (typeof r.apiKeyId !== "string" || r.apiKeyId === "") {
    return { status: 403, error: "kit_publish_requires_api_key", message: "publishing a kit needs an API key with a publishing scope; a wallet session has none" };
  }
  const scopes = callerScopes(req);
  if (!KIT_PUBLISH_SCOPES.some((s) => scopes.includes(s))) {
    return { status: 403, error: "insufficient_scope", message: `publishing a kit needs one of: ${KIT_PUBLISH_SCOPES.join(", ")}` };
  }
  return null;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof KitRegistryError) {
    return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
  }
  if (err instanceof KitIntegrityError) {
    reply.log?.error?.({ kitDigest: err.kitDigest }, "kit registry integrity failure");
    return reply.status(500).send({ error: err.code, message: "the stored kit failed verification and is not served" });
  }
  throw err;
}

export async function kitRoutes(
  app: FastifyInstance,
  opts: { registry?: KitRegistry; callerScopes?: (req: FastifyRequest) => string[] } = {},
): Promise<void> {
  const registry = (): KitRegistry => opts.registry ?? getKitRegistry();
  // The API key's scopes; injectable so route tests need no database.
  const callerScopes = opts.callerScopes ?? getCallerScopes;

  app.get("/api/kits", async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    try {
      return await registry().list(parsed.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { digest: string } }>("/api/kits/:digest", async (req, reply) => {
    try {
      const kit = await registry().get(req.params.digest);
      if (!kit) return reply.status(404).send({ error: "not_found", message: "no published kit has that digest" });
      return { kit };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/kits", async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return reply.status(401).send({ error: "missing_identity", message: "publishing a kit needs an authenticated principal" });
    const refusal = publishRefusal(req, callerScopes);
    if (refusal) return reply.status(refusal.status).send({ error: refusal.error, message: refusal.message });
    try {
      const result = await registry().publish(req.body, principal);
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { digest: string } }>("/api/kits/:digest/fork", async (req, reply) => {
    const principal = principalOf(req);
    if (!principal) return reply.status(401).send({ error: "missing_identity", message: "forking a kit needs an authenticated principal" });
    const refusal = publishRefusal(req, callerScopes);
    if (refusal) return reply.status(refusal.status).send({ error: refusal.error, message: refusal.message });
    try {
      const result = await registry().publish(req.body, principal, { forkOf: req.params.digest });
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
