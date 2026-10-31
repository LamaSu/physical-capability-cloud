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
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { verifyEvmMessageSignature } from "./evm-signature.js";
import { eq, schema } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import { classifyProvisionError, provisionApiKey } from "./api-key-auth.js";
import { SELF_SERVICE_KEY_SCOPES } from "../middleware/scope-checker.js";
import { canSiweVerify } from "../middleware/security-hardening.js";
import { auditService } from "../services/audit-service.js";
import { walletLinkConfig } from "../services/wallet-links/config.js";

// ---------------------------------------------------------------------------
// In-memory nonce store (ephemeral, no DB persistence needed)
// ---------------------------------------------------------------------------

const nonces = new Map<string, number>(); // nonce -> expiry timestamp

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Remove expired sessions (DB) and nonces (in-memory) */
function cleanExpired() {
  // Clean expired nonces from memory
  const now = Date.now();
  for (const [nonce, expiry] of nonces) {
    if (expiry < now) nonces.delete(nonce);
  }
  // Clean expired sessions from DB
  getRepos().sessions.deleteExpired(new Date().toISOString());
}

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

  const chainId = parseInt(chainIdStr, 10);
  if (isNaN(chainId)) return null;

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

/** End a session and its own keys atomically, preserving keys from other sessions. */
function deleteSessionAndRevokeKeys(token: string) {
  const repos = getRepos();
  getStore().db.transaction(() => {
    const session = repos.sessions.findByToken(token);
    if (!session) return;

    // Minting preserves the stored session address, including its casing.
    for (const key of repos.apiKeys.findByOperator(session.walletAddress)) {
      if (key.revokedAt) continue;
      let metadata;
      try { metadata = JSON.parse(key.metadata ?? "{}"); } catch { continue; }
      if (metadata?.source === "siwe-session" && metadata.sessionId === session.id) {
        repos.apiKeys.revoke(key.id);
      }
    }
    repos.sessions.deleteByToken(token);
  });
}

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
  app.get("/api/auth/nonce", async (_req, reply) => {
    cleanExpired();
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

    // Bind sign-in to the configured deployment, independently of proxy headers.
    let config: ReturnType<typeof walletLinkConfig>;
    try {
      config = walletLinkConfig();
    } catch {
      return reply.status(503).send({ error: "Sign-in unavailable" });
    }
    const { domain: expectedHost, publicOrigin } = config;
    if (parsed.domain !== expectedHost) {
      return reply.status(401).send({
        error: "Domain mismatch",
        message: `SIWE message domain must be '${expectedHost}'`,
      });
    }

    let uriOrigin: string | undefined;
    try {
      uriOrigin = new URL(parsed.uri).origin;
    } catch {
      // An unparseable URI is refused by the same origin check below.
    }
    if (uriOrigin !== publicOrigin) {
      return reply.status(401).send({
        error: "URI mismatch",
        message: `SIWE message URI must be on ${publicOrigin}`,
      });
    }

    // Validate issuedAt freshness (must be within last 5 minutes)
    if (parsed.issuedAt) {
      const issuedMs = new Date(parsed.issuedAt).getTime();
      if (!isNaN(issuedMs) && Date.now() - issuedMs > 5 * 60 * 1000) {
        return reply.status(401).send({ error: "SIWE message too old (>5 minutes)" });
      }
    }

    // Validate nonce
    const nonceExpiry = nonces.get(parsed.nonce);
    if (!nonceExpiry || nonceExpiry < Date.now()) {
      return reply.status(401).send({ error: "Nonce expired or invalid" });
    }
    // Claim synchronously before signature verification can yield to another request.
    nonces.delete(parsed.nonce);

    // Validate expiration time if present
    if (parsed.expirationTime) {
      const expires = new Date(parsed.expirationTime).getTime();
      if (!isNaN(expires) && expires < Date.now()) {
        return reply.status(401).send({ error: "SIWE message expired" });
      }
    }

    // Verify EOA, deployed smart-account and counterfactual smart-account signatures.
    try {
      const check = await verifyEvmMessageSignature({
        address: parsed.address,
        message: body.message,
        signature: body.signature,
        chainId: parsed.chainId,
      });

      if (!check.ok) {
        switch (check.reason) {
          case "malformed":
            return reply.status(400).send({ error: "Invalid signature format" });
          case "invalid":
            return reply.status(401).send({ error: "Invalid signature" });
          case "wrong_chain":
            return reply.status(401).send({ error: "wrong_chain" });
          case "unconfigured":
            return reply.status(503).send({ error: "smart_account_signin_unavailable" });
          case "unavailable":
            return reply.header("Retry-After", "5").status(503).send({ error: "signature_verifier_unavailable" });
          default: {
            const _exhaustiveReason: never = check.reason;
            break;
          }
        }
        return reply.status(401).send({ error: "Invalid signature" });
      }
    } catch {
      return reply
        .status(401)
        .send({ error: "Signature verification failed" });
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

  // Session keys hold self-service scopes, expire within twelve hours or at session expiry, and are revoked on logout.
  app.post("/api/auth/session-key", async (req, reply) => {
    if (req.apiKeyId != null) {
      return reply.status(403).send({
        error: "session_required", message: "A SIWE session is required to mint a session key",
      });
    }

    try {
      const repos = getRepos();
      const session = resolveSession(req);
      const sessionRow = session ? repos.sessions.findByToken(session.token) : undefined;
      const now = new Date();
      const sessionExpiry = sessionRow ? new Date(sessionRow.expiresAt).getTime() : NaN;
      if (!session || !sessionRow || !(sessionExpiry > now.getTime())) {
        return reply.status(401).send({
          error: "session_required", message: "A valid SIWE session is required to mint a session key",
        });
      }
      // Credential creation needs the resolved session's explicit bearer proof.
      if (req.headers.authorization !== `Bearer ${session.token}`) {
        return reply.status(401).send({
          error: "session_required", message: "An explicitly carried SIWE session is required to mint a session key",
        });
      }

      const expiresAt = new Date(Math.min(sessionExpiry, now.getTime() + 12 * 60 * 60 * 1000)).toISOString();
      const { rawKey, record } = getStore().db.transaction((db) => {
        // Replace this session's key and exclude expired session keys from the active-key cap.
        for (const key of repos.apiKeys.findByOperator(session.address)) {
          if (key.revokedAt) continue;
          let metadata;
          try { metadata = JSON.parse(key.metadata ?? "{}"); } catch { continue; }
          if (metadata?.source === "siwe-session" && (
            metadata.sessionId === sessionRow.id || (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime())
          )) {
            repos.apiKeys.revoke(key.id);
          }
        }

        const { rawKey, record } = provisionApiKey({
          operatorId: session.address,
          scopes: [...SELF_SERVICE_KEY_SCOPES],
          expiresAt,
          metadata: { source: "siwe-session", sessionId: sessionRow.id, provisionedAt: now.toISOString() },
        });
        if (!record) throw new Error("Failed to provision key");

        // A session key has no custodial wallet and cannot enter the identity-write retry queue.
        db.update(schema.apiKeys).set({
          operatorWalletCustody: null,
          onchainStatus: "disabled",
          agentWalletOnchainStatus: null,
        }).where(eq(schema.apiKeys.id, record.id)).run();
        return { rawKey, record };
      });

      auditService.log({
        eventType: "auth.session_key_minted",
        actor: session.address,
        resourceType: "api_key",
        resourceId: record.id,
        action: "create",
        metadata: { expires_at: record.expiresAt },
      });
      return reply.status(201).send({
        api_key: rawKey,
        key_id: record.id,
        operator_id: session.address,
        scopes: JSON.parse(record.scopes),
        expires_at: record.expiresAt,
        created_at: record.createdAt,
      });
    } catch (err: unknown) {
      if (classifyProvisionError(err) === "too_many_keys") {
        return reply.status(429).send({
          error: "too_many_keys", message: "Maximum 5 active API keys per operator",
        });
      }
      return reply.status(500).send({ error: "provision_failed", message: "Failed to provision key" });
    }
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
        cookieToken = null;
      }
      if (cookieToken) deleteSessionAndRevokeKeys(cookieToken);
    }

    // Clear bearer-based session
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      deleteSessionAndRevokeKeys(authHeader.slice(7));
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
