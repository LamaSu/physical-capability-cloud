import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { BudgetMeter, type MessagesClient } from "../budget.js";
import type { PinnedPack } from "../pack.js";
import type { ToolTransport } from "../tools.js";
import { buildServer } from "../server.js";
import type { SessionDeps } from "../session.js";

const KEY = "pcc_live_ServerTestKey0001";
const USD = 1_000_000_000;
const PACK: PinnedPack = {
  version: "2.19.1",
  sha256: "b".repeat(64),
  systemPrompt: "P",
  tools: [{ def: { name: "onboard_machine", description: "", input_schema: { type: "object" } }, spec: { name: "onboard_machine", method: "POST", path: "/api/onboard/register" } }],
};
const text = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 1, output_tokens: 1 } });
const toolUse = (name: string) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu", name, input: { a: 1 } }], usage: { input_tokens: 1, output_tokens: 1 } });

function setup(o: { replies?: unknown[]; create?: (req: unknown) => Promise<unknown>; maxTurns?: number; clock?: { t: number }; failTool?: string } = {}) {
  const replies = [...(o.replies ?? [])];
  const create = vi.fn(o.create ?? (async () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r ?? text("(default)");
  }));
  const calls: string[] = [];
  const transport: ToolTransport = {
    listTools: async () => PACK.tools.map((t) => t.def.name),
    callTool: async (n) => {
      if (o.failTool) throw new Error(o.failTool);
      calls.push(n);
      return { ok: true };
    },
    close: async () => {},
  };
  const connect = vi.fn(async (_c: string | null) => transport);
  const reports: unknown[] = [];
  const clock = o.clock ?? { t: 1_000 };
  const db = new Database(":memory:");
  const deps: SessionDeps = {
    pack: PACK,
    meter: new BudgetMeter(db, { perSession: USD, perUserDay: USD, perMonth: USD }, () => new Date("2026-10-06T00:00:00Z"), () => false),
    price: { input: 1, output: 1 },
    model: "m",
    anthropic: { messages: { create } } as unknown as MessagesClient,
    connect,
    l2Enabled: false,
    report: (r) => void reports.push(r),
    now: () => clock.t,
  };
  const app = buildServer({ deps, maxTurns: o.maxTurns, idleMs: 60_000, now: () => clock.t });
  return { app, connect, calls, reports, create, clock, db };
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

  it("the spend ledger keys a signed-in user by a digest, never by the raw key", async () => {
    const { app, db } = setup({ replies: [text("hi")] });
    const id = await open(app, KEY);
    await say(app, id, "hello");
    const rows = db.prepare("SELECT user_key FROM hosted_agent_spend").all() as Array<{ user_key: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.user_key).toMatch(/^key:[0-9a-f]{32}$/);
      expect(r.user_key).not.toContain(KEY);
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
