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
import { BudgetStop } from "./budget.js";
import { ConfirmationRefused } from "./confirm.js";
import { PackPinMismatch } from "./pack.js";
import type { ResolvePrincipal } from "./principal.js";
import { HostedSession, PackMismatch, type SessionDeps } from "./session.js";
import { isToolErrorCategory, type ToolErrorCategory } from "./tools.js";

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
  /** How many deployment-proxy hops to trust for X-Forwarded-For (R2 round 3).
   * Passed straight to Fastify's own `trustProxy`: `0`/`false` ignores
   * X-Forwarded-For entirely (`req.ip` is the raw socket address — the right
   * choice with no proxy in front, or a client could buy a fresh address cap
   * just by sending a fake header); a positive hop count is the number of
   * trusted proxies between the client and this service. Required by the
   * caller (main.ts's readConfig) — there is no safe default here. */
  readonly trustProxy?: number | boolean;
}

interface Entry {
  readonly session: HostedSession;
  lastUsed: number;
  turns: number;
  busy: boolean;
  /** B3 (round 4, 224b): a COUNT, not a flag shared with `busy` -- Q6-B (an
   * outcome confirmed over HTTP while a later message is still in flight)
   * deliberately lets confirm and a message turn run concurrently, so confirm
   * must never check OR clear the other's `busy`. This only exists so DELETE
   * can see "a confirm is in flight" too; a count (not a bool) survives two
   * overlapping confirms without the first's `finally` clearing the second's. */
  confirming: number;
}

const SESSION_HEADER = "x-hosted-session";

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

type ReportedPackShape = "absent" | "bare-version" | "version+sha256" | "other";

/** A bare version string: alnum, dots and hyphens only (semver-ish), no `+sha256.` suffix. */
const BARE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;
/** The pin's own shape: `<version>+sha256.<64 lowercase hex>`. */
const VERSION_PLUS_SHA256 = /^[0-9A-Za-z][0-9A-Za-z.-]*\+sha256\.[0-9a-f]{64}$/;

/**
 * How the gateway's claimed pack version compares to the pin's own shape — for
 * the mismatch log (Q1-B). NEVER the string itself: a gateway can put anything,
 * including a credential, in `serverInfo.version`. The log carries only this
 * closed-set SHAPE label. Round 7 (243 F3): no digest of the string either, since
 * a digest of an attacker-chosen value is an offline equality and dictionary oracle.
 */
function reportedPackShape(reported: unknown): ReportedPackShape {
  if (reported === undefined) return "absent";
  if (typeof reported !== "string") return "other";
  return VERSION_PLUS_SHA256.test(reported) ? "version+sha256" : BARE_VERSION.test(reported) ? "bare-version" : "other";
}

/** F3 (round 4, 224a): a CLOSED set. `other` is anything that is not even an
 * Error-shaped object; every Error-shaped value gets at least `"Error"`. */
export type ErrorCategory = "ConfigError" | "PackMismatch" | "PackPinMismatch" | "BudgetStop" | "TimeoutError" | "AbortError" | "TypeError" | "Error" | "other";

/** Reads `.name` defensively: a try/catch around a potentially throwing
 * getter, and a type check so a getter that returns a non-string (an object
 * whose `toString()` carries a secret, say) can never reach a comparison. */
function safeName(err: unknown): string | undefined {
  try {
    const n = (err as { name?: unknown } | null)?.name;
    return typeof n === "string" ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * F3 (round 4, 224a): every log line carries a category from the CLOSED set
 * above, never `Error.name` itself — `.name` is mutable, and an upstream or a
 * caller can set it to anything, including a credential (the reviewer's
 * reproduction: `err.name = "pcc_live_..."`). Decided by `instanceof` against
 * this service's own classes (`ConfigError` is the one exception: it lives in
 * main.ts, which imports server.ts, so importing it back here would cycle —
 * matched by an EXACT name comparison instead), or the platform's own
 * `TypeError`/`DOMException`-shaped `TimeoutError`/`AbortError`. The compared
 * value is NEVER itself returned or logged: a name that merely CONTAINS one
 * of these words plus a secret suffix matches none of the `===` comparisons
 * and correctly falls through to the generic `"Error"`.
 */
export function errorCategory(err: unknown): ErrorCategory {
  // TOTAL (astra 242): `instanceof` runs a proxy's getPrototypeOf trap, and a hostile value can throw
  // there. A log line's category is computed without ever letting such a throw escape.
  try {
    return errorCategoryUnsafe(err);
  } catch {
    return "other";
  }
}

function errorCategoryUnsafe(err: unknown): ErrorCategory {
  if (err instanceof PackMismatch) return "PackMismatch";
  if (err instanceof PackPinMismatch) return "PackPinMismatch";
  if (err instanceof BudgetStop) return "BudgetStop";
  if (err instanceof TypeError) return "TypeError";
  if (!(err instanceof Error)) return "other";
  const name = safeName(err);
  if (name === "TimeoutError") return "TimeoutError";
  if (name === "AbortError") return "AbortError";
  if (name === "ConfigError") return "ConfigError";
  return "Error";
}

/**
 * A logger that cannot throw (round 7, 243 F1). A log line is a side effect, never an answer, so a
 * logger's own failure is dropped. A throw inside the error handler would hand the logger's error to
 * Fastify's fallback handler, which serializes it to the caller, or, for a value whose prototype read
 * throws, never answers at all.
 */
export function totalLog(log: (line: string) => void): (line: string) => void {
  return (line) => {
    try {
      log(line);
    } catch {
      // Dropped: a failed log line never becomes an answer.
    }
  };
}

/*
 * astra 242's class, closed at every route: a thrown value is read ONLY inside the total functions
 * below (a throwing getter, a proxy trap or a revoked proxy can make any read throw, `instanceof`
 * included), and each returns a member of a closed set, never a string the thrown value supplies.
 */

/** The log line for a session that failed to open. A pack mismatch carries the pin from this
 * service's OWN config and only the closed shape of what the gateway reported. */
function openFailureLine(err: unknown, expected: string): Record<string, unknown> {
  try {
    if (err instanceof PackMismatch) return { event: "pack-mismatch", expected, reportedShape: reportedPackShape(err.reported) };
  } catch {
    // Not provably a pack mismatch: the generic line below.
  }
  return { event: "session-open-failed", error: errorCategory(err) };
}

/** A refused confirmation's reason, from its closed set; null for any other thrown value. */
function refusalReason(err: unknown): ConfirmationRefused["reason"] | null {
  try {
    if (!(err instanceof ConfirmationRefused)) return null;
    const reason: unknown = err.reason;
    return reason === "unknown" || reason === "expired" || reason === "other-session" ? reason : "unknown";
  } catch {
    return null;
  }
}

/** What a failed confirmed call answers: the closed category its tool caller threw (packTools throws
 * nothing else), or "tool_failed". Never free text. */
function confirmedCallFailure(err: unknown): ToolErrorCategory {
  try {
    const message: unknown = err instanceof Error ? err.message : undefined;
    return isToolErrorCategory(message) ? message : "tool_failed";
  } catch {
    return "tool_failed";
  }
}

/** Fastify's own client errors (a malformed or oversized body, a wrong media type) by status. */
const CLIENT_ERROR: Readonly<Record<number, string>> = { 413: "payload_too_large", 415: "unsupported_media_type" };

/** A thrown value's client-error status (an integer in 400-499), or null. */
function clientErrorStatus(err: unknown): number | null {
  try {
    const status: unknown = (err as { statusCode?: unknown } | null)?.statusCode;
    return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
  } catch {
    return null;
  }
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: opts.trustProxy ?? false });
  const sessions = new Map<string, Entry>();
  const now = opts.now ?? Date.now;
  const maxChars = opts.maxMessageChars ?? 8_000;
  const maxTurns = opts.maxTurns ?? 80;
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const log = totalLog(opts.log ?? ((line: string) => console.log(line)));
  const generic = { error: "agent_unavailable" } as const;

  // No route answers with a thrown value's text. A client error is Fastify's own, raised while it
  // reads the request (a malformed or oversized body, a wrong media type), so before any handler
  // runs: it keeps its status, with a closed body. Whatever a handler throws (a dependency's
  // failure) is a server error whatever `statusCode` it claims, and gets the generic shape. The
  // thrown value itself is never serialized, since Fastify's serializer reads `.message`, and a
  // hostile getter's throw would become the answer.
  const inHandler = new WeakSet<FastifyRequest>();
  app.addHook("preHandler", async (req) => {
    inHandler.add(req);
  });
  app.setErrorHandler((err, req, reply) => {
    const status = inHandler.has(req) ? null : clientErrorStatus(err);
    if (status !== null) return reply.code(status).send({ error: CLIENT_ERROR[status] ?? "bad_request" });
    log(JSON.stringify({ event: "server-error", error: errorCategory(err) }));
    return reply.code(502).send(generic);
  });

  const expired = (entry: Entry): boolean => !entry.busy && entry.confirming === 0 && entry.lastUsed + idleMs < now();

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
    // Anonymous callers are keyed by address, which behind a proxy needs the real client
    // address: req.ip honors X-Forwarded-For once `trustProxy` is configured (R2 round 3,
    // main.ts's PCC_HOSTED_TRUSTED_PROXY_HOPS) — with it unset (hops=0), every client behind
    // a deployment proxy would otherwise share this ONE address, proxy-wide.
    //
    // addressKey (Q3): provisioning accepts an unverified email or wallet, so the
    // operator id alone is not a trust root — an attacker can mint a fresh
    // operator id per allowance. Every session, signed in or not, is ALSO keyed by
    // this same client-address digest, and the budget meter charges both. For an
    // anonymous session the two keys are identical: one cap, not two.
    const addressKey = `anon:${digest(req.ip)}`;
    let userKey: string;
    if (credential === null) {
      userKey = addressKey;
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
      session = await HostedSession.open(opts.deps, { userKey, addressKey, credential });
    } catch (err) {
      // Never an upstream detail: the same shape a failed message answers. What the
      // operator needs is in the log, without the error's message (it may carry a credential).
      log(JSON.stringify(openFailureLine(err, `${opts.deps.pack.version}+sha256.${opts.deps.pack.sha256}`)));
      return reply.code(502).send(generic);
    }
    sessions.set(session.id, { session, lastUsed: now(), turns: 0, busy: false, confirming: 0 });
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
    // B3 (round 4, 224b): confirm() awaits the confirmed tool call itself, so this is
    // in-flight too -- but NOT via `busy`: Q6-B deliberately lets a confirm resolve
    // while a LATER message turn is still in flight (the outcome then reaches the
    // model on the turn after). `confirming` only marks the session for DELETE (and
    // idle-expiry, see `expired`); it never gates or is gated by `busy`.
    entry.confirming += 1;
    try {
      return { result: await entry.session.confirm(token) };
    } catch (err) {
      const refused = refusalReason(err);
      if (refused !== null) return reply.code(409).send({ error: refused });
      return reply.code(502).send({ error: "action_failed", message: confirmedCallFailure(err) });
    } finally {
      entry.confirming -= 1;
      entry.lastUsed = now();
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
      const refused = refusalReason(err);
      if (refused !== null) return reply.code(409).send({ error: refused });
      throw err;
    }
  });

  app.delete("/session", async (req, reply) => {
    const entry = await entryFor(req, reply);
    if (!entry) return;
    // Q5-2: a turn in flight settles its spend and its report when it finishes; closing
    // underneath it would report zero/incomplete tokens and drop the transport out from
    // under tool calls the turn may still attempt. Refuse, close nothing, and leave the
    // session exactly as it was: the caller may retry the DELETE once the turn answers.
    // B3 (round 4, 224b): a confirm awaiting its tool call is in flight the same way.
    if (entry.busy || entry.confirming > 0) return reply.code(409).send({ error: "session_busy" });
    sessions.delete(req.headers[SESSION_HEADER] as string);
    return await entry.session.close();
  });

  return app;
}
