/**
 * Ephemeral Session Key Routes -- Issue, verify, and revoke session keys.
 *
 * POST /api/identity/session          — Issue a new session key
 * POST /api/identity/session/verify   — Verify a SessionSignedEvent
 * POST /api/identity/session/revoke   — Revoke a session key
 */

import type { FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { SessionKeyService } from "@pcc/verifier";
import type {
  PrincipalKey,
  SessionAction,
  SessionSignedEvent,
} from "@pcc/spec";

// ── Hex encoding helpers ────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ── Request validation ──────────────────────────────────────────────────────

/**
 * The first problem with the scope lists in an UNTYPED request body, or null.
 *
 * A list that is absent (undefined or null) means "use the default", as it
 * always has. A list that is present must be an array of strings; anything else
 * is a 400 here rather than a 500 from issueSessionKey, which enforces the same
 * rule and then sorts and de-duplicates the lists.
 */
function scopeProblem(scope: unknown): string | null {
  if (scope === null || typeof scope !== "object") return null;
  const lists = scope as Record<string, unknown>;
  for (const field of ["allowedActions", "contractIds"] as const) {
    const value = lists[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) return `scope.${field} must be an array of strings`;
    const bad = value.findIndex((item) => typeof item !== "string");
    if (bad !== -1) return `scope.${field}[${bad}] must be a string`;
  }
  return null;
}

// ── Service singleton ───────────────────────────────────────────────────────

const sessionKeyService = new SessionKeyService();

// ── In-memory revocation set (production would use DB) ──────────────────────

const revokedSessionIds = new Set<string>();

// ── Routes ──────────────────────────────────────────────────────────────────

export async function identitySessionRoutes(app: FastifyInstance) {
  /**
   * POST /api/identity/session
   *
   * Issue a new ephemeral session key for an authenticated principal.
   *
   * Body: {
   *   principalAgentId: string,
   *   scope?: { allowedActions?: string[], contractIds?: string[] },
   *   ttlSeconds?: number
   * }
   *
   * Returns: {
   *   sessionKey: { sessionId, parentAgentId, publicKey (hex), issuedAt, expiresAt, scope },
   *   sessionPrivateKey: hex (ONLY returned once!)
   * }
   *
   * The returned scope is canonical: allowedActions and contractIds are
   * de-duplicated and sorted (UTF-16 code-unit order) whatever order or
   * duplicates the request carried, and it is the scope the parent signed.
   * A present scope list that is not an array of strings is a 400
   * `invalid_scope`.
   *
   * The private key is returned exactly ONCE and never stored by the gateway.
   */
  app.post("/api/identity/session", async (req, reply) => {
    const body = req.body as {
      principalAgentId: string;
      scope?: {
        allowedActions?: string[];
        contractIds?: string[];
      };
      ttlSeconds?: number;
    } | undefined;

    if (!body?.principalAgentId) {
      return reply.status(400).send({
        error: "principalAgentId is required",
      });
    }

    const invalidScope = scopeProblem(body.scope);
    if (invalidScope) {
      return reply.status(400).send({
        error: "invalid_scope",
        message: invalidScope,
      });
    }

    try {
      // Generate a mock principal keypair for the authenticated user.
      // In production, the principal's private key would come from the
      // agent's identity wallet. For now, we derive a deterministic
      // keypair from the principalAgentId so session keys are testable.
      const seed = new TextEncoder().encode(
        body.principalAgentId.padEnd(32, "\0").slice(0, 32),
      );
      const principalKeypair = nacl.sign.keyPair.fromSeed(seed);

      // Derive a deterministic mock wallet address from the principalAgentId
      const mockAddress = `0x${Buffer.from(body.principalAgentId.padEnd(20, "\0").slice(0, 20)).toString("hex")}` as `0x${string}`;
      const agentId = `eip155:84532:${mockAddress}` as const;

      const principal: PrincipalKey = {
        agentId,
        walletAddress: mockAddress,
        publicKey: principalKeypair.publicKey,
      };

      const { sessionKey, sessionPrivateKey } = sessionKeyService.issueSessionKey({
        principal,
        principalPrivateKey: principalKeypair.secretKey,
        scope: body.scope
          ? {
              allowedActions: (body.scope.allowedActions ?? [
                "evidence_submit",
                "workflow_step_complete",
              ]) as SessionAction[],
              contractIds: body.scope.contractIds ?? [],
              maxSignatures: 1000,
            }
          : undefined,
        ttlSeconds: body.ttlSeconds,
      });

      return {
        sessionKey: {
          sessionId: sessionKey.sessionId,
          parentAgentId: sessionKey.parentAgentId,
          publicKey: toHex(sessionKey.publicKey),
          issuedAt: sessionKey.issuedAt,
          expiresAt: sessionKey.expiresAt,
          scope: sessionKey.scope,
          parentSignature: toHex(sessionKey.parentSignature),
        },
        sessionPrivateKey: toHex(sessionPrivateKey),
        warning: "Save the sessionPrivateKey now -- it will NOT be returned again.",
      };
    } catch (err) {
      return reply.status(500).send({
        error: "session_key_issuance_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/identity/session/verify
   *
   * Verify a SessionSignedEvent.
   *
   * Body: {
   *   event: {
   *     eventData: hex,
   *     sessionSignature: hex,
   *     proof: {
   *       sessionKey: { ... (with hex publicKey and parentSignature) },
   *       parentPublicKey: hex
   *     }
   *   },
   *   action: string
   * }
   *
   * Returns: { valid: boolean, failures: string[], principalAgentId?: string }
   */
  app.post("/api/identity/session/verify", async (req, reply) => {
    const body = req.body as {
      event: {
        eventData: string;
        sessionSignature: string;
        proof: {
          sessionKey: {
            sessionId: string;
            parentAgentId: string;
            publicKey: string;
            issuedAt: number;
            expiresAt: number;
            scope: {
              allowedActions: string[];
              contractIds: string[];
              maxSignatures: number;
            };
            parentSignature: string;
          };
          parentPublicKey: string;
          derivationPath?: string;
        };
      };
      action: string;
    } | undefined;

    if (!body?.event || !body?.action) {
      return reply.status(400).send({
        error: "event and action are required",
      });
    }

    try {
      // Reconstruct the SessionSignedEvent from hex-encoded fields
      const event: SessionSignedEvent = {
        eventData: fromHex(body.event.eventData),
        sessionSignature: fromHex(body.event.sessionSignature),
        proof: {
          sessionKey: {
            sessionId: body.event.proof.sessionKey.sessionId,
            parentAgentId: body.event.proof.sessionKey.parentAgentId as `eip155:${number}:0x${string}`,
            publicKey: fromHex(body.event.proof.sessionKey.publicKey),
            issuedAt: body.event.proof.sessionKey.issuedAt,
            expiresAt: body.event.proof.sessionKey.expiresAt,
            scope: body.event.proof.sessionKey.scope as any,
            parentSignature: fromHex(body.event.proof.sessionKey.parentSignature),
          },
          parentPublicKey: fromHex(body.event.proof.parentPublicKey),
          derivationPath: body.event.proof.derivationPath,
        },
      };

      const result = sessionKeyService.verifySessionSignedEvent({
        event,
        action: body.action,
        revokedSessionIds,
      });

      return result;
    } catch (err) {
      return reply.status(500).send({
        error: "verification_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/identity/session/revoke
   *
   * Revoke a session key.
   *
   * Body: { sessionId: string, reason?: string }
   *
   * Returns: { revoked: true, sessionId: string }
   *
   * In production, the revocation would require the principal's signature.
   * For the gateway API, we accept authenticated requests and add the
   * session ID to the revocation set.
   */
  app.post("/api/identity/session/revoke", async (req, reply) => {
    const body = req.body as {
      sessionId: string;
      reason?: string;
    } | undefined;

    if (!body?.sessionId) {
      return reply.status(400).send({
        error: "sessionId is required",
      });
    }

    revokedSessionIds.add(body.sessionId);

    return {
      revoked: true,
      sessionId: body.sessionId,
      reason: body.reason ?? "Revoked via gateway API",
      revokedAt: Math.floor(Date.now() / 1000),
    };
  });
}
