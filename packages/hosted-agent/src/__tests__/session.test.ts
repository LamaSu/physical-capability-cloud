import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { BudgetMeter, type BudgetCaps, type MessagesClient, type ModelPrice } from "../budget.js";
import type { PinnedPack } from "../pack.js";
import type { ToolTransport } from "../tools.js";
import { HostedSession, HOSTED_PREAMBLE, type AttemptReport, type SessionDeps } from "../session.js";

const CREDENTIAL = "pcc_live_UsersOwnKeyNeverLeaves42";
const PRICE: ModelPrice = { input: 3_000, output: 15_000 };
const USD = 1_000_000_000;

const tool = (name: string, method: string, path: string) => ({
  def: { name, description: name, input_schema: { type: "object" as const } },
  spec: { name, method, path },
});
const PACK: PinnedPack = {
  version: "2.19.1",
  sha256: "a".repeat(64),
  systemPrompt: "PACK SYSTEM PROMPT",
  tools: [
    tool("list_open_jobs", "GET", "/api/job-offers/open"),
    tool("onboard_machine", "POST", "/api/onboard/register"),
    tool("create_capability", "POST", "/api/capabilities"), // L2
    tool("provision_api_key", "POST", "/api/auth/provision"), // never
  ],
};

type Req = { system?: string; tools: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };

function harness(opts: { caps?: BudgetCaps; replies?: unknown[]; served?: string[] } = {}) {
  const requests: Req[] = [];
  const replies = [...(opts.replies ?? [])];
  const create = vi.fn(async (req: Req) => {
    requests.push(JSON.parse(JSON.stringify(req)) as Req);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("test: no scripted reply");
    return next;
  });
  const calls: Array<[string, Record<string, unknown>]> = [];
  const transport: ToolTransport & { closed: boolean } = {
    closed: false,
    listTools: async () => [...(opts.served ?? PACK.tools.map((t) => t.def.name)), "delete_preview"],
    callTool: async (name, args) => (calls.push([name, args]), { ok: true, tool: name }),
    close: async () => void (transport.closed = true),
  };
  const connect = vi.fn(async (_credential: string | null) => transport);
  const reports: AttemptReport[] = [];
  const deps: SessionDeps = {
    pack: PACK,
    meter: new BudgetMeter(new Database(":memory:"), opts.caps ?? { perSession: USD, perUserDay: USD, perMonth: USD }, () => new Date("2026-10-06T12:00:00Z"), () => false),
    price: PRICE,
    model: "claude-test",
    anthropic: { messages: { create } } as unknown as MessagesClient,
    connect,
    l2Enabled: false,
    report: (r) => void reports.push(r),
  };
  return { deps, requests, create, calls, transport, connect, reports };
}

const text = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 10, output_tokens: 5 } });
const toolUse = (name: string, input: unknown) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: `tu-${name}`, name, input }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("a hosted session", () => {
  it("the credential goes only to the transport: never to the model, never into the report", async () => {
    const h = harness({ replies: [text("hello")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: CREDENTIAL });
    expect(h.connect).toHaveBeenCalledWith(CREDENTIAL);
    await s.send("hi");
    const { report } = await s.close();
    expect(JSON.stringify(h.requests)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(report)).not.toContain(CREDENTIAL);
    // The report's sessionId is its own UUID, never the session id (a bearer capability).
    expect(report.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(report.sessionId).not.toBe(s.id);
    expect(JSON.stringify(report)).not.toContain(s.id);
  });

  it("the model gets the preamble and the pack prompt, and only the tools the policy offers", async () => {
    const h = harness({ replies: [text("ok")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: null });
    await s.send("hi");
    expect(h.requests[0]!.system).toBe(`${HOSTED_PREAMBLE}\n\nPACK SYSTEM PROMPT`);
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["list_open_jobs", "onboard_machine"]);
  });

  it("a write is held; the user's confirmation runs it once, and the model hears the outcome next turn", async () => {
    const h = harness({
      replies: [toolUse("onboard_machine", { name: "plate reader" }), text("Please confirm the registration."), text("Registered.")],
    });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: CREDENTIAL });
    const turn = await s.send("register my plate reader");
    expect(turn.reply).toBe("Please confirm the registration.");
    expect(h.calls).toEqual([]);
    expect(turn.pending.map((p) => p.tool)).toEqual(["onboard_machine"]);
    await s.confirm(turn.pending[0]!.token);
    expect(h.calls).toEqual([["onboard_machine", { name: "plate reader" }]]);
    await s.send("thanks");
    const last = h.requests[2]!;
    const lastUser = last.messages[last.messages.length - 1]!;
    expect(String(lastUser.content)).toMatch(/^\(The user confirmed onboard_machine\. It returned: .*"tool":"onboard_machine".*\)\n\nthanks$/s);
    expect(last.messages.length).toBeGreaterThan(h.requests[0]!.messages.length); // the history carried over
    expect(s.pending()).toEqual([]);
  });

  it("the outcome note is told once: a later turn does not repeat it", async () => {
    const h = harness({ replies: [toolUse("onboard_machine", {}), text("Confirm?"), text("Done."), text("Next.")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: CREDENTIAL });
    const turn = await s.send("register");
    await s.confirm(turn.pending[0]!.token);
    await s.send("thanks");
    await s.send("what next?");
    expect(String(h.requests[3]!.messages.at(-1)!.content)).toBe("what next?");
  });

  it("the outcome note is scrubbed even when the transport returns a secret", async () => {
    const h = harness({ replies: [toolUse("onboard_machine", {}), text("Confirm?"), text("Done.")] });
    h.transport.callTool = async () => ({ registered: true, apiKey: "pcc_live_LeakedByATransport99" });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: null });
    const turn = await s.send("register");
    await s.confirm(turn.pending[0]!.token);
    await s.send("thanks");
    const told = String(h.requests[2]!.messages.at(-1)!.content);
    expect(told).toContain('"registered":true');
    expect(told).not.toContain("pcc_live_");
  });

  it("a declined write never runs, and the model is told", async () => {
    const h = harness({ replies: [toolUse("onboard_machine", {}), text("Confirm?"), text("OK, not registering.")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: CREDENTIAL });
    const turn = await s.send("register");
    s.reject(turn.pending[0]!.token);
    await s.send("never mind");
    expect(h.calls).toEqual([]);
    const last = h.requests[2]!.messages.at(-1)!;
    expect(String(last.content)).toContain("(The user declined onboard_machine.)");
  });

  it("a budget stop ends the turn without calling the model, and the report says so", async () => {
    const h = harness({ caps: { perSession: 1, perUserDay: USD, perMonth: USD }, replies: [text("never")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: null });
    const turn = await s.send("hi");
    expect(turn.stopped).toBe("per-session");
    expect(h.create).not.toHaveBeenCalled();
    const closed = await s.close();
    expect(closed.report).toMatchObject({
      kind: "attempt",
      contract: 1,
      seq: 0,
      phase: "session",
      outcome: "budget_stop",
      summary: "session: budget_stop",
      harness: { name: "pcc-hosted", model: "claude-test" },
      pack: { version: "2.19.1", digest: `sha256:${"a".repeat(64)}` },
      tokens: { in: 0, out: 0, source: "metered" },
      consent: { transcript: false },
    });
    expect(closed.turns).toBe(0);
    expect(h.reports).toEqual([closed.report]);
    expect(h.transport.closed).toBe(true);
  });

  it("a failed turn leaves the history as it was", async () => {
    const h = harness({ replies: [text("first"), new Error("upstream down"), text("third")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: null });
    await s.send("one");
    await expect(s.send("two")).rejects.toThrow("upstream down");
    await s.send("three");
    expect(h.requests[2]!.messages.map((m) => m.content)).toEqual(["one", h.requests[2]!.messages[1]!.content, "three"]);
    const closed = await s.close();
    expect(closed.report.outcome).toBe("failed");
    expect(closed.turns).toBe(2);
    expect(closed.spentNanoUsd).toBeGreaterThan(0);
    expect(closed.report.tokens).toEqual({ in: 20, out: 10, source: "metered" });
  });

  it("only the pinned tools the connected surface serves are offered", async () => {
    const h = harness({ replies: [text("ok")], served: ["list_open_jobs"] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: null });
    await s.send("hi");
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["list_open_jobs"]);
  });

  it("a tool name LLMAgent reserves is dropped, not fatal", async () => {
    const h = harness({ replies: [text("ok")] });
    const reserved = { ...h.deps, pack: { ...PACK, tools: [...PACK.tools, tool("delete_preview", "GET", "/api/preview")] } };
    const s = await HostedSession.open(reserved, { userKey: "user:alice", credential: null });
    await s.send("hi");
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["list_open_jobs", "onboard_machine"]);
  });

  it("a closed session refuses further use", async () => {
    const h = harness({ replies: [] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", credential: null });
    await s.close();
    await expect(s.send("hi")).rejects.toThrow(/closed/);
    await expect(s.close()).rejects.toThrow(/closed/);
  });
});
