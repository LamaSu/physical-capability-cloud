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

describe("settlement never records less than was spent, and an overrun stops the payer for the UTC day (Q4-B)", () => {
  const ONE_K: BudgetCaps = { perSession: 1_000, perUserDay: 1_000, perMonth: 1_000 };
  const ALICE_2 = { sessionId: "s-2", userKey: ALICE.userKey };

  it("Q4-B: a settlement above its reservation is recorded at its true cost (every cap 1000, 1000 reserved, 1001 settled: 1001)", () => {
    const { m, db } = meter(ONE_K);
    m.settle(m.reserve(ALICE, 1_000), 1_001);
    expect(m.spent(ALICE).session).toBe(1_001);
    expect(db.prepare("SELECT nano_usd FROM hosted_agent_spend").all()).toEqual([{ nano_usd: 1_001 }]);
  });

  it("Q4-B: the overrun is flagged in the ledger, and that payer's next reservation that day is refused", () => {
    const { m, db } = meter(ONE_K);
    const r = m.reserve(ALICE, 1_000);
    expect(m.settle(r, 1_001)).toEqual({ overrun: true });
    expect(m.blocked(ALICE)).toBe(true);
    expect(db.prepare("SELECT reserved_nano_usd, actual_nano_usd FROM hosted_agent_overrun").all()).toEqual([
      { reserved_nano_usd: 1_000, actual_nano_usd: 1_001 },
    ]);
    let err: unknown;
    try {
      m.reserve(ALICE, 0);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetStop);
    expect((err as BudgetStop).reason).toBe("overrun");
  });

  it("Q4-B: whatever the caps, the payer is blocked in every session for the rest of the UTC day", () => {
    const { m } = meter(CAPS);
    m.settle(m.reserve(ALICE, 1_000), 1_001);
    let err: unknown;
    try {
      m.reserve(ALICE_2, 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetStop);
    expect((err as BudgetStop).reason).toBe("overrun");
    expect(m.spent(ALICE_2).session).toBe(0); // the refused call reserved nothing
  });

  it("Q4-B: another payer is unaffected, and so is the global kill-switch", () => {
    const { m } = meter(CAPS);
    m.settle(m.reserve(ALICE, 1_000), 1_001);
    expect(m.blocked({ sessionId: "s-9", userKey: "user:bob" })).toBe(false);
    expect(() => m.reserve({ sessionId: "s-9", userKey: "user:bob" }, 1_000)).not.toThrow();
  });

  it("Q4-B: the next UTC day lifts the block, and the day's own spend still counts", () => {
    let now = new Date("2026-10-06T23:59:00Z");
    const { m } = meter(CAPS, () => now);
    m.settle(m.reserve(ALICE, 1_000), 1_001);
    expect(() => m.reserve(ALICE_2, 1)).toThrow(BudgetStop);
    now = new Date("2026-10-07T00:00:01Z");
    expect(m.blocked(ALICE)).toBe(false);
    expect(() => m.reserve(ALICE_2, 1)).not.toThrow();
  });

  it("Q4-B: settling exactly the reservation, or less, is not an overrun", () => {
    const { m } = meter(CAPS);
    expect(m.settle(m.reserve(ALICE, 1_000), 1_000)).toEqual({ overrun: false });
    expect(m.settle(m.reserve(ALICE, 1_000), 0)).toEqual({ overrun: false });
    expect(m.blocked(ALICE)).toBe(false);
  });

  it("Q4-B: an abandoned call, charged its worst case, is not an overrun", () => {
    const { m } = meter(CAPS);
    m.abandon(m.reserve(ALICE, 1_000));
    expect(m.blocked(ALICE)).toBe(false);
  });

  it("Q4-B: the flag lives in the ledger file, so a restart does not forget it", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hosted-agent-overrun-"));
    try {
      const file = join(dir, "spend.db");
      const first = new Database(file);
      const a = new BudgetMeter(first, CAPS, () => new Date("2026-10-06T12:00:00Z"), () => false);
      a.settle(a.reserve(ALICE, 1_000), 1_001);
      first.close();
      const second = new Database(file);
      const b = new BudgetMeter(second, CAPS, () => new Date("2026-10-06T13:00:00Z"), () => false);
      expect(() => b.reserve(ALICE_2, 1)).toThrow(BudgetStop);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Q4-B: through the metered client, a call that cost more than reserved stops that payer's next call, and the model is not called", async () => {
    const { m, db } = meter(CAPS);
    const request = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
    const worst = worstCaseNanoUsd(request, PRICE);
    const create = vi.fn(async () => ({ usage: { input_tokens: Math.ceil(worst / PRICE.input) + 1, output_tokens: 0 } }));
    const client = meteredClient({ messages: { create } }, m, ALICE, PRICE);
    await client.messages.create(request); // costs more than its reservation
    expect(m.spent(ALICE).session).toBeGreaterThan(worst); // the true cost is recorded
    await expect(client.messages.create(request)).rejects.toMatchObject({ name: "BudgetStop", reason: "overrun" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hosted_agent_overrun").get()).toEqual({ n: 1 });
  });
});
