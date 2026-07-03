/**
 * Option B ERC-4337 smart-wallet + passkey backend.
 *
 * Phase A (this file): real WebAuthn attestation verification via
 * @simplewebauthn/server, durable challenge storage (passkey_sessions
 * table), and persistence of the verified credential to api_keys.
 *
 * Phase B (follow-up PR): ERC-4337 mint via ZeroDev Kernel + passkey
 * validator. This file will stay unchanged; the smart-wallet mint
 * happens in a separate service triggered by successful passkey verify.
 *
 * Endpoints:
 *   POST /api/onboard/passkey/register-challenge — returns a WebAuthn
 *        challenge (32 random bytes as base64url) + rpId + a session id.
 *        Persisted to passkey_sessions with 60s expiry.
 *   POST /api/onboard/passkey/verify-attestation — verifies the browser's
 *        AuthenticatorAttestationResponse via @simplewebauthn/server:
 *        challenge match, origin match, rpIdHash match, signature check,
 *        attestation statement validation. On success, persists the
 *        credential (credentialId + publicKey + rpId) to the api_keys row
 *        keyed by the operatorId supplied at challenge time.
 *
 * See `ai/research/option-b-smart-wallet-passkey-plan.md` for the full
 * migration story (A -> B via setAgentWallet from the new smart wallet).
 * See coord bulletins 235 (strategic) + 254 (readiness).
 *
 * Feature flag: PCC_PASSKEY_ENABLED=true opts in. Absent = endpoints
 * return 503. Default off so a mis-deploy can't accidentally accept
 * garbage attestations if the SDK ever regresses.
 */

import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
// v10's exports `RegistrationResponseJSON` transitively via @simplewebauthn/types.
// Keep the endpoint typed loosely to avoid a new dep on types; the SDK validates
// the shape at runtime.
type RegistrationResponseJSON = Parameters<typeof verifyRegistrationResponse>[0]["response"];
import { getRepos } from "../db.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

/**
 * Allowlist of PCC-known rpId + origin values. Client-supplied values must
 * exactly match one of these to be honored (defense-in-depth against
 * finding vet_20260701_171212_gateway Low-2). Env-configured for staging /
 * dev overrides.
 */
function rpIdAllowlist(): string[] {
  const extra = process.env.PCC_PASSKEY_RP_ID_ALLOWLIST;
  const base = ["capability.network", "localhost"];
  if (!extra) return base;
  return [...base, ...extra.split(",").map((s) => s.trim()).filter(Boolean)];
}

function expectedOriginAllowlist(): string[] {
  const extra = process.env.PCC_PASSKEY_ORIGIN_ALLOWLIST;
  const base = [
    "https://capability.network",
    "http://localhost:3000",
    "http://localhost:5173",
  ];
  if (!extra) return base;
  return [...base, ...extra.split(",").map((s) => s.trim()).filter(Boolean)];
}

// -- Config -----------------------------------------------------------

const CHALLENGE_TTL_MS = 60_000;
const RATE_MAX_PER_IP_PER_HOUR = 30;
const RATE_WINDOW_MS = 60 * 60_000;

function isPasskeyEnabled(): boolean {
  return process.env.PCC_PASSKEY_ENABLED === "true";
}

function resolveRpId(fromBody: string | undefined, hostname: string): string {
  const explicit = fromBody ?? process.env.PCC_PASSKEY_RP_ID;
  if (explicit && /^[a-zA-Z0-9.-]+$/.test(explicit)) {
    // Defense-in-depth: even after regex sanity, must be on the allowlist.
    // Browser-side WebAuthn already refuses cross-domain credentials, but a
    // server-side allowlist blocks the "fake rpId in stored session" angle.
    if (rpIdAllowlist().includes(explicit)) return explicit;
  }
  return hostname.replace(/:\d+$/, "");
}

function resolveExpectedOrigin(fromBody: string | undefined, req: {
  protocol: string;
  hostname: string;
}): string {
  const explicit = fromBody ?? process.env.PCC_PASSKEY_EXPECTED_ORIGIN;
  if (explicit && /^https?:\/\//.test(explicit)) {
    if (expectedOriginAllowlist().includes(explicit)) return explicit;
  }
  return `${req.protocol}://${req.hostname}`;
}

// -- Per-IP rate limit (in-memory sliding window; mirrors canProvision) ----

const ipHits = new Map<string, number[]>();

function canRequest(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_PER_IP_PER_HOUR) {
    ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return true;
}

/** Test hook -- flush all rate-limit state between tests. */
export function _resetPasskeyRateForTests(): void {
  ipHits.clear();
}

// -- Types ------------------------------------------------------------

interface RegisterChallengeBody {
  operatorId?: string;
  rpId?: string;
  expectedOrigin?: string;
}

interface VerifyAttestationBody {
  sessionId: string;
  attestationResponse: RegistrationResponseJSON;
}

// -- Routes -----------------------------------------------------------

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/onboard/passkey/register-challenge
  app.post<{ Body: RegisterChallengeBody }>(
    "/api/onboard/passkey/register-challenge",
    async (req, reply) => {
      if (!isPasskeyEnabled()) {
        return reply.status(503).send({
          error: "passkey_not_enabled",
          message: "Passkey onboarding is not enabled. Set PCC_PASSKEY_ENABLED=true.",
        });
      }
      if (!canRequest(req.ip)) {
        return reply.status(429).send({
          error: "rate_limited",
          message: `Too many passkey requests. Try again in an hour (max ${RATE_MAX_PER_IP_PER_HOUR}/hour).`,
        });
      }

      const body = req.body ?? {};
      const now = Date.now();
      const sessionId = randomBytes(16).toString("hex");
      const challenge = randomBytes(32).toString("base64url");
      const rpId = resolveRpId(body.rpId, req.hostname);
      const expectedOrigin = resolveExpectedOrigin(body.expectedOrigin, req);

      // ── Auth check on operatorId binding (vet finding High-1) ───────
      // A body-supplied operatorId is ONLY honored when the request also
      // carries a valid Bearer API key belonging to that operator. Without
      // this, an unauthenticated caller could bind their own credential to
      // any existing operator's api_keys row via the verify-attestation
      // persistence step. Anonymous callers can still get a challenge —
      // it just isn't bound to any operator, and verify-attestation will
      // return { persisted: false }.
      let resolvedOperatorId: string | undefined;
      if (typeof body.operatorId === "string" && body.operatorId.length > 0) {
        const keyRecord = resolveApiKey(req);
        if (!keyRecord) {
          return reply.status(401).send({
            error: "authentication_required_to_bind_operator",
            message:
              "Supplying operatorId in the challenge request requires a valid Bearer API key. " +
              "Omit operatorId for an anonymous challenge (verify will succeed but not persist).",
          });
        }
        if (keyRecord.operatorId !== body.operatorId) {
          return reply.status(403).send({
            error: "operator_mismatch",
            message:
              "The Bearer API key does not belong to the requested operatorId.",
          });
        }
        resolvedOperatorId = keyRecord.operatorId;
      }

      try {
        const repos = getRepos();
        repos.passkeySessions.sweepExpired(now);
        repos.passkeySessions.insert({
          sessionId,
          challenge,
          rpId,
          expectedOrigin,
          operatorId: resolvedOperatorId,
          createdAt: now,
          expiresAt: now + CHALLENGE_TTL_MS,
        });
      } catch (err) {
        req.log?.error(err, "passkey session insert failed");
        return reply.status(500).send({
          error: "session_insert_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      return reply.status(201).send({
        sessionId,
        challenge,
        rpId,
        ttl_ms: CHALLENGE_TTL_MS,
        rpName: "Physical Capability Cloud",
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          userVerification: "preferred",
          residentKey: "preferred",
        },
        timeout_ms: CHALLENGE_TTL_MS,
      });
    },
  );

  // POST /api/onboard/passkey/verify-attestation
  app.post<{ Body: VerifyAttestationBody }>(
    "/api/onboard/passkey/verify-attestation",
    async (req, reply) => {
      if (!isPasskeyEnabled()) {
        return reply.status(503).send({
          error: "passkey_not_enabled",
          message: "Passkey onboarding is not enabled.",
        });
      }
      if (!canRequest(req.ip)) {
        return reply.status(429).send({
          error: "rate_limited",
          message: `Too many passkey requests. Try again in an hour.`,
        });
      }

      const body = req.body ?? ({} as VerifyAttestationBody);
      const now = Date.now();

      if (typeof body.sessionId !== "string" || !body.sessionId) {
        return reply.status(400).send({ error: "sessionId required" });
      }
      if (!body.attestationResponse || typeof body.attestationResponse !== "object") {
        return reply.status(400).send({
          error: "attestationResponse required",
          message:
            "Provide the browser's PublicKeyCredential.toJSON() output as attestationResponse.",
        });
      }

      const repos = getRepos();
      const stored = repos.passkeySessions.findById(body.sessionId);
      if (!stored) {
        return reply.status(404).send({
          error: "session_not_found_or_expired",
          message: "The passkey registration session is unknown or expired. Request a new challenge.",
        });
      }
      if (now > stored.expiresAt) {
        repos.passkeySessions.delete(body.sessionId);
        return reply.status(410).send({
          error: "session_expired",
          message: "Passkey challenge expired. Request a new one.",
        });
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.attestationResponse,
          expectedChallenge: stored.challenge,
          expectedOrigin: stored.expectedOrigin,
          expectedRPID: stored.rpId,
          requireUserVerification: false,
        });
      } catch (err) {
        repos.passkeySessions.delete(body.sessionId);
        return reply.status(400).send({
          error: "webauthn_verify_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (!verification.verified || !verification.registrationInfo) {
        repos.passkeySessions.delete(body.sessionId);
        return reply.status(400).send({
          error: "webauthn_verify_rejected",
          message: "Attestation did not verify. No credential was persisted.",
        });
      }

      // v10 nests as { registrationInfo: { credentialID, credentialPublicKey, ... } }
      const info = verification.registrationInfo as unknown as {
        credentialID: string;
        credentialPublicKey: Uint8Array;
      };
      const credentialIdB64u = info.credentialID;
      const publicKeyB64u = Buffer.from(info.credentialPublicKey).toString("base64url");

      // Persist to api_keys row when operatorId was bound at challenge time.
      let persisted = false;
      if (stored.operatorId) {
        try {
          const keys = repos.apiKeys.findByOperator(stored.operatorId);
          const key = keys[0];
          if (key) {
            repos.apiKeys.setPasskeyCredential(key.id, {
              credentialId: credentialIdB64u,
              publicKey: publicKeyB64u,
              rpId: stored.rpId,
            });
            persisted = true;
          }
        } catch (err) {
          req.log?.warn(err, "passkey credential persist failed");
        }
      }

      // Consume the challenge (one-shot).
      repos.passkeySessions.delete(body.sessionId);

      return reply.status(200).send({
        sessionId: body.sessionId,
        credentialId: credentialIdB64u,
        publicKey: publicKeyB64u,
        rpId: stored.rpId,
        persisted,
        verification: "verified",
      });
    },
  );
}
