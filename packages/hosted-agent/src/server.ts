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
 * No response carries the credential, and none carries an upstream message: a
 * failed open, a failed message and any other server error answer one generic
 * shape. One turn runs at a time per session. A session idle longer than
 * `idleMs` is closed and reported, and cannot be used again even if nothing
 * else has swept it: the lookup itself checks expiry.
 *
 * A credential counts as signed in only after the gateway has said whose it is
 * (`resolvePrincipal`). The budget identity comes from that operator, never from
 * the token string, and an unresolved credential refuses the open: it is never
 * downgraded to an anonymous session.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { ConfirmationRefused } from "./confirm.js";
import type { ResolvePrincipal } from "./principal.js";
import { HostedSession, PackMismatch, type SessionDeps } from "./session.js";
import { scrubText } from "./tools.js";

export interface ServerOptions {
  readonly deps: SessionDeps;
  /** Who a Bearer credential belongs to (the gateway's /api/agent/me). Required: no default can be safe. */
  readonly resolvePrincipal: ResolvePrincipal;
  /** Server-side log lines (never sent to a caller). Default: stdout. */
  readonly log?: (line: string) => void;
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
  const log = opts.log ?? ((line: string) => console.log(line));
  const generic = { error: "agent_unavailable" } as const;

  // No route answers with an upstream message. Client errors (a bad body, one
  // too large) keep Fastify's own answer; any server error is the generic shape.
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return reply.send(err);
    log(JSON.stringify({ event: "server-error", error: err instanceof Error ? err.name : "unknown" }));
    return reply.code(502).send(generic);
  });

  const expired = (entry: Entry): boolean => !entry.busy && entry.lastUsed + idleMs < now();

  async function sweepIdle(): Promise<void> {
    for (const [id, entry] of sessions) {
      if (expired(entry)) {
        sessions.delete(id);
        await entry.session.close().catch(() => undefined);
      }
    }
  }

  /** The session a request names, or null after answering "unknown". An expired
   * session is deleted, closed and reported, and answers exactly as an unknown one. */
  async function entryFor(req: FastifyRequest, reply: FastifyReply): Promise<Entry | null> {
    const id = req.headers[SESSION_HEADER];
    const entry = typeof id === "string" ? sessions.get(id) : undefined;
    if (entry && expired(entry)) {
      sessions.delete(id as string);
      await entry.session.close().catch(() => undefined);
      void reply.code(404).send({ error: "unknown_session" });
      return null;
    }
    if (!entry) {
      void reply.code(404).send({ error: "unknown_session" });
      return null;
    }
    entry.lastUsed = now();
    return entry;
  }

  /** The operator a credential belongs to, or null. A resolver that fails is "no principal". */
  async function operatorOf(credential: string): Promise<string | null> {
    try {
      const principal = await opts.resolvePrincipal(credential);
      const id = principal?.operatorId;
      return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
      return null;
    }
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
    // Keyed by a digest, never a key and never the operator id itself. A signed-in
    // caller is keyed by the operator the gateway names for the credential, so every
    // key of one operator shares one daily budget and a string the gateway never issued gets none.
    // Anonymous callers are keyed by address, which behind a proxy needs the real
    // client address (trustProxy).
    let userKey: string;
    if (credential === null) {
      userKey = `anon:${digest(req.ip)}`;
    } else {
      const operatorId = await operatorOf(credential);
      if (operatorId === null) {
        log(JSON.stringify({ event: "principal-unresolved" }));
        return reply.code(401).send({ error: "unauthorized" });
      }
      userKey = `op:${digest(`pcc-operator:${operatorId}`)}`;
    }
    let session: HostedSession;
    try {
      session = await HostedSession.open(opts.deps, { userKey, credential });
    } catch (err) {
      // Never an upstream detail: the same shape a failed message answers. What the
      // operator needs is in the log, without the error's message (it may carry a credential).
      if (err instanceof PackMismatch) {
        log(JSON.stringify({ event: "pack-mismatch", expected: err.expected, reported: err.reported?.slice(0, 200) ?? null }));
      } else {
        log(JSON.stringify({ event: "session-open-failed", error: err instanceof Error ? err.name : "unknown" }));
      }
      return reply.code(502).send(generic);
    }
    sessions.set(session.id, { session, lastUsed: now(), turns: 0, busy: false });
    return reply.code(201).send({ session: session.id, signedIn: credential !== null });
  });

  app.post<{ Body: { text?: unknown } }>("/session/messages", async (req, reply) => {
    const entry = await entryFor(req, reply);
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
      return reply.code(502).send(generic);
    } finally {
      entry.busy = false;
      entry.lastUsed = now();
    }
  });

  app.get("/session/pending", async (req, reply) => {
    const entry = await entryFor(req, reply);
    if (!entry) return;
    return { pending: entry.session.pending() };
  });

  app.post<{ Body: { token?: unknown } }>("/session/confirm", async (req, reply) => {
    const entry = await entryFor(req, reply);
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
    const entry = await entryFor(req, reply);
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
    const entry = await entryFor(req, reply);
    if (!entry) return;
    sessions.delete(req.headers[SESSION_HEADER] as string);
    return await entry.session.close();
  });

  return app;
}
