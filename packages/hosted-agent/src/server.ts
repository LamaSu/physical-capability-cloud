/**
 * The hosted agent's HTTP surface (the first cut serves the rehearsal and a minimal page).
 *
 *   POST   /session            open a session. The user's credential, if any,
 *                              arrives ONLY here, in the Authorization header.
 *   POST   /session/messages   { text } → { reply, pending, stopped? }
 *   GET    /session/pending    the held calls, for the confirmation cards
 *   POST   /session/confirm    { token } → the confirmed call's result
 *   POST   /session/reject     { token }
 *   DELETE /session            close → the attempt report
 *
 * Every /session/* call names its session in the `x-hosted-session` header,
 * never in the URL, so the id (a bearer capability) stays out of access logs.
 * No response carries the credential. One turn runs at a time per session.
 * Sessions idle longer than `idleMs` are closed and reported.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { ConfirmationRefused } from "./confirm.js";
import { HostedSession, type SessionDeps } from "./session.js";
import { scrubText } from "./tools.js";

export interface ServerOptions {
  readonly deps: SessionDeps;
  readonly maxMessageChars?: number;
  readonly maxTurns?: number;
  readonly idleMs?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly session: HostedSession;
  lastUsed: number;
  turns: number;
  busy: boolean;
}

const SESSION_HEADER = "x-hosted-session";

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const sessions = new Map<string, Entry>();
  const now = opts.now ?? Date.now;
  const maxChars = opts.maxMessageChars ?? 8_000;
  const maxTurns = opts.maxTurns ?? 80;
  const idleMs = opts.idleMs ?? 30 * 60_000;

  async function sweepIdle(): Promise<void> {
    for (const [id, entry] of sessions) {
      if (!entry.busy && entry.lastUsed + idleMs < now()) {
        sessions.delete(id);
        await entry.session.close().catch(() => undefined);
      }
    }
  }

  function entryFor(req: FastifyRequest, reply: FastifyReply): Entry | null {
    const id = req.headers[SESSION_HEADER];
    const entry = typeof id === "string" ? sessions.get(id) : undefined;
    if (!entry) {
      void reply.code(404).send({ error: "unknown_session" });
      return null;
    }
    entry.lastUsed = now();
    return entry;
  }

  app.post("/session", async (req, reply) => {
    await sweepIdle();
    const auth = req.headers.authorization;
    let credential: string | null = null;
    if (auth !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      if (!m) return reply.code(400).send({ error: "bad_authorization" });
      credential = m[1]!;
    }
    // Keyed by a digest, never the key itself. Anonymous callers are keyed by
    // address, which behind a proxy needs the real client address (trustProxy).
    const userKey = credential !== null ? `key:${digest(credential)}` : `anon:${digest(req.ip)}`;
    const session = await HostedSession.open(opts.deps, { userKey, credential });
    sessions.set(session.id, { session, lastUsed: now(), turns: 0, busy: false });
    return reply.code(201).send({ session: session.id, signedIn: credential !== null });
  });

  app.post<{ Body: { text?: unknown } }>("/session/messages", async (req, reply) => {
    const entry = entryFor(req, reply);
    if (!entry) return;
    const text = req.body?.text;
    if (typeof text !== "string" || text.trim().length === 0) return reply.code(400).send({ error: "text_required" });
    if (text.length > maxChars) return reply.code(413).send({ error: "message_too_long", maxChars });
    if (entry.turns >= maxTurns) return reply.code(429).send({ error: "turn_limit", maxTurns });
    if (entry.busy) return reply.code(409).send({ error: "turn_in_progress" });
    entry.busy = true;
    try {
      const result = await entry.session.send(text);
      entry.turns += 1;
      return result;
    } catch {
      return reply.code(502).send({ error: "agent_unavailable" });
    } finally {
      entry.busy = false;
      entry.lastUsed = now();
    }
  });

  app.get("/session/pending", async (req, reply) => {
    const entry = entryFor(req, reply);
    if (!entry) return;
    return { pending: entry.session.pending() };
  });

  app.post<{ Body: { token?: unknown } }>("/session/confirm", async (req, reply) => {
    const entry = entryFor(req, reply);
    if (!entry) return;
    const token = req.body?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "token_required" });
    try {
      return { result: await entry.session.confirm(token) };
    } catch (err) {
      if (err instanceof ConfirmationRefused) return reply.code(409).send({ error: err.reason });
      return reply.code(502).send({ error: "action_failed", message: scrubText(err instanceof Error ? err.message : String(err)) });
    }
  });

  app.post<{ Body: { token?: unknown } }>("/session/reject", async (req, reply) => {
    const entry = entryFor(req, reply);
    if (!entry) return;
    const token = req.body?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "token_required" });
    try {
      entry.session.reject(token);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ConfirmationRefused) return reply.code(409).send({ error: err.reason });
      throw err;
    }
  });

  app.delete("/session", async (req, reply) => {
    const entry = entryFor(req, reply);
    if (!entry) return;
    sessions.delete(req.headers[SESSION_HEADER] as string);
    return await entry.session.close();
  });

  return app;
}
