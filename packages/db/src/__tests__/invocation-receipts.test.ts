/**
 * Tests for the InvocationReceipt persistence layer.
 *
 * Covers: CRUD round-trip, CID lookup, indexed-tool / caller scoping,
 * effective DCC filter, since-createdAt window, count helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createStore,
  type Store,
  type InvocationReceiptInsert,
} from "../index.js";

const SHA = "sha256:" + "a".repeat(64);

function makeRow(
  overrides: Partial<InvocationReceiptInsert> = {},
): InvocationReceiptInsert {
  return {
    id: "rcpt-1",
    receiptCid: SHA,
    schemaVersion: "1.0",
    indexedToolId: "tool-1",
    toolCid: SHA,
    toolSchemaHashAtCall: SHA,
    requestedDccClass: "DCC1",
    effectiveDccClass: "DCC1",
    pccSignature: "sig",
    pccKeyId: "pcc-key-1",
    callerAgentId: "agent-1",
    callerSessionId: "session-1",
    pccFeeBps: 100,
    body: { receiptId: "rcpt-1", anything: "goes" },
    createdAt: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("InvocationReceiptRepository", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  it("insert + findById round-trip", () => {
    const inserted = store.repos.invocationReceipts.insert(makeRow());
    expect(inserted?.id).toBe("rcpt-1");
    const found = store.repos.invocationReceipts.findById("rcpt-1");
    expect(found?.receiptCid).toBe(SHA);
    expect(found?.pccFeeBps).toBe(100);
  });

  it("findByCid resolves a receipt", () => {
    store.repos.invocationReceipts.insert(makeRow());
    const found = store.repos.invocationReceipts.findByCid(SHA);
    expect(found?.id).toBe("rcpt-1");
  });

  it("findByTool returns recent receipts for a tool, desc by createdAt", () => {
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r1", createdAt: "2026-05-23T00:00:00.000Z" }),
    );
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r2", createdAt: "2026-05-23T00:00:01.000Z" }),
    );
    store.repos.invocationReceipts.insert(
      makeRow({
        id: "r3",
        indexedToolId: "tool-other",
        createdAt: "2026-05-23T00:00:02.000Z",
      }),
    );
    const out = store.repos.invocationReceipts.findByTool("tool-1");
    expect(out.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("findByCaller scopes by caller", () => {
    store.repos.invocationReceipts.insert(makeRow({ id: "r1" }));
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r2", callerAgentId: "agent-2" }),
    );
    const out = store.repos.invocationReceipts.findByCaller("agent-2");
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("r2");
  });

  it("query with multiple filters AND-combines", () => {
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r1", effectiveDccClass: "DCC1" }),
    );
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r2", effectiveDccClass: "DCC3" }),
    );
    store.repos.invocationReceipts.insert(
      makeRow({
        id: "r3",
        callerAgentId: "agent-2",
        effectiveDccClass: "DCC3",
      }),
    );
    const out = store.repos.invocationReceipts.query({
      callerAgentId: "agent-1",
      effectiveDccClass: "DCC3",
    });
    expect(out.map((r) => r.id)).toEqual(["r2"]);
  });

  it("query with sinceCreatedAt window", () => {
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r1", createdAt: "2026-05-23T00:00:00.000Z" }),
    );
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r2", createdAt: "2026-05-24T00:00:00.000Z" }),
    );
    const out = store.repos.invocationReceipts.query({
      sinceCreatedAt: "2026-05-23T12:00:00.000Z",
    });
    expect(out.map((r) => r.id)).toEqual(["r2"]);
  });

  it("countByTool returns the number of receipts for a tool", () => {
    store.repos.invocationReceipts.insert(makeRow({ id: "r1" }));
    store.repos.invocationReceipts.insert(makeRow({ id: "r2" }));
    store.repos.invocationReceipts.insert(
      makeRow({ id: "r3", indexedToolId: "tool-other" }),
    );
    expect(store.repos.invocationReceipts.countByTool("tool-1")).toBe(2);
    expect(store.repos.invocationReceipts.countByTool("tool-other")).toBe(1);
    expect(store.repos.invocationReceipts.countByTool("missing")).toBe(0);
  });

  it("findRecent honors limit", () => {
    for (let i = 0; i < 5; i++) {
      store.repos.invocationReceipts.insert(
        makeRow({
          id: `r${i}`,
          createdAt: `2026-05-2${i}T00:00:00.000Z`,
        }),
      );
    }
    const out = store.repos.invocationReceipts.findRecent(3);
    expect(out).toHaveLength(3);
    expect(out[0]?.id).toBe("r4");
  });
});
