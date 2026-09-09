/**
 * SIWE (Sign-In with Ethereum) authentication plugin for Fastify.
 *
 * Flow:
 *   1. GET  /api/auth/nonce   -> returns a random nonce
 *   2. POST /api/auth/verify  -> validates EIP-4361 signature, creates session
 *   3. GET  /api/auth/me      -> returns current session (cookie or bearer)
 *   4. POST /api/auth/logout  -> destroys session
 *
 * Sessions are stored in SQLite via @pcc/store SessionRepository.
 * Nonces remain in-memory (short-lived, 5min TTL).
 * Supports both HTTP-only cookie and Authorization Bearer token auth.
 * Uses viem for signature verification — no `siwe` package needed.
 *
 * ── KNOWN LIMITATIONS (cross-family review of PR #309) ────────────
 * Reported and deliberately NOT fixed in that PR, because each needs a config
 * or infrastructure decision rather than a code tweak. Recorded here so they
 * are not rediscovered as novel:
 *
 * 1. DOMAIN VALIDATION TRUSTS THE REQUEST HOST. `/verify` compares the SIWE
 *    message's domain against `req.hostname`, which derives from the Host (or
 *    forwarded-host) header. If the ingress does not canonicalize Host, a
 *    signature intended for another relying party could be replayed here.
 *    Correct fix: compare domain AND uri against a CONFIGURED canonical origin,
 *    never a request header — and audit Fastify `trustProxy` alongside it.
 *    Left alone because picking that origin per environment is an operator
 *    decision, and getting it wrong locks everyone out.
 *
 * 2. NONCES AND RATE LIMITS ARE PROCESS-LOCAL. Both live in module-level Maps.
 *    With multiple workers/replicas, a nonce issued by one instance is
 *    unknown to another (spurious failures), and per-IP limits are enforced
 *    once PER INSTANCE (an attacker gets N× the allowance). Correct fix: a
 *    shared TTL store with atomic consume/increment. Same applies to the
 *    one-time-use guarantee on nonce consumption below.
 *
 * 3. NO ERC-1271 / EIP-6492 SUPPORT. Verification uses viem's standalone
 *    `verifyMessage`, which handles EOAs only. Smart-contract wallets are
 *    rejected even when valid. Relevant to settlement: an operator using a
 *    smart account cannot complete SIWE at all today, so such an operator
 *    cannot be granted `settlement` via self-service.
 *
 * 4. NO PER-WALLET OR GLOBAL SESSION CAP. Within the rate limit, an anonymous
 *    caller who controls any wallet can mint 24h session rows continuously.
 *    Bounded but not capped.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import { getRepos } from "../db.js";
import { canSiweVerify, canSiweNonce } from "../middleware/security-hardening.js";

// ---------------------------------------------------------------------------
// In-memory nonce store (ephemeral, no DB persistence needed)
// ---------------------------------------------------------------------------

const nonces = new Map<string, number>(); // nonce -> expiry timestamp

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Hard cap on outstanding nonces. Belt to the rate limiter's braces: that
 * limiter is per-IP and process-local, so a distributed caller could still grow
 * this map without one. A nonce entry is tiny and a real deployment never
 * approaches this number.
 */
const MAX_OUTSTANDING_NONCES = 50_000;

/** Drop expired nonces from memory. Cheap, in-process, touches no DB. */
function sweepNonces(): number {
  const now = Date.now();
  for (const [nonce, expiry] of nonces) {
    if (expiry < now) nonces.delete(nonce);
  }
  return nonces.size;
}

/**
 * Remove expired sessions (DB) and nonces (in-memory).
 *
 * NO LONGER called from the public nonce path. It used to be — which meant
 * GET /api/auth/nonce, necessarily unauthenticated, did a full map scan AND
 * issued a SQLite DELETE on every single call: an unauthenticated
 * amplification path. Flagged by cross-family review of PR #309, which is the
 * PR that made that route public. Session cleanup now runs on a timer.
 */
function cleanExpired() {
  sweepNonces();
  getRepos().sessions.deleteExpired(new Date().toISOString());
}

// Scheduled sweep, replacing the per-request cleanup. `unref` so an idle timer
// never holds the process (or a test runner) open. Mirrors the interval sweeps
// in middleware/security-hardening.ts.
const sessionSweep = setInterval(() => {
  try {
    cleanExpired();
  } catch {
    // DB not ready or shutting down. A missed sweep is harmless — the next one
    // collects the same rows — and must never take the process down.
  }
}, 5 * 60 * 1000);
(sessionSweep as unknown as { unref?: () => void }).unref?.();

// ---------------------------------------------------------------------------
// Minimal SIWE message parser (EIP-4361)
// ---------------------------------------------------------------------------

interface ParsedSiweMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  resources?: string[];
}

/**
 * Parse an EIP-4361 SIWE message string into structured fields.
 * This is a minimal parser — handles the standard format without
 * requiring the full `siwe` npm package.
 *
 * EIP-4361 format:
 *   ${domain} wants you to sign in with your Ethereum account:
 *   ${address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: ${version}
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   [Expiration Time: ${expirationTime}]
 *   [Resources:
 *   - ${resource1}
 *   - ${resource2}]
 */
function parseSiweMessage(message: string): ParsedSiweMessage | null {
  // Line 1: "<domain> wants you to sign in with your Ethereum account:"
  const domainMatch = message.match(
    /^(.+?) wants you to sign in with your Ethereum account:\n(0x[a-fA-F0-9]{40})/,
  );
  if (!domainMatch) return null;

  const domain = domainMatch[1];
  const address = domainMatch[2];

  // Extract fields from the structured part
  const fieldExtract = (label: string): string | undefined => {
    const re = new RegExp(`${label}: (.+)`, "m");
    const m = message.match(re);
    return m?.[1]?.trim();
  };

  const uri = fieldExtract("URI");
  const version = fieldExtract("Version");
  const chainIdStr = fieldExtract("Chain ID");
  const nonce = fieldExtract("Nonce");
  const issuedAt = fieldExtract("Issued At");

  if (!uri || !version || !chainIdStr || !nonce || !issuedAt) return null;

  // Strict: parseInt("1abc") is 1, so a partially-numeric chain id used to be
  // silently accepted. An EIP-4361 Chain ID is an integer, nothing else.
  if (!/^\d+$/.test(chainIdStr)) return null;
  const chainId = parseInt(chainIdStr, 10);
  if (!Number.isSafeInteger(chainId)) return null;

  // Optional: statement (between address line and "URI:" line)
  const afterAddress = message.indexOf(address) + address.length;
  const uriPos = message.indexOf("\nURI:");
  let statement: string | undefined;
  if (uriPos > afterAddress) {
    const block = message.slice(afterAddress, uriPos).trim();
    if (block.length > 0) {
      statement = block;
    }
  }

  // Optional fields
  const expirationTime = fieldExtract("Expiration Time");

  // Resources
  let resources: string[] | undefined;
  const resourcesIdx = message.indexOf("Resources:");
  if (resourcesIdx !== -1) {
    const resourceBlock = message.slice(resourcesIdx + "Resources:".length);
    resources = resourceBlock
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
  }

  return {
    domain,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    resources,
  };
}

// ---------------------------------------------------------------------------
// Session helpers (exported for use by require-auth and other modules)
// ---------------------------------------------------------------------------

/**
 * Resolve a session from the request.
 * Checks both cookie (`pcc_session`) and Authorization Bearer header.
 * Returns the session address or null.
 */
export function resolveSession(
  req: FastifyRequest,
): { address: `0x${string}`; token: string } | null {
  const repo = getRepos().sessions;

  // 1. Try cookie — verify HMAC signature to detect tampering (red team #52)
  const rawCookie = req.cookies?.pcc_session;
  if (rawCookie) {
    let cookieToken: string | null = null;
    try {
      // unsignCookie returns { valid, value, renew } when the cookie was signed.
      // Falls back to raw token if cookies are unsigned (backward compat for
      // sessions issued before signing was wired).
      const unsigned = (req as any).unsignCookie?.(rawCookie);
      if (unsigned && typeof unsigned === "object") {
        if (unsigned.valid) {
          cookieToken = unsigned.value;
        } else {
          // Tampered cookie — log and reject
          // Also pass through if the value happens to match a known token
          // (covers the rollout window where old unsigned cookies still exist)
          cookieToken = null;
        }
      } else {
        cookieToken = rawCookie;
      }
    } catch {
      // If unsignCookie throws (malformed), reject rather than falling through
      // to the raw value (R5 NEW-07 cookie HMAC bypass fix)
      cookieToken = null;
    }

    if (cookieToken) {
      const session = repo.findByToken(cookieToken);
      if (session && new Date(session.expiresAt).getTime() > Date.now()) {
        return { address: session.walletAddress as `0x${string}`, token: cookieToken };
      }
      if (session) repo.deleteByToken(cookieToken);
    }
  }

  // 2. Try Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7);
    const session = repo.findByToken(bearerToken);
    if (session && new Date(session.expiresAt).getTime() > Date.now()) {
      return { address: session.walletAddress as `0x${string}`, token: bearerToken };
    }
    if (session) repo.deleteByToken(bearerToken);
  }

  return null;
}

/**
 * Get active session count (for debug endpoints).
 */
export function getSessionCount(): number {
  cleanExpired();
  return getRepos().sessions.countActive();
}

/**
 * List active sessions (for debug endpoints).
 */
export function listSessions(): Array<{
  address: string;
  createdAt: string;
  expiresAt: string;
}> {
  cleanExpired();
  const rows = getRepos().sessions.listActive(new Date().toISOString());
  return rows.map((s) => ({
    address: s.walletAddress,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
  }));
}

// ---------------------------------------------------------------------------
// Fastify Plugin
// ---------------------------------------------------------------------------

export async function siweAuthPlugin(app: FastifyInstance) {
  // ----- GET /api/auth/nonce -----
  // PUBLIC by necessity: this is how a caller with no credential bootstraps
  // one. Public must not mean unbounded — see canSiweNonce and the nonce cap.
  app.get("/api/auth/nonce", async (req, reply) => {
    if (!canSiweNonce(req.ip)) {
      return reply.status(429).send({
        error: "rate_limited",
        message: "Too many nonce requests. Try again in a minute.",
      });
    }
    // In-memory sweep only. Session/DB cleanup runs on the timer above, NOT on
    // this unauthenticated request path. And only SCAN when actually at capacity:
    // sweeping on every nonce request was an O(n) map scan per call, O(n²) under a
    // fill-flood (finding M5). The timer sweep handles the steady state; this
    // lazy check pays the scan only at the boundary.
    if (nonces.size >= MAX_OUTSTANDING_NONCES && sweepNonces() >= MAX_OUTSTANDING_NONCES) {
      return reply.status(503).send({
        error: "nonce_capacity",
        message: "Too many outstanding sign-in nonces. Try again shortly.",
      });
    }
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    return reply.send({ nonce });
  });

  // ----- POST /api/auth/verify -----
  app.post("/api/auth/verify", async (req, reply) => {
    // Rate limit SIWE verify to prevent signature replay flooding (red team #27)
    if (!canSiweVerify(req.ip)) {
      return reply.status(429).send({
        error: "rate_limited",
        message: "Too many verification attempts. Try again in a minute.",
      });
    }

    const body = (req.body ?? {}) as {
      message?: string;
      signature?: string;
    };

    if (!body.message || !body.signature) {
      return reply
        .status(400)
        .send({ error: "Missing message or signature" });
    }

    // Parse the SIWE message
    const parsed = parseSiweMessage(body.message);
    if (!parsed) {
      return reply
        .status(400)
        .send({ error: "Invalid SIWE message format" });
    }

    // Validate domain matches this server (prevents cross-site SIWE replay attacks)
    const expectedHost = req.hostname;
    if (parsed.domain !== expectedHost) {
      return reply.status(401).send({
        error: "Domain mismatch",
        message: `SIWE message domain '${parsed.domain}' does not match server '${expectedHost}'`,
      });
    }

    // Validate issuedAt freshness. These checks FAIL CLOSED: an unparseable
    // timestamp used to slip through the `!isNaN` guard, and a FUTURE-dated
    // message was never rejected at all, so a signature could be minted now and
    // held. (Cross-family review of PR #309.) A small forward skew is allowed
    // for honest clock drift.
    const ISSUED_MAX_AGE_MS = 5 * 60 * 1000;
    const ISSUED_MAX_SKEW_MS = 60 * 1000;
    if (parsed.issuedAt) {
      const issuedMs = new Date(parsed.issuedAt).getTime();
      if (isNaN(issuedMs)) {
        return reply.status(401).send({ error: "SIWE Issued At is not a valid timestamp" });
      }
      const age = Date.now() - issuedMs;
      if (age > ISSUED_MAX_AGE_MS) {
        return reply.status(401).send({ error: "SIWE message too old (>5 minutes)" });
      }
      if (age < -ISSUED_MAX_SKEW_MS) {
        return reply.status(401).send({ error: "SIWE message is dated in the future" });
      }
    }

    // Validate nonce
    const nonceExpiry = nonces.get(parsed.nonce);
    if (!nonceExpiry || nonceExpiry < Date.now()) {
      return reply.status(401).send({ error: "Nonce expired or invalid" });
    }

    // Validate expiration time if present. FAILS CLOSED: an unparseable
    // Expiration Time previously passed the `!isNaN` guard, so a message
    // claiming to expire could carry garbage and be accepted forever.
    if (parsed.expirationTime) {
      const expires = new Date(parsed.expirationTime).getTime();
      if (isNaN(expires)) {
        return reply.status(401).send({ error: "SIWE Expiration Time is not a valid timestamp" });
      }
      if (expires < Date.now()) {
        return reply.status(401).send({ error: "SIWE message expired" });
      }
    }

    // Verify signature using viem
    try {
      const valid = await verifyMessage({
        address: parsed.address as `0x${string}`,
        message: body.message,
        signature: body.signature as `0x${string}`,
      });

      if (!valid) {
        return reply.status(401).send({ error: "Invalid signature" });
      }
    } catch {
      return reply
        .status(401)
        .send({ error: "Signature verification failed" });
    }

    // Consume nonce (one-time use) — ATOMICALLY.
    //
    // The check above happens BEFORE `await verifyMessage`, so two concurrent
    // requests carrying the same signed message both passed it, both verified,
    // and both minted a session: one signature, N sessions. Map mutation is
    // synchronous within a tick, so `delete` returning false means another
    // request already consumed this nonce — that request wins, this one is a
    // replay. (Cross-family review of PR #309. This is process-local, like the
    // store itself; a multi-replica deployment needs a shared atomic store —
    // see the note in the plugin docblock.)
    if (!nonces.delete(parsed.nonce)) {
      return reply.status(401).send({ error: "Nonce already used" });
    }

    // Create session
    const token = randomUUID();
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    getRepos().sessions.insert({
      id: randomUUID(),
      walletAddress: parsed.address,
      token,
      createdAt,
      expiresAt,
      lastActiveAt: createdAt,
    });

    // Set HTTP-only HMAC-signed cookie (red team #52 fix — actually wired now)
    return reply
      .setCookie("pcc_session", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 24 * 60 * 60, // 24 hours in seconds
        signed: true,
      })
      .send({
        token,
        address: parsed.address,
        expiresAt,
      });
  });

  // ----- GET /api/auth/me -----
  app.get("/api/auth/me", async (req, reply) => {
    const session = resolveSession(req);
    if (!session) {
      return reply.status(401).send({ error: "Not authenticated" });
    }
    return reply.send({ address: session.address });
  });

  // ----- POST /api/auth/logout -----
  app.post("/api/auth/logout", async (req, reply) => {
    const repo = getRepos().sessions;

    // Clear cookie-based session — verify signature before deletion
    const rawCookie = req.cookies?.pcc_session;
    if (rawCookie) {
      let cookieToken: string | null = null;
      try {
        const unsigned = (req as any).unsignCookie?.(rawCookie);
        if (unsigned && typeof unsigned === "object") {
          cookieToken = unsigned.valid ? unsigned.value : null;
        } else {
          cookieToken = rawCookie;
        }
      } catch {
        cookieToken = rawCookie;
      }
      if (cookieToken) repo.deleteByToken(cookieToken);
    }

    // Clear bearer-based session
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      repo.deleteByToken(authHeader.slice(7));
    }

    return reply.clearCookie("pcc_session", { path: "/" }).send({ ok: true });
  });

  // ----- GET /api/auth/sessions (scoped to caller only) -----
  // Only returns the caller's own sessions, not all sessions globally.
  app.get("/api/auth/sessions", async (req, reply) => {
    const { resolveApiKey } = await import("./api-key-auth.js");
    const keyRecord = resolveApiKey(req);
    const session = resolveSession(req);
    if (!keyRecord && !session) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    // Only show the caller's own session (not global list)
    const callerAddress = session?.address ?? keyRecord?.operatorId;
    if (callerAddress) {
      const allSessions = listSessions();
      const mySessions = allSessions.filter(
        (s: any) => s.walletAddress === callerAddress || s.address === callerAddress,
      );
      return { count: mySessions.length, sessions: mySessions };
    }

    return { count: 0, sessions: [] };
  });
}
