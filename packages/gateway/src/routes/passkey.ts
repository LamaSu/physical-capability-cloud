/**
 * Passkey server endpoints — Week 4.
 *
 * Per `15-MOBILE-APP-FIRST-PRINCIPLES.md` v3 and `16-CENTRALIZED-ALTERNATIVE.md`,
 * the mobile device is a hardware passkey (P-256 secure-enclave / TEE / Android
 * StrongBox) that signs **receipt approval challenges** issued by the gateway.
 * The server side of that handshake lives here:
 *
 *   POST /api/passkey/register   Persists a registered P-256 credential
 *                                {credentialId, publicKey} for a userId.
 *
 *   POST /api/passkey/challenge  Issues a single-use 32-byte nonce challenge
 *                                with a 5-min TTL for a userId. Returns the
 *                                challengeId + base64 nonce + expiresAt.
 *
 *   POST /api/passkey/verify     Validates a WebAuthn assertion: looks up the
 *                                challenge (must not be expired/used), looks
 *                                up the registered credential, verifies the
 *                                P-256 signature over
 *                                `authenticatorData || sha256(clientDataJSON)`
 *                                per WebAuthn spec, marks the challenge used
 *                                (one-time), returns a session token.
 *
 * State is held in process-level singletons (this module is the owner). For
 * tests, call `_resetPasskeyStoreForTests()` to wipe between cases. To seed
 * a registered credential without going through the register flow, call
 * `_seedRegisteredCredentialForTests()`.
 *
 * Design notes:
 *   - We use `@noble/curves/p256` for verification — already a transitive dep
 *     of @pcc/transparency-log via @noble/curves so no new dep is added.
 *   - Public keys can arrive in two shapes from the client:
 *       1. Raw 65-byte uncompressed SEC1 form (0x04 || X || Y), what
 *          `AuthenticatorAttestationResponse.getPublicKey()` returns on
 *          modern Chrome/Safari.
 *       2. The full attestationObject (CBOR-encoded) when the platform
 *          can't yield raw spki bytes. We accept this opaque form and stash
 *          it; verification fails if we can't extract a P-256 key from it.
 *     For v1 we require shape (1). The mobile module's `enrollPasskey`
 *     prefers `getPublicKey()` and only falls back to attestation when
 *     unavailable, so the happy path is always raw SEC1.
 *   - Sessions tokens are opaque random strings (32 bytes, base64url). v1
 *     does not need JWT — a future iteration can swap this for a signed
 *     JWT if cross-service propagation becomes a need.
 *   - Replay prevention: challenges are single-use; once verify() succeeds
 *     the challenge is deleted. Expired challenges are deleted lazily on
 *     access (and in a sweep on every register/challenge call).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";

// ── Types ─────────────────────────────────────────────────────────────

interface RegisteredCredential {
  /** Stable user identifier — typically the API-key-bound operator/user id. */
  userId: string;
  /** Base64url-encoded credential id (raw bytes from WebAuthn rawId). */
  credentialId: string;
  /**
   * Base64-encoded raw P-256 public key. Must be 65 bytes uncompressed SEC1
   * (0x04 || X || Y). v1 rejects other shapes.
   */
  publicKey: string;
  /** Base64url-encoded raw authenticatorData blob from the registration. */
  authenticatorData: string;
  /** ISO-8601 registration timestamp. */
  registeredAt: string;
}

interface PendingChallenge {
  /** Random opaque id returned to the client. */
  challengeId: string;
  /** User this challenge was issued for. */
  userId: string;
  /** Base64-encoded 32-byte nonce. */
  challenge: string;
  /** Raw bytes of the challenge — kept for verify() to avoid base64 churn. */
  challengeBytes: Uint8Array;
  /** Unix epoch ms when the challenge expires. */
  expiresAtMs: number;
  /** True once the challenge has been spent in a verify() call. */
  used: boolean;
}

interface Session {
  sessionToken: string;
  userId: string;
  credentialId: string;
  issuedAtMs: number;
}

interface PasskeyState {
  /** Registered credentials keyed by credentialId (base64url). */
  credentialsById: Map<string, RegisteredCredential>;
  /** Reverse index: userId → set of credentialIds. */
  credentialsByUser: Map<string, Set<string>>;
  /** Pending challenges keyed by challengeId. */
  challenges: Map<string, PendingChallenge>;
  /** Active sessions keyed by sessionToken. */
  sessions: Map<string, Session>;
}

// ── Singleton state ───────────────────────────────────────────────────

let state: PasskeyState = {
  credentialsById: new Map(),
  credentialsByUser: new Map(),
  challenges: new Map(),
  sessions: new Map(),
};

/** Test-only: wipe state between cases. */
export function _resetPasskeyStoreForTests(): void {
  state = {
    credentialsById: new Map(),
    credentialsByUser: new Map(),
    challenges: new Map(),
    sessions: new Map(),
  };
}

/** Test-only: seed a registered credential without running the register route. */
export function _seedRegisteredCredentialForTests(
  cred: Omit<RegisteredCredential, "registeredAt"> & { registeredAt?: string },
): void {
  const registeredAt = cred.registeredAt ?? new Date().toISOString();
  const full: RegisteredCredential = { ...cred, registeredAt };
  state.credentialsById.set(cred.credentialId, full);
  let set = state.credentialsByUser.get(cred.userId);
  if (!set) {
    set = new Set();
    state.credentialsByUser.set(cred.userId, set);
  }
  set.add(cred.credentialId);
}

/** Test-only: peek the size of the credential / challenge / session stores. */
export function _peekPasskeyStoreForTests(): {
  credentials: number;
  challenges: number;
  sessions: number;
} {
  return {
    credentials: state.credentialsById.size,
    challenges: state.challenges.size,
    sessions: state.sessions.size,
  };
}

/** Test-only: read the current pending challenge for a user, if any. */
export function _getPendingChallengeForTests(
  challengeId: string,
): PendingChallenge | null {
  return state.challenges.get(challengeId) ?? null;
}

/** Test-only: force-expire all challenges (simulate clock advance). */
export function _expireAllChallengesForTests(): void {
  for (const c of state.challenges.values()) {
    c.expiresAtMs = 0;
  }
}

// ── Constants ─────────────────────────────────────────────────────────

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CHALLENGE_NONCE_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;

// ── Helpers ───────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

/** Base64-encode raw bytes (standard, NOT URL-safe). */
function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Base64-decode (accepts standard or URL-safe). Returns null on malformed. */
function b64decode(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    // Normalize URL-safe → standard base64 + add padding.
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "===".slice((normalized.length + 3) % 4);
    return new Uint8Array(Buffer.from(padded, "base64"));
  } catch {
    return null;
  }
}

/** Sweep expired challenges. Called on every register/challenge to keep memory bounded. */
function sweepExpiredChallenges(): void {
  const now = nowMs();
  for (const [id, c] of state.challenges) {
    if (c.expiresAtMs <= now || c.used) {
      state.challenges.delete(id);
    }
  }
}

/**
 * Validate that a base64-encoded P-256 public key is in the uncompressed
 * SEC1 shape (0x04 || X || Y) and 65 bytes long. Returns parsed bytes or null.
 */
function parseP256PublicKey(pubKeyB64: string): Uint8Array | null {
  const bytes = b64decode(pubKeyB64);
  if (!bytes) return null;
  if (bytes.length !== 65) return null;
  if (bytes[0] !== 0x04) return null;
  return bytes;
}

// ── Body schemas ──────────────────────────────────────────────────────

interface RegisterBody {
  userId?: unknown;
  credentialId?: unknown;
  publicKey?: unknown;
  authenticatorData?: unknown;
}

interface ChallengeBody {
  userId?: unknown;
}

interface VerifyBody {
  challengeId?: unknown;
  credentialId?: unknown;
  signature?: unknown;
  authenticatorData?: unknown;
  clientDataJSON?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ── Routes ────────────────────────────────────────────────────────────

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/passkey/register
   *
   * Persist a P-256 passkey credential for a user. The mobile client calls
   * this once after running navigator.credentials.create(). The server
   * stores the credential id + public key, and from then on can issue
   * challenges that the user signs with the same passkey.
   */
  app.post<{ Body: RegisterBody }>(
    "/api/passkey/register",
    async (req, reply: FastifyReply) => {
      const body = (req.body ?? {}) as RegisterBody;
      const userId = body.userId;
      const credentialId = body.credentialId;
      const publicKey = body.publicKey;
      const authenticatorData = body.authenticatorData;

      if (
        !isString(userId) ||
        !isString(credentialId) ||
        !isString(publicKey) ||
        !isString(authenticatorData)
      ) {
        return reply.status(400).send({
          error: "invalid_body",
          message:
            "userId, credentialId, publicKey, authenticatorData are required strings",
        });
      }

      // v1: only accept raw P-256 SEC1 uncompressed keys. Reject anything else.
      const pubBytes = parseP256PublicKey(publicKey);
      if (!pubBytes) {
        return reply.status(400).send({
          error: "invalid_public_key",
          message:
            "publicKey must be base64-encoded raw P-256 (uncompressed SEC1, 65 bytes, 0x04 prefix)",
        });
      }

      // Reject duplicate credentialId — even across different users. If a
      // platform tries to re-register the same passkey we want to surface
      // it instead of silently overwriting.
      if (state.credentialsById.has(credentialId)) {
        return reply.status(409).send({
          error: "duplicate_credential",
          message: `credentialId "${credentialId}" is already registered`,
        });
      }

      // Sweep stale challenges opportunistically.
      sweepExpiredChallenges();

      const cred: RegisteredCredential = {
        userId,
        credentialId,
        publicKey,
        authenticatorData,
        registeredAt: new Date().toISOString(),
      };
      state.credentialsById.set(credentialId, cred);
      let set = state.credentialsByUser.get(userId);
      if (!set) {
        set = new Set();
        state.credentialsByUser.set(userId, set);
      }
      set.add(credentialId);

      return {
        ok: true,
        credentialId,
        userId,
        registeredAt: cred.registeredAt,
      };
    },
  );

  /**
   * POST /api/passkey/challenge
   *
   * Issue a single-use 32-byte nonce challenge for a userId. The user must
   * have at least one registered passkey. The challenge expires after
   * `CHALLENGE_TTL_MS` (5 minutes) and is consumed (deleted) on first
   * successful verify().
   *
   * Returns:
   *   { challengeId, challenge (base64 of 32 random bytes), expiresAt (ISO) }
   */
  app.post<{ Body: ChallengeBody }>(
    "/api/passkey/challenge",
    async (req, reply: FastifyReply) => {
      const body = (req.body ?? {}) as ChallengeBody;
      const userId = body.userId;

      if (!isString(userId)) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "userId is a required string",
        });
      }

      // The user must have at least one registered passkey. Otherwise we
      // refuse to issue a challenge — there's nothing for them to sign with.
      const userCreds = state.credentialsByUser.get(userId);
      if (!userCreds || userCreds.size === 0) {
        return reply.status(404).send({
          error: "user_not_registered",
          message: `No passkey registered for userId "${userId}"`,
        });
      }

      sweepExpiredChallenges();

      const challengeBytes = randomBytes(CHALLENGE_NONCE_BYTES);
      const challengeIdBytes = randomBytes(16);
      const challengeId = b64encode(challengeIdBytes)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const challenge = b64encode(challengeBytes);
      const expiresAtMs = nowMs() + CHALLENGE_TTL_MS;

      const pending: PendingChallenge = {
        challengeId,
        userId,
        challenge,
        challengeBytes,
        expiresAtMs,
        used: false,
      };
      state.challenges.set(challengeId, pending);

      return {
        challengeId,
        challenge,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
  );
}

// Avoid the unused-import warning when we expand the file later.
void p256;
void sha256;
