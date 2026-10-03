import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { BudgetMeter, type BudgetCaps, type MessagesClient } from "../budget.js";
import type { PinnedPack } from "../pack.js";
import type { ResolvePrincipal } from "../principal.js";
import type { ToolTransport } from "../tools.js";
import { buildServer, errorCategory } from "../server.js";
import { HostedSession, type SessionDeps } from "../session.js";

const KEY = "pcc_live_ServerTestKey0001";
const USD = 1_000_000_000;
const PACK: PinnedPack = {
  version: "2.19.1",
  sha256: "b".repeat(64),
  systemPrompt: "P",
  tools: [{ def: { name: "onboard_machine", description: "", input_schema: { type: "object" } }, spec: { name: "onboard_machine", method: "POST", path: "/api/onboard/register" } }],
};
const text = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 1, output_tokens: 1 } });
// A model's tool_use ids are unique within a conversation; so are the scripted ones.
let toolUseCount = 0;
const toolUse = (name: string) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu-${++toolUseCount}`, name, input: { a: 1 } }], usage: { input_tokens: 1, output_tokens: 1 } });

/** Every credential resolves, each to an operator of its own, unless a test says otherwise. */
const anyCredential: ResolvePrincipal = async (credential) => ({ operatorId: `operator-of-${credential}` });

function setup(
  o: {
    replies?: unknown[];
    create?: (req: unknown) => Promise<unknown>;
    maxTurns?: number;
    clock?: { t: number };
    failTool?: string;
    toolResult?: unknown;
    caps?: Partial<BudgetCaps>;
    maxTokens?: number;
    resolvePrincipal?: ResolvePrincipal;
    reported?: { version: string | undefined };
    connectError?: Error;
    listError?: Error;
    reportError?: Error;
    trustProxy?: number | boolean;
    toolGate?: Promise<void>;
  } = {},
) {
  const replies = [...(o.replies ?? [])];
  const create = vi.fn(o.create ?? (async () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r ?? text("(default)");
  }));
  const calls: string[] = [];
  const transport: ToolTransport & { closes: number } = {
    closes: 0,
    serverVersion: () => (o.reported ? o.reported.version : `${PACK.version}+sha256.${PACK.sha256}`),
    listTools: async () => {
      if (o.listError) throw o.listError;
      return PACK.tools.map((t) => t.def.name);
    },
    callTool: async (n) => {
      if (o.toolGate) await o.toolGate;
      if (o.failTool) throw new Error(o.failTool);
      calls.push(n);
      return o.toolResult ?? { ok: true };
    },
    close: async () => void (transport.closes += 1),
  };
  const connect = vi.fn(async (_c: string | null) => {
    if (o.connectError) throw o.connectError;
    return transport;
  });
  const reports: unknown[] = [];
  const logs: string[] = [];
  const clock = o.clock ?? { t: 1_000 };
  const db = new Database(":memory:");
  const deps: SessionDeps = {
    pack: PACK,
    meter: new BudgetMeter(db, { perSession: USD, perUserDay: USD, perMonth: USD, ...o.caps }, () => new Date("2026-10-06T00:00:00Z"), () => false),
    price: { input: 1, output: 1 },
    model: "m",
    maxTokens: o.maxTokens,
    anthropic: { messages: { create } } as unknown as MessagesClient,
    connect,
    l2Enabled: false,
    report: (r) => {
      if (o.reportError) throw o.reportError;
      reports.push(r);
    },
    now: () => clock.t,
  };
  const app = buildServer({
    deps,
    resolvePrincipal: o.resolvePrincipal ?? anyCredential,
    log: (line) => logs.push(line),
    maxTurns: o.maxTurns,
    idleMs: 60_000,
    now: () => clock.t,
    trustProxy: o.trustProxy ?? false,
  });
  return { app, connect, calls, reports, logs, create, clock, db, transport };
}

async function open(app: ReturnType<typeof buildServer>, key?: string) {
  const res = await app.inject({ method: "POST", url: "/session", headers: key ? { authorization: `Bearer ${key}` } : {} });
  expect(res.statusCode).toBe(201);
  return res.json().session as string;
}
const say = (app: ReturnType<typeof buildServer>, id: string, t: unknown) =>
  app.inject({ method: "POST", url: "/session/messages", headers: { "x-hosted-session": id }, payload: { text: t } });

describe("the hosted agent's HTTP surface", () => {
  it("the credential is taken only from the Authorization header on open, and never echoed", async () => {
    const { app, connect } = setup({ replies: [text("hi")] });
    const res = await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    expect(connect).toHaveBeenCalledWith(KEY);
    expect(res.json().signedIn).toBe(true);
    const id = res.json().session as string;
    const bodies = [res.body, (await say(app, id, "hello")).body, (await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } })).body];
    for (const b of bodies) expect(b).not.toContain(KEY);
  });

  it("the spend ledger keys a signed-in user by a digest of the operator id, never by the key or the id", async () => {
    const { app, db } = setup({ replies: [text("hi")], resolvePrincipal: async () => ({ operatorId: "operator-7" }) });
    const id = await open(app, KEY);
    await say(app, id, "hello");
    const rows = db.prepare("SELECT user_key FROM hosted_agent_spend").all() as Array<{ user_key: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const expected = `op:${createHash("sha256").update("pcc-operator:operator-7").digest("hex").slice(0, 32)}`;
    for (const r of rows) {
      expect(r.user_key).toBe(expected);
      expect(r.user_key).not.toContain(KEY);
      expect(r.user_key).not.toContain("operator-7");
    }
  });

  it("a failed confirmation answers 502 with its error scrubbed", async () => {
    const { app } = setup({ replies: [toolUse("onboard_machine"), text("confirm?")], failTool: "refused: key pcc_live_EchoedByGateway99 is not allowed" });
    const id = await open(app, KEY);
    const [held] = (await say(app, id, "register")).json().pending as Array<{ token: string }>;
    const res = await app.inject({ method: "POST", url: "/session/confirm", headers: { "x-hosted-session": id }, payload: { token: held!.token } });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("refused");
    expect(res.body).not.toContain("pcc_live_");
  });

  it("a keyless open passes no credential; a malformed Authorization is refused", async () => {
    const { app, connect } = setup();
    await open(app);
    expect(connect).toHaveBeenCalledWith(null);
    const bad = await app.inject({ method: "POST", url: "/session", headers: { authorization: "Basic abc" } });
    expect(bad.statusCode).toBe(400);
  });

  it("messages: unknown session 404, empty 400, too long 413, and a reply flows", async () => {
    const { app } = setup({ replies: [text("hello back")] });
    const id = await open(app);
    expect((await say(app, "nope", "hi")).statusCode).toBe(404);
    expect((await say(app, id, "")).statusCode).toBe(400);
    expect((await say(app, id, "x".repeat(8_001))).statusCode).toBe(413);
    const ok = await say(app, id, "hi");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reply).toBe("hello back");
  });

  it("the turn limit is enforced", async () => {
    const { app } = setup({ maxTurns: 2 });
    const id = await open(app);
    expect((await say(app, id, "1")).statusCode).toBe(200);
    expect((await say(app, id, "2")).statusCode).toBe(200);
    expect((await say(app, id, "3")).statusCode).toBe(429);
  });

  it("one turn at a time per session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app } = setup({ create: async () => (await gate, text("slow")) });
    const id = await open(app);
    const first = say(app, id, "one");
    await new Promise((r) => setTimeout(r, 20));
    const second = await say(app, id, "two");
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
  });

  it("Q5-2: DELETE while a turn is busy answers 409 and closes nothing; after the turn settles, DELETE answers 200 with the final tokens", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, transport, reports } = setup({ create: async () => (await gate, text("slow")) });
    const id = await open(app);
    const inFlight = say(app, id, "one");
    await new Promise((r) => setTimeout(r, 20));
    const busyDelete = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(busyDelete.statusCode).toBe(409);
    expect(busyDelete.json()).toEqual({ error: "session_busy" });
    expect(transport.closes).toBe(0); // the transport was not closed
    expect(reports).toHaveLength(0); // no attempt report was emitted
    release();
    expect((await inFlight).statusCode).toBe(200);
    // the session is still usable after a refused DELETE
    expect((await app.inject({ method: "GET", url: "/session/pending", headers: { "x-hosted-session": id } })).statusCode).toBe(200);
    const res = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(res.statusCode).toBe(200);
    expect(res.json().report).toMatchObject({ tokens: { in: 1, out: 1, source: "metered" } });
    expect(transport.closes).toBe(1);
    expect(reports).toHaveLength(1);
    // and now it is really gone
    expect((await say(app, id, "hi")).statusCode).toBe(404);
  });

  it("B3 (round 4, 224b MEDIUM): DELETE during an in-flight /session/confirm answers 409, not 200, and closes nothing", async () => {
    let release!: () => void;
    const toolGate = new Promise<void>((r) => (release = r));
    const { app, transport, reports } = setup({ replies: [toolUse("onboard_machine"), text("confirmed")], toolGate });
    const id = await open(app, KEY);
    const turn = await say(app, id, "register");
    const [held] = turn.json().pending as Array<{ token: string }>;
    const inFlightConfirm = app.inject({ method: "POST", url: "/session/confirm", headers: { "x-hosted-session": id }, payload: { token: held!.token } });
    await new Promise((r) => setTimeout(r, 20));
    const busyDelete = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(busyDelete.statusCode).toBe(409);
    expect(busyDelete.json()).toEqual({ error: "session_busy" });
    expect(transport.closes).toBe(0); // the transport was not closed
    expect(reports).toHaveLength(0); // no attempt report was emitted
    release();
    expect((await inFlightConfirm).statusCode).toBe(200);
    // cleared when confirm settles: the session is usable (and closeable) again
    const res = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(res.statusCode).toBe(200);
    expect(transport.closes).toBe(1);
  });

  it("B3: the busy flag set around /session/confirm is cleared in finally even when the tool call throws", async () => {
    let release!: () => void;
    const toolGate = new Promise<void>((r) => (release = r));
    const { app } = setup({ replies: [toolUse("onboard_machine"), text("confirmed")], toolGate, failTool: "pcc_live_SyntheticToolFailure0007" });
    const id = await open(app, KEY);
    const turn = await say(app, id, "register");
    const [held] = turn.json().pending as Array<{ token: string }>;
    const inFlightConfirm = app.inject({ method: "POST", url: "/session/confirm", headers: { "x-hosted-session": id }, payload: { token: held!.token } });
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await inFlightConfirm).statusCode).toBe(502); // the throwing tool call still answers, just as an error
    // not left stuck busy: a DELETE right after answers 200, not a lingering 409
    const res = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(res.statusCode).toBe(200);
  });

  it("confirm and reject by body token; an unknown token is refused", async () => {
    const { app, calls } = setup({ replies: [toolUse("onboard_machine"), text("confirm?"), toolUse("onboard_machine"), text("confirm?")] });
    const id = await open(app, KEY);
    const turn = await say(app, id, "register");
    const [held] = turn.json().pending as Array<{ token: string }>;
    const pending = await app.inject({ method: "GET", url: "/session/pending", headers: { "x-hosted-session": id } });
    expect(pending.json().pending).toHaveLength(1);
    const ok = await app.inject({ method: "POST", url: "/session/confirm", headers: { "x-hosted-session": id }, payload: { token: held!.token } });
    expect(ok.statusCode).toBe(200);
    expect(calls).toEqual(["onboard_machine"]);
    const again = await app.inject({ method: "POST", url: "/session/confirm", headers: { "x-hosted-session": id }, payload: { token: held!.token } });
    expect(again.statusCode).toBe(409);
    const turn2 = await say(app, id, "register again");
    const [held2] = turn2.json().pending as Array<{ token: string }>;
    const rej = await app.inject({ method: "POST", url: "/session/reject", headers: { "x-hosted-session": id }, payload: { token: held2!.token } });
    expect(rej.statusCode).toBe(204);
    expect(calls).toEqual(["onboard_machine"]);
  });

  it("close returns the attempt report and forgets the session", async () => {
    const { app, reports } = setup();
    const id = await open(app);
    const res = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(res.json().report).toMatchObject({ kind: "attempt", contract: 1, phase: "session", harness: { name: "pcc-hosted" } });
    expect(reports).toHaveLength(1);
    expect((await say(app, id, "hi")).statusCode).toBe(404);
  });

  it("an idle session is closed and reported when the next one opens", async () => {
    const clock = { t: 1_000 };
    const { app, reports } = setup({ clock });
    const idle = await open(app);
    clock.t += 60_001;
    await open(app);
    expect(reports).toHaveLength(1);
    expect((await say(app, idle, "hi")).statusCode).toBe(404);
  });

  it("an upstream failure answers 502 without its details", async () => {
    const { app } = setup({ replies: [new Error("upstream secret detail")] });
    const id = await open(app);
    const res = await say(app, id, "hi");
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("secret detail");
  });
});

const confirmCall = (app: ReturnType<typeof buildServer>, id: string, token: string) =>
  app.inject({ method: "POST", url: "/session/confirm", headers: { "x-hosted-session": id }, payload: { token } });

describe("a failed session open leaks no upstream detail (Q1-B)", () => {
  const generic = { error: "agent_unavailable" };

  it("Q1-B: a connect failure answers the generic upstream error, with no detail", async () => {
    const { app } = setup({ connectError: new Error("upstream rejected pcc_live_SyntheticCredential0001 at https://gateway.internal:4310") });
    const res = await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual(generic);
    expect(res.body).not.toMatch(/pcc_live_|gateway\.internal|rejected/);
  });

  it("Q1-B: a tool-listing failure answers the same, and the connection it opened is closed", async () => {
    const { app, transport } = setup({ listError: new Error("listing said pcc_live_SyntheticCredential0002") });
    const res = await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual(generic);
    expect(res.body).not.toContain("pcc_live_");
    expect(transport.closes).toBe(1);
  });

  it("Q1-B: it is the same shape the message route answers for an upstream failure", async () => {
    const { app } = setup({ replies: [new Error("upstream secret detail")] });
    const id = await open(app);
    const viaMessage = await say(app, id, "hi");
    const failing = setup({ connectError: new Error("upstream secret detail") });
    const viaOpen = await failing.app.inject({ method: "POST", url: "/session" });
    expect(viaOpen.statusCode).toBe(viaMessage.statusCode);
    expect(viaOpen.json()).toEqual(viaMessage.json());
  });

  it("Q1-B: a failed open is handled at the route and logged once, not left to the catch-all", async () => {
    const { app, logs } = setup({ connectError: new Error("down") });
    await app.inject({ method: "POST", url: "/session" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("session-open-failed");
    expect(logs.join("\n")).not.toContain("server-error");
  });

  it("Q1-B: the server-side log names the failure, never its message (which may carry a credential)", async () => {
    const { app, logs } = setup({ connectError: new Error("upstream rejected pcc_live_SyntheticCredential0004") });
    await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    const logged = logs.join("\n");
    expect(logged).toContain("session-open-failed");
    expect(logged).not.toMatch(/pcc_live_|rejected/);
  });

  it("Q1-B: no session is recorded for a failed open", async () => {
    const { app } = setup({ connectError: new Error("down") });
    const res = await app.inject({ method: "POST", url: "/session" });
    expect(res.statusCode).toBe(502);
    expect(res.json().session).toBeUndefined();
  });

  it("client errors keep their own status: a malformed or oversized body is a 4xx, not the generic upstream error", async () => {
    const { app } = setup();
    const id = await open(app);
    const headers = { "x-hosted-session": id, "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: "/session/messages", headers, payload: "{not json" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/session/messages", headers, payload: JSON.stringify({ text: "x".repeat(70_000) }) })).statusCode).toBe(413);
  });

  it("Q1-B: no other route echoes an upstream message either (closing a session whose report sink fails)", async () => {
    const { app } = setup({ reportError: new Error("sink said pcc_live_SyntheticCredential0003") });
    const id = await open(app);
    const res = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual(generic);
    expect(res.body).not.toContain("pcc_live_");
  });
});

describe("F3 (round 4, 224a MEDIUM): every log line carries a closed-set category, never a raw Error.name", () => {
  it("F3: the reviewer's case at the session-open-failed site — a credential-shaped err.name never reaches the log", async () => {
    const err = new Error("down");
    err.name = "pcc_live_opaqueLogSecret";
    const { app, logs } = setup({ connectError: err });
    await app.inject({ method: "POST", url: "/session" });
    expect(logs.join("\n")).not.toContain("pcc_live_");
    expect(logs.join("\n")).toContain("session-open-failed");
    expect(JSON.parse(logs[0]!)).toEqual({ event: "session-open-failed", error: "Error" });
  });

  it("F3: the reviewer's case at the global catch-all (setErrorHandler) site — a report-sink failure propagates there uncaught", async () => {
    // HostedSession.close() has no catch around deps.report(); DELETE /session has none around
    // close() either, so this reaches Fastify's own setErrorHandler — the OTHER flagged site.
    const err = new Error("sink down");
    err.name = "pcc_live_opaqueLogSecret2";
    const { app, logs } = setup({ reportError: err });
    const id = await open(app);
    const res = await app.inject({ method: "DELETE", url: "/session", headers: { "x-hosted-session": id } });
    expect(res.statusCode).toBe(502);
    expect(logs.join("\n")).not.toContain("pcc_live_");
    const serverErrorLine = logs.find((l) => l.includes("server-error"))!;
    expect(serverErrorLine).toBeDefined();
    expect(JSON.parse(serverErrorLine)).toEqual({ event: "server-error", error: "Error" });
  });

  it("F3: errorCategory returns a CLOSED-SET value, never the name itself — a name equal to a member plus a secret suffix misses and falls to Error", () => {
    const suffixed = new Error("x");
    suffixed.name = "ConfigErrorpcc_live_SyntheticSuffix0004";
    const category = errorCategory(suffixed);
    expect(category).toBe("Error");
    expect(category).not.toContain("pcc_live_");
  });

  it("F3: a genuine closed-set name is recognized exactly", () => {
    const configLike = new Error("x");
    configLike.name = "ConfigError";
    expect(errorCategory(configLike)).toBe("ConfigError");
    expect(errorCategory(new TypeError("bad"))).toBe("TypeError");
    expect(errorCategory("not even an object")).toBe("other");
    expect(errorCategory({ name: "pcc_live_plainobject" })).toBe("other");
  });

  it("F3: a getter-based name is never invoked unsafely — invoking it cannot leak or throw out of errorCategory", () => {
    const throwing = new Error("x");
    Object.defineProperty(throwing, "name", {
      get() {
        throw new Error("pcc_live_SyntheticGetterTrap0005");
      },
    });
    expect(() => errorCategory(throwing)).not.toThrow();
    expect(errorCategory(throwing)).toBe("Error");

    const nonString = new Error("x");
    Object.defineProperty(nonString, "name", { get: () => ({ toString: () => "pcc_live_SyntheticObjectTrap0006" }) });
    expect(errorCategory(nonString)).toBe("Error");
  });
});

describe("what the HTTP caller is shown is scrubbed (Q1-C, Q3-B)", () => {
  it("Q1-C: the confirmation response is scrubbed whatever the transport returns", async () => {
    const { app, create } = setup({
      replies: [toolUse("onboard_machine"), text("confirm?"), text("ok")],
      toolResult: { registered: true, apiKey: "pcc_live_LeakedByATransport99", note: "Bearer abcdefgh12345678" },
    });
    const id = await open(app, KEY);
    const [held] = (await say(app, id, "register")).json().pending as Array<{ token: string }>;
    const res = await confirmCall(app, id, held!.token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"registered":true');
    expect(res.body).not.toMatch(/pcc_live_|Bearer\s/);
    await say(app, id, "thanks");
    expect(JSON.stringify(create.mock.calls.at(-1))).not.toMatch(/pcc_live_Leaked|abcdefgh12345678/);
  });

  it("Q1-A round 2: an opaque non-JSON credential assignment in a confirmed result reaches neither the confirmation response nor the next model request", async () => {
    const { app, create } = setup({
      replies: [toolUse("onboard_machine"), text("confirm?"), text("ok")],
      toolResult: "token=opaque-session-value-0123",
    });
    const id = await open(app, KEY);
    const [held] = (await say(app, id, "register")).json().pending as Array<{ token: string }>;
    const res = await confirmCall(app, id, held!.token);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("opaque-session-value-0123");
    await say(app, id, "thanks");
    expect(JSON.stringify(create.mock.calls.at(-1))).not.toContain("opaque-session-value-0123");
  });

  it("Q3-B: a token in a confirmed result reaches neither the confirmation response nor the next model request", async () => {
    const { app, create } = setup({
      replies: [toolUse("onboard_machine"), text("confirm?"), text("ok")],
      toolResult: { token: "eyJhbGciOiJIUzI1NiJ9.synthetic.signature" },
    });
    const id = await open(app, KEY);
    const [held] = (await say(app, id, "register")).json().pending as Array<{ token: string }>;
    const res = await confirmCall(app, id, held!.token);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("eyJ");
    await say(app, id, "thanks");
    expect(JSON.stringify(create.mock.calls.at(-1))).not.toContain("eyJ");
  });
});

describe("a signed-in budget belongs to an authenticated operator, never to the token (Q4-A)", () => {
  const VALID: Record<string, string> = { pcc_live_ValidKeyA1: "op-1", pcc_live_ValidKeyA2: "op-1", pcc_live_ValidKeyB1: "op-2" };
  const resolvePrincipal: ResolvePrincipal = async (credential) => (credential in VALID ? { operatorId: VALID[credential]! } : null);
  // 9,100 nano-USD actually used, under a worst case of about 11,000: spends the allowance without overrunning the reservation.
  const spendy = { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 9_000, output_tokens: 100 } };
  const dayCap = { perUserDay: 15_000 };
  const openWith = (app: ReturnType<typeof buildServer>, authorization?: string, remoteAddress?: string) =>
    app.inject({ method: "POST", url: "/session", headers: authorization ? { authorization } : {}, ...(remoteAddress ? { remoteAddress } : {}) });

  it("Q4-A: a Bearer string that resolves to no operator refuses the open with 401, never a downgrade to anonymous", async () => {
    const { app, connect } = setup({ resolvePrincipal });
    for (const bad of ["Bearer unissued-a", "Bearer unissued-b", "Bearer pcc_live_NotAKnownKey"]) {
      const res = await openWith(app, bad);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
      expect(res.body).not.toMatch(/unissued|pcc_live_/);
    }
    expect(connect).not.toHaveBeenCalled(); // nothing was connected on an unverified credential's behalf
  });

  it("Q4-A: a resolver that answers no usable operator id (empty, missing, not a string) refuses the open", async () => {
    for (const answer of [{ operatorId: "" }, {}, { operatorId: 7 }, { operatorId: null }, null, undefined]) {
      const { app, connect } = setup({ resolvePrincipal: (async () => answer) as unknown as ResolvePrincipal });
      const res = await openWith(app, `Bearer ${KEY}`);
      expect(res.statusCode, JSON.stringify(answer)).toBe(401);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("Q4-A: a resolver that fails or throws refuses the open too", async () => {
    for (const resolver of [async () => null, async () => Promise.reject(new Error("gateway down pcc_live_ValidKeyA1"))]) {
      const { app, connect } = setup({ resolvePrincipal: resolver as ResolvePrincipal });
      const res = await openWith(app, `Bearer ${KEY}`);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
      expect(res.body).not.toContain("pcc_live_");
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("Q4-A: an exhausted daily allowance is not renewed by presenting a different, unresolvable Bearer string", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy, spendy] });
    const a = (await openWith(app, "Bearer pcc_live_ValidKeyA1")).json().session as string;
    expect((await say(app, a, "one")).json().stopped).toBeUndefined();
    expect((await say(app, a, "two")).json().stopped).toBe("per-user-day"); // exhausted
    const other = await openWith(app, "Bearer unissued-b");
    expect(other.statusCode).toBe(401); // no fresh allowance, because no session at all
  });

  it("Q4-A: two different valid keys of the SAME operator share ONE daily budget; another operator AT A DIFFERENT ADDRESS has its own", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy, spendy, spendy] });
    const a1 = (await openWith(app, "Bearer pcc_live_ValidKeyA1")).json().session as string;
    expect((await say(app, a1, "one")).json().stopped).toBeUndefined();
    const second = await openWith(app, "Bearer pcc_live_ValidKeyA2");
    expect(second.statusCode).toBe(201);
    expect((await say(app, second.json().session, "two")).json().stopped).toBe("per-user-day");
    // A different operator (op-2) AND a different client address: Q3 round 2 also shares a day
    // cap across operators at the SAME address (tested below), so this one must be elsewhere to
    // get its own allowance.
    const other = await openWith(app, "Bearer pcc_live_ValidKeyB1", "203.0.113.77");
    expect(other.statusCode).toBe(201);
    expect((await say(app, other.json().session, "three")).json().stopped).toBeUndefined();
  });

  it("Q3 round 2: two operators from ONE client share its address cap — after the first exhausts it, the second key's session is refused too", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy] });
    const ip = "198.51.100.9";
    const a = (await openWith(app, "Bearer pcc_live_ValidKeyA1", ip)).json().session as string;
    expect((await say(app, a, "one")).json().stopped).toBeUndefined(); // exhausts op-1's day cap AND the shared address cap
    const b = (await openWith(app, "Bearer pcc_live_ValidKeyB1", ip)).json().session as string; // a DIFFERENT operator, SAME client address
    expect((await say(app, b, "two")).json().stopped).toBe("per-address-day");
  });

  it("Q3 round 2: a second client (different address) with a second operator gets its own allowance", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy] });
    const a = (await openWith(app, "Bearer pcc_live_ValidKeyA1", "198.51.100.10")).json().session as string;
    expect((await say(app, a, "one")).json().stopped).toBeUndefined();
    const b = (await openWith(app, "Bearer pcc_live_ValidKeyB1", "198.51.100.20")).json().session as string;
    expect((await say(app, b, "two")).json().stopped).toBeUndefined();
  });

  it("Q3 round 2: an anonymous session and a signed-in session from ONE client share the address cap", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy] });
    const ip = "198.51.100.30";
    const anon = (await openWith(app, undefined, ip)).json().session as string;
    expect((await say(app, anon, "one")).json().stopped).toBeUndefined(); // exhausts the shared address cap
    const signedIn = (await openWith(app, "Bearer pcc_live_ValidKeyA1", ip)).json().session as string;
    expect((await say(app, signedIn, "two")).json().stopped).toBe("per-address-day");
  });

  it("R2 (round 3): reproduced — with no trustProxy, two different real clients behind one proxy share ONE address cap", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy], trustProxy: false });
    const proxyIp = "203.0.113.200";
    const a = (
      await app.inject({ method: "POST", url: "/session", remoteAddress: proxyIp, headers: { authorization: "Bearer pcc_live_ValidKeyA1", "x-forwarded-for": "1.1.1.1" } })
    ).json().session as string;
    expect((await say(app, a, "one")).json().stopped).toBeUndefined(); // exhausts the shared (proxy-keyed) address cap
    const b = (
      await app.inject({ method: "POST", url: "/session", remoteAddress: proxyIp, headers: { authorization: "Bearer pcc_live_ValidKeyB1", "x-forwarded-for": "2.2.2.2" } })
    ).json().session as string;
    expect((await say(app, b, "two")).json().stopped).toBe("per-address-day"); // wrongly shares the proxy's one cap
  });

  it("R2: fixed — with trustProxy hops=1, two different XFF clients behind one proxy address get SEPARATE address caps", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy], trustProxy: 1 });
    const proxyIp = "203.0.113.201";
    const a = (
      await app.inject({ method: "POST", url: "/session", remoteAddress: proxyIp, headers: { authorization: "Bearer pcc_live_ValidKeyA1", "x-forwarded-for": "3.3.3.3" } })
    ).json().session as string;
    expect((await say(app, a, "one")).json().stopped).toBeUndefined();
    const b = (
      await app.inject({ method: "POST", url: "/session", remoteAddress: proxyIp, headers: { authorization: "Bearer pcc_live_ValidKeyB1", "x-forwarded-for": "4.4.4.4" } })
    ).json().session as string;
    expect((await say(app, b, "two")).json().stopped).toBeUndefined(); // separate allowance
  });

  it("R2: with trustProxy hops=0, a client cannot buy a fresh allowance by sending a different X-Forwarded-For", async () => {
    const { app } = setup({ resolvePrincipal, caps: dayCap, maxTokens: 10_000, replies: [spendy, spendy], trustProxy: 0 });
    const clientIp = "203.0.113.202";
    const a = (
      await app.inject({ method: "POST", url: "/session", remoteAddress: clientIp, headers: { authorization: "Bearer pcc_live_ValidKeyA1", "x-forwarded-for": "5.5.5.5" } })
    ).json().session as string;
    expect((await say(app, a, "one")).json().stopped).toBeUndefined();
    const b = (
      await app.inject({ method: "POST", url: "/session", remoteAddress: clientIp, headers: { authorization: "Bearer pcc_live_ValidKeyB1", "x-forwarded-for": "6.6.6.6" } })
    ).json().session as string;
    expect((await say(app, b, "two")).json().stopped).toBe("per-address-day"); // XFF ignored: same real address, same cap
  });

  it("Q4-A: an anonymous session is still keyed by address and needs no resolution", async () => {
    const resolver = vi.fn(resolvePrincipal);
    const { app, db } = setup({ resolvePrincipal: resolver, replies: [text("hi")] });
    const id = (await openWith(app)).json().session as string;
    await say(app, id, "hi");
    expect(resolver).not.toHaveBeenCalled();
    const rows = db.prepare("SELECT user_key FROM hosted_agent_spend").all() as Array<{ user_key: string }>;
    for (const r of rows) expect(r.user_key).toMatch(/^anon:[0-9a-f]{32}$/);
  });

  it("Q4-A: the credential that resolved is the one forwarded to the transport, unchanged", async () => {
    const { app, connect } = setup({ resolvePrincipal });
    await openWith(app, "Bearer pcc_live_ValidKeyA1");
    expect(connect).toHaveBeenCalledWith("pcc_live_ValidKeyA1");
  });
});

describe("the gateway's pack is the pack that was pinned (Q5-A)", () => {
  it("Q5-A: a pack mismatch refuses the open with the generic error, and logs pack-mismatch server-side only", async () => {
    const { app, logs, transport } = setup({ reported: { version: `${PACK.version}+sha256.${"0".repeat(64)}` } });
    const res = await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "agent_unavailable" });
    expect(res.body).not.toMatch(/pack|sha256|2\.19\.1/i);
    expect(logs.join("\n")).toContain("pack-mismatch");
    expect(logs.join("\n")).not.toContain(KEY);
    expect(transport.closes).toBe(1);
  });

  it("Q5-A: a gateway that reports no version is refused the same way", async () => {
    const { app, logs } = setup({ reported: { version: undefined } });
    const res = await app.inject({ method: "POST", url: "/session" });
    expect(res.statusCode).toBe(502);
    expect(logs.join("\n")).toContain("pack-mismatch");
  });
});

describe("the pack-mismatch log never contains the reported string (Q1-B round 2)", () => {
  it("Q1-B: a credential-shaped reported version opens nothing (502), and the logs contain no pcc_live", async () => {
    const { app, logs } = setup({ reported: { version: "pcc_live_SyntheticCredential0001" } });
    const res = await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(502);
    const logged = logs.join("\n");
    expect(logged).toContain("pack-mismatch");
    expect(logged).not.toContain("pcc_live");
  });

  it("Q1-B: the log carries expected, reportedShape and a sha256 prefix, never the raw reported field", async () => {
    const { app, logs } = setup({ reported: { version: "pcc_live_SyntheticCredential0001" } });
    await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    const line = JSON.parse(logs.find((l) => l.includes("pack-mismatch"))!);
    expect(line.expected).toBe(`${PACK.version}+sha256.${PACK.sha256}`);
    expect(line.reportedShape).toBe("other");
    expect(line.reportedSha256Prefix).toMatch(/^[0-9a-f]{16}$/);
    expect(line).not.toHaveProperty("reported");
    expect(JSON.stringify(line)).not.toContain("pcc_live");
  });

  it.each([
    [undefined, "absent"],
    ["2.19.1", "bare-version"],
    [`${PACK.version}+sha256.${"0".repeat(64)}`, "version+sha256"],
    ["pcc_live_SyntheticCredential0002", "other"],
  ] as const)("Q1-B: reportedShape classifies %s as %s", async (reported, shape) => {
    const { app, logs } = setup({ reported: { version: reported } });
    await app.inject({ method: "POST", url: "/session", headers: { authorization: `Bearer ${KEY}` } });
    const line = JSON.parse(logs.find((l) => l.includes("pack-mismatch"))!);
    expect(line.reportedShape).toBe(shape);
    if (reported === undefined) expect(line.reportedSha256Prefix).toBeNull();
  });
});

describe("an old session cannot escape idle expiry (Q6-A)", () => {
  const unknown = { error: "unknown_session" };

  it("Q6-A: a session idle past the limit is refused on lookup, exactly like an unknown one, and is reported", async () => {
    const clock = { t: 1_000 };
    const { app, reports, transport } = setup({ clock, replies: [text("hi")] });
    const id = await open(app);
    clock.t += 60_001; // no other session is opened, so no sweep runs
    const res = await say(app, id, "hello");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(unknown);
    expect(res.json()).toEqual((await say(app, "nope", "hello")).json());
    expect(reports).toHaveLength(1);
    expect(transport.closes).toBe(1);
  });

  it.each([
    ["GET", "/session/pending"],
    ["POST", "/session/confirm"],
    ["POST", "/session/reject"],
    ["DELETE", "/session"],
  ] as const)("Q6-A: %s %s on an expired session answers the same as an unknown one", async (method, url) => {
    const clock = { t: 1_000 };
    const { app } = setup({ clock });
    const id = await open(app);
    clock.t += 60_001;
    const res = await app.inject({ method, url, headers: { "x-hosted-session": id }, payload: method === "POST" ? { token: "t" } : undefined });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(unknown);
  });

  it("Q6-A: an expired session is closed exactly once and is gone: a later sweep finds nothing to close", async () => {
    const clock = { t: 1_000 };
    const closing = vi.spyOn(HostedSession.prototype, "close");
    try {
      const { app } = setup({ clock });
      const id = await open(app);
      clock.t += 60_001;
      expect((await say(app, id, "hello")).statusCode).toBe(404);
      expect(closing).toHaveBeenCalledTimes(1);
      await open(app); // opening another session sweeps idle ones: the expired one must already be gone
      expect((await say(app, id, "again")).statusCode).toBe(404);
      expect(closing).toHaveBeenCalledTimes(1);
    } finally {
      closing.mockRestore();
    }
  });

  it("Q6-A: use within the limit keeps a session alive (each call refreshes it)", async () => {
    const clock = { t: 1_000 };
    const { app } = setup({ clock, replies: [text("a"), text("b"), text("c")] });
    const id = await open(app);
    for (let i = 0; i < 3; i++) {
      clock.t += 59_000;
      expect((await say(app, id, `m${i}`)).statusCode).toBe(200);
    }
  });

  it("Q6-A: a turn still in flight is not expired under its own feet", async () => {
    const clock = { t: 1_000 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app } = setup({ clock, create: async () => (await gate, text("slow")) });
    const id = await open(app);
    const first = say(app, id, "one");
    await new Promise((r) => setTimeout(r, 20));
    clock.t += 120_000;
    expect((await app.inject({ method: "GET", url: "/session/pending", headers: { "x-hosted-session": id } })).statusCode).toBe(200);
    release();
    expect((await first).statusCode).toBe(200);
  });

  it("B3 (round 4, 224b): a confirm still in flight is not expired under its own feet either", async () => {
    const clock = { t: 1_000 };
    let release!: () => void;
    const toolGate = new Promise<void>((r) => (release = r));
    const { app } = setup({ clock, replies: [toolUse("onboard_machine"), text("confirmed")], toolGate });
    const id = await open(app, KEY);
    const [held] = (await say(app, id, "register")).json().pending as Array<{ token: string }>;
    const inFlightConfirm = confirmCall(app, id, held!.token);
    await new Promise((r) => setTimeout(r, 20));
    clock.t += 120_000;
    expect((await app.inject({ method: "GET", url: "/session/pending", headers: { "x-hosted-session": id } })).statusCode).toBe(200);
    release();
    expect((await inFlightConfirm).statusCode).toBe(200);
  });
});

describe("an outcome that arrives during a message reaches the model (Q6-B, over HTTP)", () => {
  it("Q6-B: hold the model response, confirm over HTTP, release; the next message tells the model the outcome", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const queue: Array<() => Promise<unknown>> = [
      async () => toolUse("onboard_machine"),
      async () => text("confirm?"),
      async () => (await hold, text("answer")),
      async () => text("noted"),
    ];
    const { app, create } = setup({ create: async () => queue.shift()!() });
    const id = await open(app, KEY);
    const [held] = (await say(app, id, "register")).json().pending as Array<{ token: string }>;
    const inFlight = say(app, id, "a question");
    await new Promise((r) => setTimeout(r, 20));
    expect((await confirmCall(app, id, held!.token)).statusCode).toBe(200); // not blocked behind the message
    release();
    expect((await inFlight).statusCode).toBe(200);
    await say(app, id, "thanks");
    expect(JSON.stringify(create.mock.calls.at(-1))).toContain("The user confirmed onboard_machine");
  });
});
