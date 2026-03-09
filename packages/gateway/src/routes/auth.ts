import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes } from "node:crypto";
import { verifyMessage } from "viem";

// ---------------------------------------------------------------------------
// In-memory session store (replace with Redis/DB in production)
// ---------------------------------------------------------------------------

interface Session {
  address: `0x${string}`;
  token: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const nonces = new Map<string, number>(); // nonce -> expiry timestamp

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NONCE_TTL_MS = 5 * 60 * 1000;          // 5 minutes

/** Clean expired entries */
function cleanExpired() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(key);
  }
  for (const [nonce, expiry] of nonces) {
    if (expiry < now) nonces.delete(nonce);
  }
}

/** Verify a session token, return the address or null */
export function verifySession(token: string): `0x${string}` | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.address;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function authRoutes(app: FastifyInstance) {
  // Generate a nonce for SIWE
  app.post("/api/auth/nonce", async () => {
    cleanExpired();
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    return { nonce };
  });

  // Verify SIWE signature and create session
  app.post("/api/auth/verify", async (req, reply) => {
    const body = (req.body ?? {}) as {
      message?: string;
      signature?: string;
      address?: string;
    };

    if (!body.message || !body.signature || !body.address) {
      return reply.status(400).send({ error: "Missing message, signature, or address" });
    }

    // Extract nonce from message
    const nonceMatch = body.message.match(/Nonce: ([a-f0-9]+)/);
    if (!nonceMatch) {
      return reply.status(400).send({ error: "Invalid SIWE message format" });
    }

    const nonce = nonceMatch[1];
    const nonceExpiry = nonces.get(nonce);
    if (!nonceExpiry || nonceExpiry < Date.now()) {
      return reply.status(401).send({ error: "Nonce expired or invalid" });
    }

    // Verify signature using viem
    try {
      const valid = await verifyMessage({
        address: body.address as `0x${string}`,
        message: body.message,
        signature: body.signature as `0x${string}`,
      });

      if (!valid) {
        return reply.status(401).send({ error: "Invalid signature" });
      }
    } catch {
      return reply.status(401).send({ error: "Signature verification failed" });
    }

    // Consume nonce (one-time use)
    nonces.delete(nonce);

    // Create session
    const token = randomUUID();
    const now = Date.now();
    const session: Session = {
      address: body.address as `0x${string}`,
      token,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    sessions.set(token, session);

    return { token, address: session.address, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  // Get current session
  app.get("/api/auth/me", async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "No session" });
    }

    const token = authHeader.slice(7);
    const address = verifySession(token);
    if (!address) {
      return reply.status(401).send({ error: "Session expired or invalid" });
    }

    return { address };
  });

  // Logout
  app.post("/api/auth/logout", async (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      sessions.delete(authHeader.slice(7));
    }
    return { ok: true };
  });

  // List active sessions (admin/debug)
  app.get("/api/auth/sessions", async () => {
    cleanExpired();
    return {
      count: sessions.size,
      sessions: [...sessions.values()].map((s) => ({
        address: s.address,
        createdAt: new Date(s.createdAt).toISOString(),
        expiresAt: new Date(s.expiresAt).toISOString(),
      })),
    };
  });
}
