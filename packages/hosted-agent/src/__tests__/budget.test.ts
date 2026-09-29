import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { LLMAgent } from "@pcc/agent-runtime";
import {
  BudgetMeter,
  BudgetStop,
  actualNanoUsd,
  meteredClient,
  worstCaseNanoUsd,
  type BudgetCaps,
  type MessagesClient,
  type ModelPrice,
  type Usage,
} from "../budget.js";

const PRICE: ModelPrice = { input: 3_000, output: 15_000, cacheWrite: 3_750, cacheRead: 300 }; // $3 / $15 per MTok
const USD = 1_000_000_000; // nano-USD per dollar
const CAPS: BudgetCaps = { perSession: 2 * USD, perUserDay: 5 * USD, perMonth: 200 * USD };
const ALICE = { sessionId: "s-1", userKey: "user:alice" };

function meter(caps: BudgetCaps = CAPS, now = () => new Date("2026-10-06T12:00:00Z"), db = new Database(":memory:")) {
  return { m: new BudgetMeter(db, caps, now, () => false), db };
}

describe("the cost bounds", () => {
  it("the worst case covers the request's bytes at the dearest input rate, plus max_tokens of output", () => {
    const request = { model: "m", max_tokens: 1000, system: "héllo", messages: [{ role: "user", content: "hi" }] };
    const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    expect(worstCaseNanoUsd(request, PRICE)).toBe(bytes * 3_750 + 1000 * 15_000);
  });

  it("the actual cost prices every usage field", () => {
    const usage: Usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 };
    expect(actualNanoUsd(usage, PRICE)).toBe(100 * 3_000 + 10 * 15_000 + 20 * 3_750 + 30 * 300);
  });

  it("a non-integer or negative count is refused, never rounded", () => {
    expect(() => actualNanoUsd({ input_tokens: 1.5, output_tokens: 0 }, PRICE)).toThrow(RangeError);
    expect(() => actualNanoUsd({ input_tokens: -1, output_tokens: 0 }, PRICE)).toThrow(RangeError);
  });
});

describe("each cap is a hard stop before the call", () => {
  it.each([
    ["per-session", { ...CAPS, perSession: 1_000 }],
    ["per-user-day", { ...CAPS, perUserDay: 1_000 }],
    ["per-month", { ...CAPS, perMonth: 1_000 }],
  ] as const)("%s", (reason, caps) => {
    const { m } = meter(caps);
    const first = m.reserve(ALICE, 600);
    m.settle(first, 600);
    let err: unknown;
    try {
      m.reserve(ALICE, 600);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetStop);
    expect((err as BudgetStop).reason).toBe(reason);
    expect(m.spent(ALICE).session).toBe(600); // the refused call reserved nothing
    expect(() => m.reserve(ALICE, 400)).not.toThrow(); // exactly up to the cap is allowed
  });

  it("pending reservations count against the caps at their worst case", () => {
    const { m } = meter({ ...CAPS, perSession: 1_000 });
    m.reserve(ALICE, 700); // not settled yet
    expect(() => m.reserve(ALICE, 400)).toThrow(BudgetStop);
  });

  it("a new UTC day resets the user-day sum but not the month", () => {
    let now = new Date("2026-10-06T23:59:00Z");
    const { m } = meter({ perSession: 10 * USD, perUserDay: 1_000, perMonth: 1_500 }, () => now);
    m.settle(m.reserve(ALICE, 1_000), 1_000);
    expect(() => m.reserve({ ...ALICE, sessionId: "s-2" }, 1)).toThrow(/per-user-day/);
    now = new Date("2026-10-07T00:01:00Z");
    m.settle(m.reserve({ ...ALICE, sessionId: "s-2" }, 500), 500);
    expect(() => m.reserve({ ...ALICE, sessionId: "s-3" }, 1)).toThrow(/per-month/);
  });

  it("the kill switch refuses every call", () => {
    const m = new BudgetMeter(new Database(":memory:"), CAPS, () => new Date(), () => true);
    expect(() => m.reserve(ALICE, 1)).toThrow(/disabled/);
  });
});

describe("reservations", () => {
  it("settle records the actual cost, once", () => {
    const { m } = meter();
    const r = m.reserve(ALICE, 10_000);
    m.settle(r, 4_000);
    expect(m.spent(ALICE).session).toBe(4_000);
    expect(() => m.settle(r, 1)).toThrow(/not pending/);
  });

  it("an abandoned call is charged its worst case", () => {
    const { m } = meter();
    m.abandon(m.reserve(ALICE, 10_000));
    expect(m.spent(ALICE).session).toBe(10_000);
  });

  it("two connections cannot jointly cross a cap (BEGIN IMMEDIATE)", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hosted-agent-budget-"));
    try {
      const file = join(dir, "spend.db");
      const a = new Database(file);
      const b = new Database(file);
      b.pragma("busy_timeout = 2000");
      const caps = { ...CAPS, perUserDay: 1_000 };
      const ma = new BudgetMeter(a, caps, () => new Date("2026-10-06T12:00:00Z"), () => false);
      const mb = new BudgetMeter(b, caps, () => new Date("2026-10-06T12:00:00Z"), () => false);
      ma.reserve({ sessionId: "s-a", userKey: "user:alice" }, 600);
      expect(() => mb.reserve({ sessionId: "s-b", userKey: "user:alice" }, 600)).toThrow(/per-user-day/);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the metered client", () => {
  const request = { model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

  it("refuses before the inner client is called", async () => {
    const { m } = meter({ ...CAPS, perSession: 1 });
    const inner: MessagesClient = { messages: { create: vi.fn() } };
    await expect(meteredClient(inner, m, ALICE, PRICE).messages.create(request)).rejects.toBeInstanceOf(BudgetStop);
    expect(inner.messages.create).not.toHaveBeenCalled();
  });

  it("settles the actual usage after a call", async () => {
    const { m } = meter();
    const inner: MessagesClient = {
      messages: { create: vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } })) },
    };
    await meteredClient(inner, m, ALICE, PRICE).messages.create(request);
    expect(m.spent(ALICE).session).toBe(10 * 3_000 + 5 * 15_000);
  });

  it("charges a failed call its worst case and rethrows the original error", async () => {
    const { m } = meter();
    const boom = new Error("network");
    const inner: MessagesClient = { messages: { create: vi.fn(async () => Promise.reject(boom)) } };
    await expect(meteredClient(inner, m, ALICE, PRICE).messages.create(request)).rejects.toBe(boom);
    expect(m.spent(ALICE).session).toBe(worstCaseNanoUsd(request, PRICE));
  });

  it("a budget stop comes out of LLMAgent.chat unchanged, and the model is never called", async () => {
    const { m } = meter({ ...CAPS, perSession: 1 });
    const create = vi.fn();
    const client = meteredClient({ messages: { create } }, m, ALICE, PRICE);
    // LLMAgent calls only messages.create on its client.
    const agent = new LLMAgent([], {}, { client: client as unknown as Anthropic });
    await expect(agent.chat("hello")).rejects.toBeInstanceOf(BudgetStop);
    expect(create).not.toHaveBeenCalled();
  });
});
