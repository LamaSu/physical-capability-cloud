/**
 * SIWE (Sign-In with Ethereum) authentication plugin for Fastify.
 *
 * Flow:
 *   1. GET  /api/auth/nonce   -> returns a random nonce
 *   2. POST /api/auth/verify  -> validates EIP-4361 signature, creates session
 *   3. GET  /api/auth/me      -> returns current session (cookie or bearer)
 *   4. POST /api/auth/logout  -> destroys session
 *
 * Sessions are stored in-memory (swap for Redis/DB in production).
 * Supports both HTTP-only cookie and Authorization Bearer token auth.
 * Uses viem for signature verification — no `siwe` package needed.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { verifyMessage } from "viem";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SiweSession {
  address: `0x${string}`;
  token: string;
  createdAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const sessions = new Map<string, SiweSession>();
const nonces = new Map<string, number>(); // nonce -> expiry timestamp

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Remove expired sessions and nonces */
function cleanExpired() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(key);
  }
  for (const [nonce, expiry] of nonces) {
    if (expiry < now) nonces.delete(nonce);
  }
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

/**
 * Resolve a session from the request.
 * Checks both cookie (`pcc_session`) and Authorization Bearer header.
 * Returns the session address or null.
 */
export function resolveSession(
  req: FastifyRequest,
): { address: `0x${string}`; token: string } | null {
  // 1. Try cookie
  const cookieToken = req.cookies?.pcc_session;
  if (cookieToken) {
    const session = sessions.get(cookieToken);
    if (session && session.expiresAt > Date.now()) {
      return { address: session.address, token: cookieToken };
    }
    if (session) sessions.delete(cookieToken);
  }

  // 2. Try Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7);
    const session = sessions.get(bearerToken);
    if (session && session.expiresAt > Date.now()) {
      return { address: session.address, token: bearerToken };
    }
    if (session) sessions.delete(bearerToken);
  }

  return null;
}

/**
 * Get active session count (for debug endpoints).
 */
export function getSessionCount(): number {
  cleanExpired();
  return sessions.size;
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
  return [...sessions.values()].map((s) => ({
    address: s.address,
    createdAt: new Date(s.createdAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
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

    // Validate nonce
    const nonceExpiry = nonces.get(parsed.nonce);
    if (!nonceExpiry || nonceExpiry < Date.now()) {
      return reply.status(401).send({ error: "Nonce expired or invalid" });
    }

    // Validate expiration time if present
    if (parsed.expirationTime) {
      const expires = new Date(parsed.expirationTime).getTime();
      if (!isNaN(expires) && expires < Date.now()) {
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

    // Consume nonce (one-time use)
    nonces.delete(parsed.nonce);

    // Create session
    const token = randomUUID();
    const now = Date.now();
    const session: SiweSession = {
      address: parsed.address as `0x${string}`,
      token,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    sessions.set(token, session);

    // Set HTTP-only cookie AND return token in body (client chooses which to use)
    return reply
      .setCookie("pcc_session", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 24 * 60 * 60, // 24 hours in seconds
      })
      .send({
        token,
        address: session.address,
        expiresAt: new Date(session.expiresAt).toISOString(),
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
    // Clear cookie-based session
    const cookieToken = req.cookies?.pcc_session;
    if (cookieToken) {
      sessions.delete(cookieToken);
    }

    // Clear bearer-based session
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      sessions.delete(authHeader.slice(7));
    }

    return reply.clearCookie("pcc_session", { path: "/" }).send({ ok: true });
  });

  // ----- GET /api/auth/sessions (debug) -----
  app.get("/api/auth/sessions", async () => {
    return {
      count: getSessionCount(),
      sessions: listSessions(),
    };
  });
}
