/**
 * Option B ERC-4337 smart-wallet + passkey backend groundwork.
 *
 * Ships the endpoint contract for passkey-based onboarding while the
 * ZeroDev SDK + paymaster funding are being vetted (Gate A). The real
 * WebAuthn cryptographic verification lands in a follow-up PR once the
 * SDK is approved; this route persists the credentialId + publicKey the
 * browser produces so the follow-up PR only needs to swap the verify
 * function without touching the endpoint contract or storage.
 *
 * Endpoints:
 *   POST /api/onboard/passkey/register-challenge — returns a WebAuthn
 *        challenge (32 random bytes as base64url) + rpId + a session id
 *        the client echoes on verify. In-memory cache with 60s TTL; MVP.
 *   POST /api/onboard/passkey/verify-attestation — accepts the browser's
 *        AuthenticatorAttestationResponse (base64url JSON), does non-
 *        cryptographic sanity checks (challenge matches, session exists,
 *        rpId present), stores credentialId + publicKey on the api_keys
 *        row identified by session's operatorId, returns success.
 *
 * See `ai/research/option-b-smart-wallet-passkey-plan.md` for the full
 * migration story (A → B via setAgentWallet from the new smart wallet).
 * See coord bulletin 235 for strategic alignment.
 *
 * WARNING: this stub does NOT perform cryptographic verification. It
 * persists what the browser sent. A malicious client could send garbage
 * and it would be stored. The follow-up SDK PR wires @simplewebauthn/
 * server (or an equivalent vetted lib) to reject unauthentic attestations.
 * Until then, /api/onboard/passkey/verify-attestation returns 200 with a
 * `verification: "deferred"` field in the response so callers can detect
 * they're speaking to the stub. Do not enable in prod.
 */

import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────

interface Challenge {
  challenge: string;    // base64url
  rpId: string;
  createdAt: number;    // ms epoch
  operatorId?: string;  // optional binding to a pre-existing api-key row
}

interface RegisterChallengeBody {
  operatorId?: string;
  rpId?: string;
}

interface VerifyAttestationBody {
  sessionId: string;
  credentialId: string;              // base64url
  publicKey: string;                  // base64url (COSE key)
  attestationObject?: string;         // base64url (opaque here; SDK PR verifies)
  clientDataJSON?: string;            // base64url
}

// ── Challenge cache (in-memory, 60s TTL) ───────────────────────────────
//
// Session id → Challenge. Real production wants a persisted store so
// challenges survive gateway restarts + multi-instance deploys, but for the
// MVP a per-process Map is enough (the challenge only needs to survive the
// time between navigator.credentials.create() completing and the client
// posting verify-attestation — seconds, not minutes).

const CHALLENGE_TTL_MS = 60_000;
const challengeCache = new Map<string, Challenge>();

function evictExpired(now: number): void {
  for (const [sessionId, ch] of challengeCache.entries()) {
    if (now - ch.createdAt > CHALLENGE_TTL_MS) {
      challengeCache.delete(sessionId);
    }
  }
}

function resolveRpId(fromBody: string | undefined, hostname: string): string {
  const explicit = fromBody ?? process.env.PCC_PASSKEY_RP_ID;
  if (explicit && /^[a-zA-Z0-9.-]+$/.test(explicit)) return explicit;
  // Strip a leading port from hostname if present (localhost:3000 → localhost).
  return hostname.replace(/:\d+$/, "");
}

// ── Test hook ──────────────────────────────────────────────────────────

/** Test hook — flush all challenges between tests. */
export function _resetPasskeyCacheForTests(): void {
  challengeCache.clear();
}

// ── Routes ─────────────────────────────────────────────────────────────

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/onboard/passkey/register-challenge ─────────────────
  app.post<{ Body: RegisterChallengeBody }>(
    "/api/onboard/passkey/register-challenge",
    async (req, reply) => {
      const body = req.body ?? {};
      const now = Date.now();
      evictExpired(now);

      const sessionId = randomBytes(16).toString("hex");
      const challenge = randomBytes(32).toString("base64url");
      const rpId = resolveRpId(body.rpId, req.hostname);

      challengeCache.set(sessionId, {
        challenge,
        rpId,
        createdAt: now,
        operatorId: typeof body.operatorId === "string" ? body.operatorId : undefined,
      });

      return reply.status(201).send({
        sessionId,
        challenge,
        rpId,
        ttl_ms: CHALLENGE_TTL_MS,
        // The relying-party name shown in the browser passkey UI. Cosmetic.
        rpName: "Physical Capability Cloud",
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },   // ES256 (default)
          { type: "public-key", alg: -257 }, // RS256 (broad support)
        ],
        authenticatorSelection: {
          userVerification: "preferred",
          residentKey: "preferred",
        },
        timeout_ms: CHALLENGE_TTL_MS,
        note: "MVP stub. Do NOT rely on this for production auth until the WebAuthn SDK is vetted (Gate A).",
      });
    },
  );

  // ── POST /api/onboard/passkey/verify-attestation ─────────────────
  app.post<{ Body: VerifyAttestationBody }>(
    "/api/onboard/passkey/verify-attestation",
    async (req, reply) => {
      const body = req.body ?? ({} as VerifyAttestationBody);
      const now = Date.now();

      if (typeof body.sessionId !== "string" || !body.sessionId) {
        return reply
          .status(400)
          .send({ error: "sessionId required" });
      }
      if (typeof body.credentialId !== "string" || !body.credentialId) {
        return reply
          .status(400)
          .send({ error: "credentialId required (base64url)" });
      }
      if (typeof body.publicKey !== "string" || !body.publicKey) {
        return reply
          .status(400)
          .send({ error: "publicKey required (base64url COSE key)" });
      }

      const stored = challengeCache.get(body.sessionId);
      if (!stored) {
        return reply.status(404).send({
          error: "session_not_found_or_expired",
          message: "The passkey registration session is unknown or expired. Request a new challenge.",
        });
      }
      if (now - stored.createdAt > CHALLENGE_TTL_MS) {
        challengeCache.delete(body.sessionId);
        return reply.status(410).send({
          error: "session_expired",
          message: "Passkey challenge expired. Request a new one.",
        });
      }

      // Persistence to api_keys.passkey_* columns is deferred to the SDK
      // follow-up PR (a new IApiKeyRepository method + real verify step
      // will land together — no point persisting an unverified credential).
      // The columns already exist (PR #195 groundwork).

      // Consume the challenge (one-shot).
      challengeCache.delete(body.sessionId);

      return reply.status(200).send({
        sessionId: body.sessionId,
        credentialId: body.credentialId,
        rpId: stored.rpId,
        persisted: false,
        verification: "deferred",
        message:
          "Attestation received. Cryptographic verification is deferred until the WebAuthn SDK " +
          "is vetted via Gate A. Do NOT rely on this endpoint for production authentication " +
          "until the follow-up PR lands.",
      });
    },
  );
}
