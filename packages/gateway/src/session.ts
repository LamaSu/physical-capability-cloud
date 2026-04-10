/**
 * Session manager — one UserAgent per browser session (identified by session ID).
 * Sessions auto-expire after inactivity.
 */

import { v4 as uuid } from "uuid";

export interface GatewaySession {
  id: string;
  createdAt: number;
  lastActive: number;
}

const sessions = new Map<string, GatewaySession>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function createSession(): GatewaySession {
  const session: GatewaySession = {
    id: uuid(),
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): GatewaySession | undefined {
  const session = sessions.get(id);
  if (session) {
    session.lastActive = Date.now();
  }
  return session;
}

const MAX_SESSIONS = 10_000; // Cap to prevent memory exhaustion via X-PCC-Session header forging

export function getOrCreateSession(id?: string): GatewaySession {
  if (id) {
    const existing = getSession(id);
    if (existing) return existing;
    // Don't auto-create sessions from unknown X-PCC-Session headers —
    // only look up existing ones. Prevents DoS via unlimited session creation.
  }
  // Cap total sessions to prevent memory exhaustion
  if (sessions.size >= MAX_SESSIONS) {
    // Evict oldest session
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [sid, s] of sessions) {
      if (s.lastActive < oldestTime) { oldestTime = s.lastActive; oldest = sid; }
    }
    if (oldest) sessions.delete(oldest);
  }
  return createSession();
}

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 60_000);
