import type { FastifyInstance } from "fastify";
import { generateJWKS } from "@pcc/a2a-signing";
import { getActiveSigningKey } from "../signing-key.js";

/**
 * GET /.well-known/jwks.json
 *
 * Serves the public JWKS containing the active agent-card signing key.
 * Used by A2A verifiers to resolve the `kid` from a signed agent card's
 * JWS `protected` header back to a verification key.
 *
 * PUBLIC: no auth (per JWS verification norms — JWKS endpoints must be
 * universally reachable so that any verifier can verify a signature).
 * CORS: wildcard. Cache: 5 minutes (matches the agent-card cache TTL).
 *
 * If `PCC_AGENT_CARD_SIGNING_KEY` is unset (no active signing key), the
 * endpoint returns an empty JWKS so that clients can distinguish "issuer
 * does not sign" from "key fetch failed".
 *
 * Spec: A2A v1.0 §8.4 (Agent Card Signature) + RFC 7517 (JWK).
 */
export async function jwksRoutes(app: FastifyInstance) {
  app.get(
    "/.well-known/jwks.json",
    {
      schema: {
        tags: ["well-known"],
        summary: "A2A v1.0 Agent Card signing JWKS (public)",
        description:
          "JSON Web Key Set containing the public key(s) used to sign " +
          "this issuer's A2A Agent Card. Verifiers fetch this to verify " +
          "a card's JWS signature. PUBLIC, no auth.",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              keys: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const key = getActiveSigningKey();
      const jwks = key
        ? await generateJWKS(key.publicKey, key.kid)
        : { keys: [] };

      return reply
        .header("content-type", "application/jwk-set+json")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=300")
        .send(jwks);
    },
  );
}
