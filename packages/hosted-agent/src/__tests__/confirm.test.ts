import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { LLMAgent } from "@pcc/agent-runtime";
import { ConfirmationGate, ConfirmationRefused, classify, type GatedTool } from "../confirm.js";

function tool(name: string, method: string, path: string, caller = vi.fn(async (input: unknown) => ({ ran: name, input }))): GatedTool {
  return { def: { name, description: name, input_schema: { type: "object" } }, spec: { name, method, path }, caller };
}

const READ = tool("list_open_jobs", "GET", "/api/job-offers/open");
const WRITE = tool("register_machine", "POST", "/api/onboard/register");
const CLAIM = tool("claim_job", "POST", "/api/job-offers/:id/claim");
const ESTOP = tool("emergency_stop", "POST", "/api/operator/emergency-stop");

describe("classification comes from the pinned package's method and path", () => {
  it.each([
    [READ, "read"],
    [tool("h", "HEAD", "/api/x"), "read"],
    [WRITE, "write"],
    [tool("d", "DELETE", "/api/listings/:id"), "write"],
    [CLAIM, "l2"],
    [ESTOP, "l2"],
    [tool("p", "PUT", "/api/kernels/:id/pricing"), "l2"],
    [tool("w", "POST", "/api/wallet/transfer"), "l2"],
    [tool("s", "POST", "/api/escrow/:id/settle"), "l2"],
    [tool("pol", "PATCH", "/api/operator/policy"), "l2"],
  ] as const)("%# %s", (t, level) => {
    expect(classify(t.spec)).toBe(level);
  });

  it("a GET is a read even when its path looks like money: reads never move anything", () => {
    expect(classify({ name: "x", method: "get", path: "/api/escrow/status" })).toBe("read");
  });
});

describe("what the model is offered", () => {
  it("L2 tools are absent while the flag is off, and held when it is on", async () => {
    const gate = new ConfirmationGate();
    const off = gate.forSession("s1", [READ, WRITE, CLAIM, ESTOP], { l2Enabled: false });
    expect(off.defs.map((d) => d.name)).toEqual(["list_open_jobs", "register_machine"]);
    expect(Object.keys(off.callers).sort()).toEqual(["list_open_jobs", "register_machine"]);

    const on = gate.forSession("s1", [READ, WRITE, CLAIM], { l2Enabled: true });
    expect(on.defs.map((d) => d.name)).toContain("claim_job");
    const held = await on.callers["claim_job"]!({ id: "job-1", kernelId: "k1" });
    expect(held).toMatchObject({ status: "held_for_user_confirmation" });
    expect(CLAIM.caller).not.toHaveBeenCalled();
  });

  it("a read runs at once; a write is held and not run", async () => {
    const r = tool("r", "GET", "/api/x");
    const w = tool("w", "POST", "/api/y");
    const { callers } = new ConfirmationGate().forSession("s1", [r, w], { l2Enabled: false });
    await callers["r"]!({ q: 1 });
    expect(r.caller).toHaveBeenCalledTimes(1);
    const out = await callers["w"]!({ a: 1 });
    expect(w.caller).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/token/i); // the model never sees the token
  });
});

describe("confirming", () => {
  function setup(now = { t: 1_000 }) {
    const w = tool("w", "POST", "/api/y");
    const gate = new ConfirmationGate({ ttlMs: 60_000, now: () => now.t });
    const { callers } = gate.forSession("s1", [w], { l2Enabled: false });
    return { gate, w, callers, now };
  }

  it("runs exactly the held arguments, once", async () => {
    const { gate, w, callers } = setup();
    const input = { amount: "5", nested: { to: "k1" } };
    await callers["w"]!(input);
    input.nested.to = "k2"; // a later change to the model's object does not reach the held call
    const [held] = gate.pending("s1");
    expect(held!.input).toEqual({ amount: "5", nested: { to: "k1" } });
    await gate.confirm("s1", held!.token);
    expect(w.caller).toHaveBeenCalledTimes(1);
    expect(w.caller).toHaveBeenCalledWith({ amount: "5", nested: { to: "k1" } });
    await expect(gate.confirm("s1", held!.token)).rejects.toThrow(ConfirmationRefused);
    expect(w.caller).toHaveBeenCalledTimes(1);
  });

  it("two confirmations racing run the call once", async () => {
    const { gate, w, callers } = setup();
    await callers["w"]!({ a: 1 });
    const [held] = gate.pending("s1");
    const results = await Promise.allSettled([gate.confirm("s1", held!.token), gate.confirm("s1", held!.token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(w.caller).toHaveBeenCalledTimes(1);
  });

  it("another session cannot confirm or consume it", async () => {
    const { gate, w, callers } = setup();
    await callers["w"]!({ a: 1 });
    const [held] = gate.pending("s1");
    await expect(gate.confirm("s2", held!.token)).rejects.toThrow(/other-session/);
    expect(gate.pending("s2")).toEqual([]);
    await gate.confirm("s1", held!.token); // still there for its own session
    expect(w.caller).toHaveBeenCalledTimes(1);
  });

  it("an expired hold is refused and removed", async () => {
    const { gate, w, callers, now } = setup();
    await callers["w"]!({ a: 1 });
    const [held] = gate.pending("s1");
    now.t += 60_001;
    expect(gate.pending("s1")).toEqual([]);
    await expect(gate.confirm("s1", held!.token)).rejects.toThrow(/expired/);
    expect(w.caller).not.toHaveBeenCalled();
  });

  it("a rejected hold never runs", async () => {
    const { gate, w, callers } = setup();
    await callers["w"]!({ a: 1 });
    const [held] = gate.pending("s1");
    gate.reject("s1", held!.token);
    await expect(gate.confirm("s1", held!.token)).rejects.toThrow(/unknown/);
    expect(w.caller).not.toHaveBeenCalled();
  });

  it("tokens are unguessable (32 random bytes)", async () => {
    const { gate, callers } = setup();
    await callers["w"]!({ a: 1 });
    await callers["w"]!({ a: 2 });
    const [a, b] = gate.pending("s1");
    expect(a!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a!.token).not.toBe(b!.token);
  });
});

describe("inside LLMAgent's loop", () => {
  it("a write the model asks for is held, the model is told, and nothing runs until the user confirms", async () => {
    const w = tool("register_machine", "POST", "/api/onboard/register");
    const gate = new ConfirmationGate();
    const { defs, callers } = gate.forSession("s1", [w], { l2Enabled: false });
    const replies = [
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu1", name: "register_machine", input: { name: "plate reader" } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Please confirm." }], usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const create = vi.fn(async () => replies.shift());
    const agent = new LLMAgent(defs, callers, { client: { messages: { create } } as unknown as Anthropic });
    const result = await agent.chat("register my plate reader");
    expect(result.text).toBe("Please confirm.");
    expect(w.caller).not.toHaveBeenCalled();
    const toolResult = (result.messages[2]!.content as Array<{ content: string }>)[0]!.content;
    expect(JSON.parse(toolResult)).toMatchObject({ status: "held_for_user_confirmation" });
    const [held] = gate.pending("s1");
    await gate.confirm("s1", held!.token);
    expect(w.caller).toHaveBeenCalledWith({ name: "plate reader" });
  });
});
