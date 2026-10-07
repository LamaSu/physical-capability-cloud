import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BudgetMeter, type BudgetCaps, type MessagesClient, type ModelPrice } from "../budget.js";
import { loadPinnedPack, type PinnedPack } from "../pack.js";
import type { ToolTransport } from "../tools.js";
import { DEFAULT_TOOL_POLICY, type ToolPolicy } from "../policy.js";
import { HostedSession, HOSTED_PREAMBLE, type AttemptReport, type SessionDeps } from "../session.js";

const here = dirname(fileURLToPath(import.meta.url));
const REAL_BYTES = new Uint8Array(readFileSync(resolve(here, "../../../../apps/dashboard/public/agent-package.json")));
/** The real pinned agent package, loaded exactly as the service loads it. */
async function realPack(): Promise<PinnedPack> {
  const version = (JSON.parse(new TextDecoder().decode(REAL_BYTES)) as { version: string }).version;
  return loadPinnedPack(async () => REAL_BYTES, { version, sha256: createHash("sha256").update(REAL_BYTES).digest("hex") });
}
/** What a gateway running exactly this pack reports as its server version. */
const versionOf = (p: PinnedPack): string => `${p.version}+sha256.${p.sha256}`;

const CREDENTIAL = "pcc_live_UsersOwnKeyNeverLeaves42";
const PRICE: ModelPrice = { input: 3_000, output: 15_000 };
const USD = 1_000_000_000;

const tool = (name: string, method: string, path: string) => ({
  def: { name, description: name, input_schema: { type: "object" as const } },
  spec: { name, method, path },
});
/** Round 5 (239): TOOL_ALLOWLIST replaced the old read/write/l2/never name
 * sets. These tests exercise the SESSION's mechanics (confirmation, scrub,
 * outcome notes), not the real-world table (policy.test.ts owns that), so
 * they get their own small policy naming exactly this file's synthetic pack
 * tools -- a generous OutputSpec that does not interfere with what each test
 * actually asserts (the scrub/projection pipeline itself is tools.test.ts'). */
const TEST_FIELDS = {
  ok: { type: "boolean" as const },
  tool: { type: "string" as const, maxLength: 200 },
  registered: { type: "boolean" as const },
  apiKey: { type: "string" as const, maxLength: 200 },
  note: { type: "string" as const, maxLength: 200 },
  token: { type: "string" as const, maxLength: 200 },
};
const TEST_POLICY: ToolPolicy = {
  allowlist: new Map([
    ["list_jobs", { level: "read", reason: "test fixture", output: TEST_FIELDS }],
    ["onboard_machine", { level: "write", reason: "test fixture", output: TEST_FIELDS }],
    ["create_capability", { level: "l2", reason: "test fixture", output: TEST_FIELDS }],
    ["get_dashboard", { level: "write", reason: "test fixture", output: TEST_FIELDS }],
  ]),
  never: new Set(["provision_api_key", "setup_test_job"]),
};

const PACK: PinnedPack = {
  version: "2.19.1",
  sha256: "a".repeat(64),
  systemPrompt: "PACK SYSTEM PROMPT",
  tools: [
    tool("list_jobs", "GET", "/api/jobs"),
    tool("onboard_machine", "POST", "/api/onboard/register"),
    tool("create_capability", "POST", "/api/capabilities"), // L2
    tool("provision_api_key", "POST", "/api/auth/provision"), // never
  ],
};

type Req = { system?: string; tools: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };

function harness(
  opts: {
    caps?: BudgetCaps;
    replies?: unknown[];
    served?: string[];
    pack?: PinnedPack;
    reported?: { version: string | undefined };
    toolResult?: unknown;
    packTools?: SessionDeps["packTools"];
    policy?: ToolPolicy;
  } = {},
) {
  const pack = opts.pack ?? PACK;
  const requests: Req[] = [];
  const replies = [...(opts.replies ?? [])];
  const create = vi.fn(async (req: Req) => {
    requests.push(JSON.parse(JSON.stringify(req)) as Req);
    let next = replies.shift();
    if (typeof next === "function") next = await (next as () => Promise<unknown>)();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("test: no scripted reply");
    return next;
  });
  const calls: Array<[string, Record<string, unknown>]> = [];
  const transport: ToolTransport & { closed: boolean } = {
    closed: false,
    serverVersion: () => (opts.reported ? opts.reported.version : versionOf(pack)),
    listTools: async () => [...(opts.served ?? pack.tools.map((t) => t.def.name)), "delete_preview"],
    callTool: async (name, args) => (calls.push([name, args]), opts.toolResult ?? { ok: true, tool: name }),
    close: async () => void (transport.closed = true),
  };
  const connect = vi.fn(async (_credential: string | null) => transport);
  const reports: AttemptReport[] = [];
  const deps: SessionDeps = {
    pack,
    meter: new BudgetMeter(new Database(":memory:"), opts.caps ?? { perSession: USD, perUserDay: USD, perMonth: USD }, () => new Date("2026-10-06T12:00:00Z"), () => false),
    price: PRICE,
    model: "claude-test",
    anthropic: { messages: { create } } as unknown as MessagesClient,
    connect,
    l2Enabled: false,
    report: (r) => void reports.push(r),
    policy: opts.policy ?? TEST_POLICY,
    ...(opts.packTools ? { packTools: opts.packTools } : {}),
  };
  return { deps, requests, create, calls, transport, connect, reports };
}

const text = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 10, output_tokens: 5 } });
// A model's tool_use ids are unique within a conversation; so are the scripted ones.
let toolUseCount = 0;
const toolUse = (name: string, input: unknown) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: `tu-${name}-${++toolUseCount}`, name, input }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("a hosted session", () => {
  it("the credential goes only to the transport: never to the model, never into the report", async () => {
    const h = harness({ replies: [text("hello")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
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
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    await s.send("hi");
    expect(h.requests[0]!.system).toBe(`${HOSTED_PREAMBLE}\n\nPACK SYSTEM PROMPT`);
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["list_jobs", "onboard_machine"]);
  });

  it("a write is held; the user's confirmation runs it once, and the model hears the outcome next turn", async () => {
    const h = harness({
      replies: [toolUse("onboard_machine", { name: "plate reader" }), text("Please confirm the registration."), text("Registered.")],
    });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
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
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const turn = await s.send("register");
    await s.confirm(turn.pending[0]!.token);
    await s.send("thanks");
    await s.send("what next?");
    expect(String(h.requests[3]!.messages.at(-1)!.content)).toBe("what next?");
  });

  it("the outcome note is scrubbed even when the transport returns a secret", async () => {
    const h = harness({ replies: [toolUse("onboard_machine", {}), text("Confirm?"), text("Done.")] });
    h.transport.callTool = async () => ({ registered: true, apiKey: "pcc_live_LeakedByATransport99" });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    const turn = await s.send("register");
    await s.confirm(turn.pending[0]!.token);
    await s.send("thanks");
    const told = String(h.requests[2]!.messages.at(-1)!.content);
    expect(told).toContain('"registered":true');
    expect(told).not.toContain("pcc_live_");
  });

  it("a declined write never runs, and the model is told", async () => {
    const h = harness({ replies: [toolUse("onboard_machine", {}), text("Confirm?"), text("OK, not registering.")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const turn = await s.send("register");
    s.reject(turn.pending[0]!.token);
    await s.send("never mind");
    expect(h.calls).toEqual([]);
    const last = h.requests[2]!.messages.at(-1)!;
    expect(String(last.content)).toContain("(The user declined onboard_machine.)");
  });

  it("a budget stop ends the turn without calling the model, and the report says so", async () => {
    const h = harness({ caps: { perSession: 1, perUserDay: USD, perMonth: USD }, replies: [text("never")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
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
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
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
    const h = harness({ replies: [text("ok")], served: ["list_jobs"] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    await s.send("hi");
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["list_jobs"]);
  });

  it("a tool name LLMAgent reserves is dropped, not fatal", async () => {
    const h = harness({ replies: [text("ok")] });
    const reserved = { ...h.deps, pack: { ...PACK, tools: [...PACK.tools, tool("delete_preview", "GET", "/api/preview")] } };
    const s = await HostedSession.open(reserved, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    await s.send("hi");
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["list_jobs", "onboard_machine"]);
  });

  it("a closed session refuses further use", async () => {
    const h = harness({ replies: [] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    await s.close();
    await expect(s.send("hi")).rejects.toThrow(/closed/);
    await expect(s.close()).rejects.toThrow(/closed/);
  });
});

describe("a failing or leaking tool never reaches the model or the caller unscrubbed (Q1-A, Q1-C, Q3-B)", () => {
  it("Q1-A: a read tool whose transport throws a secret-bearing error: the next model request carries no secret", async () => {
    const h = harness({ replies: [toolUse("list_jobs", {}), text("It failed.")] });
    h.transport.callTool = async () => {
      throw new Error("rejected pcc_live_abcdefgh12345678");
    };
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    await s.send("list my jobs");
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests)).not.toContain("pcc_live_abcdefgh12345678");
    // P1 (round 5, 239): the model learns only a CLOSED category, never the
    // error's own message text -- "rejected" (the upstream wording) must be
    // as absent as the secret; only "tool_failed" (no recognizable status
    // on a plain thrown Error) may appear.
    const result = (h.requests[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>)[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).not.toContain("rejected");
    expect(JSON.parse(result.content)).toEqual({ error: "tool_failed" });
  });

  it("Q1-C: the confirmation's result is scrubbed whatever the transport returns", async () => {
    const h = harness({ replies: [toolUse("onboard_machine", {}), text("Confirm?")] });
    h.transport.callTool = async () => ({ registered: true, apiKey: "pcc_live_LeakedByATransport99", note: "Bearer abcdefgh12345678" });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    const turn = await s.send("register");
    const out = await s.confirm(turn.pending[0]!.token);
    expect(JSON.stringify(out)).toContain('"registered":true');
    expect(JSON.stringify(out)).not.toMatch(/pcc_live_|Bearer\s/);
  });

  it("Q3-B: a token in a confirmed result reaches neither the confirmation nor the next model request", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.synthetic.signature";
    const h = harness({ replies: [toolUse("onboard_machine", {}), text("Confirm?"), text("Done.")] });
    h.transport.callTool = async () => ({ token: jwt });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    const turn = await s.send("register");
    const out = await s.confirm(turn.pending[0]!.token);
    expect(JSON.stringify(out)).not.toContain("eyJ");
    await s.send("thanks");
    expect(JSON.stringify(h.requests)).not.toContain("eyJ");
    expect(JSON.stringify(h.requests.at(-1)!.messages.at(-1))).toContain("The user confirmed onboard_machine");
  });
});

describe("the hosted agent never actuates a device or provisions a credential (Q3-A, Q3-B)", () => {
  it("Q3-A: setup_test_job, which runs a job on a device, is never offered or run, with L2 off", async () => {
    const pack = await realPack();
    const h = harness({ pack, replies: [toolUse("setup_test_job", { kernelId: "k1", deviceId: "d1" }), text("I cannot run device jobs.")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const turn = await s.send("run a test job on my device");
    for (const held of turn.pending) await s.confirm(held.token).catch(() => undefined);
    expect.soft(h.requests[0]!.tools.map((t) => t.name)).not.toContain("setup_test_job");
    expect.soft(turn.pending.map((p) => p.tool)).not.toContain("setup_test_job");
    expect(h.calls.map(([n]) => n)).not.toContain("setup_test_job"); // the dispatch spy: it never ran
  });

  it("Q3-B: redeem_invite, which returns a session token and wallet material, is never offered or run", async () => {
    const pack = await realPack();
    const h = harness({ pack, replies: [toolUse("redeem_invite", { code: "c", password: "p" }), text("I cannot redeem invites.")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const turn = await s.send("redeem my invite");
    for (const held of turn.pending) await s.confirm(held.token).catch(() => undefined);
    expect.soft(h.requests[0]!.tools.map((t) => t.name)).not.toContain("redeem_invite");
    expect(h.calls.map(([n]) => n)).not.toContain("redeem_invite");
  });
});

describe("a GET is a read only when it is reviewed to write nothing (Q3-C)", () => {
  it("Q3-C: get_dashboard on a signed-in session (the full /mcp surface) is held, not run: there it bumps loadCount", async () => {
    const pack = await realPack();
    const h = harness({ pack, replies: [toolUse("get_dashboard", { idOrSlug: "d1" }), text("Please confirm.")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const turn = await s.send("show my dashboard");
    expect(h.calls).toEqual([]);
    expect(turn.pending.map((p) => p.tool)).toEqual(["get_dashboard"]);
    await s.confirm(turn.pending[0]!.token);
    expect(h.calls).toEqual([["get_dashboard", { idOrSlug: "d1" }]]);
  });

  it("Q3-C: a listed passive read still runs directly, with nothing held", async () => {
    const pack = await realPack();
    const h = harness({ pack, replies: [toolUse("list_capability_types", {}), text("Here they are.")], policy: DEFAULT_TOOL_POLICY });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const turn = await s.send("what capability types exist?");
    expect(h.calls).toEqual([["list_capability_types", {}]]);
    expect(turn.pending).toEqual([]);
  });
});

describe("the pack the gateway runs is the pack that was pinned (Q5-A)", () => {
  const A: PinnedPack = { version: "2.19.1", sha256: "a".repeat(64), systemPrompt: "A", tools: [{ def: { name: "list_jobs", description: "", input_schema: { type: "object" } }, spec: { name: "list_jobs", method: "GET", path: "/api/jobs" } }] };
  const B = { version: "2.19.1", sha256: "b".repeat(64) };

  it("Q5-A: a gateway running a pack other than the pinned one is refused before any tool is listed or offered, even when a tool name matches", async () => {
    const h = harness({ pack: A, replies: [toolUse("list_jobs", {}), text("never")], reported: { version: versionOf(B as PinnedPack) } });
    const listed = vi.spyOn(h.transport, "listTools");
    await expect(HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL })).rejects.toThrow(/pack/i);
    expect(listed).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.transport.closed).toBe(true);
  });

  it.each([
    ["no version at all", undefined],
    ["the bare pack version, without the digest", "2.19.1"],
    ["the right version with another digest", `2.19.1+sha256.${"b".repeat(64)}`],
    ["the right digest under another version", `2.19.2+sha256.${"a".repeat(64)}`],
    ["an uppercase digest", `2.19.1+sha256.${"A".repeat(64)}`],
    ["extra text after the digest", `2.19.1+sha256.${"a".repeat(64)}.x`],
  ])("Q5-A: %s is refused", async (_name, reported) => {
    const h = harness({ pack: A, reported: { version: reported } });
    await expect(HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null })).rejects.toThrow(/pack/i);
    expect(h.transport.closed).toBe(true);
  });

  it("Q5-A: the exact pinned version and digest opens", async () => {
    const h = harness({ pack: A, reported: { version: `2.19.1+sha256.${"a".repeat(64)}` }, replies: [text("ok")] });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    await s.send("hi");
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["list_jobs"]);
  });
});

describe("a session that fails to open leaves nothing open (Q1-B)", () => {
  it("Q1-B: when listing tools fails, the transport is closed", async () => {
    const h = harness();
    h.transport.listTools = async () => {
      throw new Error("upstream down");
    };
    await expect(HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL })).rejects.toThrow("upstream down");
    expect(h.transport.closed).toBe(true);
  });
});

describe("an outcome that arrives mid-message is never lost (Q6-B)", () => {
  it("Q6-B: confirm while a message is in flight; the outcome reaches the model on the next message", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const h = harness({
      replies: [
        toolUse("onboard_machine", {}),
        text("Please confirm."),
        async () => (await hold, text("Answer.")),
        text("Noted."),
        text("Later."),
      ],
    });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const first = await s.send("register");
    const inFlight = s.send("one more question"); // blocked inside the model call
    await new Promise((r) => setTimeout(r, 10));
    await s.confirm(first.pending[0]!.token); // the user confirms meanwhile
    release();
    await inFlight;
    await s.send("thanks");
    expect(String(h.requests.at(-1)!.messages.at(-1)!.content)).toContain("(The user confirmed onboard_machine.");
    // told once: the message after that does not repeat it
    await s.send("and then?");
    expect(String(h.requests.at(-1)!.messages.at(-1)!.content)).toBe("and then?");
  });

  it("Q6-B: a decline that arrives mid-message is kept too, and only the notes a message captured are cleared", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const h = harness({
      replies: [
        toolUse("onboard_machine", { n: 1 }),
        text("Confirm 1?"),
        toolUse("onboard_machine", { n: 2 }),
        text("Confirm 2?"),
        async () => (await hold, text("Answer.")),
        text("Noted."),
      ],
    });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: CREDENTIAL });
    const one = await s.send("register one");
    s.reject(one.pending[0]!.token); // note 1: told to the NEXT message (the one that starts below)
    const two = await s.send("register two"); // captures note 1, completes, clears note 1
    const inFlight = s.send("question"); // captures nothing
    await new Promise((r) => setTimeout(r, 10));
    s.reject(two.pending[0]!.token); // note 2 arrives mid-flight
    release();
    await inFlight;
    await s.send("thanks");
    const told = String(h.requests.at(-1)!.messages.at(-1)!.content);
    expect(told).toContain("(The user declined onboard_machine.)");
    expect(told.endsWith("thanks")).toBe(true);
  });
});

describe("the confirmation scrub is independently mutation-locked (Q7)", () => {
  it("Q7: HostedSession.confirm's OWN scrub catches a secret even when packTools' scrub layer is bypassed", async () => {
    // Full-stack confirmation tests (tools.test.ts, server.test.ts) always go through the
    // REAL packTools, whose caller scrubs first (tools.ts:163) — so removing the SECOND
    // scrub, in session.ts confirm, is masked: the value already arrives clean. This test
    // injects at the SessionDeps.packTools seam added for exactly this: a caller that
    // returns the transport's result UNscrubbed, as if packTools' own scrub were absent.
    // HostedSession.confirm's own scrub is then the ONLY thing standing between the secret
    // and the confirmation response / the next model request.
    const bypassPackTools: NonNullable<SessionDeps["packTools"]> = (pack, transport, served) =>
      pack.tools
        .filter(({ def }) => served.has(def.name))
        .map(({ def, spec }) => ({
          def,
          spec,
          caller: (input: unknown) => transport.callTool(def.name, input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}),
        }));
    const h = harness({
      replies: [toolUse("onboard_machine", { a: 1 }), text("confirm?"), text("ok")],
      toolResult: { apiKey: "pcc_live_UnscrubbedByPackTools99" },
      packTools: bypassPackTools,
    });
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    const turn = await s.send("register");
    const [held] = turn.pending;
    const result = await s.confirm(held!.token);
    expect(JSON.stringify(result)).not.toContain("pcc_live_");
    expect(JSON.stringify(result)).toContain("[redacted]");
    await s.send("thanks"); // the outcome note (built from the SAME scrubbed result) reaches the model next turn
    expect(JSON.stringify(h.requests.at(-1))).not.toContain("pcc_live_");
  });
});

describe("an overrun stops the payer for the day (Q4-B, at the session)", () => {
  it("Q4-B: a payer whose earlier call overran is stopped with the overrun reason, the model is not called, and the report says budget_stop", async () => {
    const h = harness({ replies: [text("never")] });
    const payer = { sessionId: "earlier-session", userKey: "user:alice", addressKey: "addr:alice" };
    h.deps.meter.settle(h.deps.meter.reserve(payer, 1_000), 1_001); // an earlier call cost more than it reserved
    const s = await HostedSession.open(h.deps, { userKey: "user:alice", addressKey: "addr:alice", credential: null });
    const turn = await s.send("hi");
    expect(turn.stopped).toBe("overrun");
    expect(turn.reply).toMatch(/tomorrow/);
    expect(turn.reply).not.toMatch(/spending limit/);
    expect(h.create).not.toHaveBeenCalled();
    expect((await s.close()).report.outcome).toBe("budget_stop");
  });
});
