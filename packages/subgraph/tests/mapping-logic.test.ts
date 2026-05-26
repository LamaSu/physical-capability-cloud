/**
 * Mapping logic invariants — pure-TS tests of the subgraph handlers'
 * algorithmic behavior, without requiring matchstick / graph-node.
 *
 * The actual handlers run in AssemblyScript under graph-node and use the
 * generated `@graphprotocol/graph-ts` entity API. Here we test the
 * algorithmic invariants the handlers must preserve, against the same
 * inputs they'd receive from the contract events.
 *
 * For full WASM-level coverage, run `pnpm --filter @pcc/subgraph test` which
 * dispatches to `matchstick-as`.
 */

import { describe, it, expect } from "vitest";

// ---- Plain TS mirror of the entity counters ----

interface ToolState {
  totalReceipts: bigint;
  dccCounts: [bigint, bigint, bigint, bigint, bigint, bigint];
  firstSeenBlock: bigint;
  lastSeenBlock: bigint;
}

interface CallerState {
  totalReceipts: bigint;
  firstSeenBlock: bigint;
  lastSeenBlock: bigint;
}

interface AnchorEvent {
  cidHash: string;
  toolIdHash: string;
  callerHash: string;
  dccClass: number; // 0..5
  blockNumber: bigint;
}

interface DisputeEvent {
  cidHash: string;
  txHash: string;
  logIndex: number;
}

function newTool(blockNumber: bigint): ToolState {
  return {
    totalReceipts: 0n,
    dccCounts: [0n, 0n, 0n, 0n, 0n, 0n],
    firstSeenBlock: blockNumber,
    lastSeenBlock: blockNumber,
  };
}

function newCaller(blockNumber: bigint): CallerState {
  return {
    totalReceipts: 0n,
    firstSeenBlock: blockNumber,
    lastSeenBlock: blockNumber,
  };
}

function applyAnchor(
  tools: Map<string, ToolState>,
  callers: Map<string, CallerState>,
  event: AnchorEvent,
): void {
  let tool = tools.get(event.toolIdHash);
  if (!tool) {
    tool = newTool(event.blockNumber);
    tools.set(event.toolIdHash, tool);
  }
  tool.totalReceipts += 1n;
  tool.lastSeenBlock = event.blockNumber;
  tool.dccCounts[event.dccClass] += 1n;

  let caller = callers.get(event.callerHash);
  if (!caller) {
    caller = newCaller(event.blockNumber);
    callers.set(event.callerHash, caller);
  }
  caller.totalReceipts += 1n;
  caller.lastSeenBlock = event.blockNumber;
}

function disputeId(event: DisputeEvent): string {
  return `${event.txHash}-${event.logIndex}`;
}

// ---- Tests ----

describe("subgraph mapping logic invariants", () => {
  it("first AnchorEmitted for a tool initializes counters", () => {
    const tools = new Map<string, ToolState>();
    const callers = new Map<string, CallerState>();
    applyAnchor(tools, callers, {
      cidHash: "0xaa",
      toolIdHash: "0xT1",
      callerHash: "0xC1",
      dccClass: 3,
      blockNumber: 100n,
    });

    const tool = tools.get("0xT1")!;
    expect(tool.totalReceipts).toBe(1n);
    expect(tool.dccCounts[3]).toBe(1n);
    expect(tool.firstSeenBlock).toBe(100n);
    expect(tool.lastSeenBlock).toBe(100n);
  });

  it("subsequent anchors increment totalReceipts and the matching dcc counter only", () => {
    const tools = new Map<string, ToolState>();
    const callers = new Map<string, CallerState>();
    const t = "0xT1";
    const c = "0xC1";
    applyAnchor(tools, callers, { cidHash: "0x1", toolIdHash: t, callerHash: c, dccClass: 0, blockNumber: 100n });
    applyAnchor(tools, callers, { cidHash: "0x2", toolIdHash: t, callerHash: c, dccClass: 3, blockNumber: 101n });
    applyAnchor(tools, callers, { cidHash: "0x3", toolIdHash: t, callerHash: c, dccClass: 3, blockNumber: 102n });
    applyAnchor(tools, callers, { cidHash: "0x4", toolIdHash: t, callerHash: c, dccClass: 5, blockNumber: 103n });

    const tool = tools.get(t)!;
    expect(tool.totalReceipts).toBe(4n);
    expect(tool.dccCounts[0]).toBe(1n);
    expect(tool.dccCounts[1]).toBe(0n);
    expect(tool.dccCounts[2]).toBe(0n);
    expect(tool.dccCounts[3]).toBe(2n);
    expect(tool.dccCounts[4]).toBe(0n);
    expect(tool.dccCounts[5]).toBe(1n);
    expect(tool.firstSeenBlock).toBe(100n);
    expect(tool.lastSeenBlock).toBe(103n);
  });

  it("caller counter is independent of tool", () => {
    const tools = new Map<string, ToolState>();
    const callers = new Map<string, CallerState>();
    const c = "0xC1";
    applyAnchor(tools, callers, { cidHash: "0x1", toolIdHash: "0xT1", callerHash: c, dccClass: 1, blockNumber: 100n });
    applyAnchor(tools, callers, { cidHash: "0x2", toolIdHash: "0xT2", callerHash: c, dccClass: 1, blockNumber: 101n });
    applyAnchor(tools, callers, { cidHash: "0x3", toolIdHash: "0xT3", callerHash: c, dccClass: 1, blockNumber: 102n });

    const caller = callers.get(c)!;
    expect(caller.totalReceipts).toBe(3n);
    expect(caller.firstSeenBlock).toBe(100n);
    expect(caller.lastSeenBlock).toBe(102n);
    expect(tools.size).toBe(3); // three distinct tools
  });

  it("DCC class boundaries 0..5 are valid", () => {
    const tools = new Map<string, ToolState>();
    const callers = new Map<string, CallerState>();
    const t = "0xT1";
    const c = "0xC1";
    for (let dcc = 0; dcc <= 5; dcc++) {
      applyAnchor(tools, callers, { cidHash: `0x${dcc}`, toolIdHash: t, callerHash: c, dccClass: dcc, blockNumber: BigInt(100 + dcc) });
    }
    const tool = tools.get(t)!;
    expect(tool.totalReceipts).toBe(6n);
    for (let dcc = 0; dcc <= 5; dcc++) {
      expect(tool.dccCounts[dcc]).toBe(1n);
    }
  });

  it("dispute id is unique per (txHash, logIndex)", () => {
    const a = disputeId({ cidHash: "0xaa", txHash: "0xT", logIndex: 0 });
    const b = disputeId({ cidHash: "0xbb", txHash: "0xT", logIndex: 1 });
    const c = disputeId({ cidHash: "0xcc", txHash: "0xT2", logIndex: 0 });
    expect(a).toBe("0xT-0");
    expect(b).toBe("0xT-1");
    expect(c).toBe("0xT2-0");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("dispute against same cidHash from different disputers produces distinct entities", () => {
    // Two disputers raising claims against the same receipt in the same block
    // → distinct logIndexes → distinct ids → both indexed.
    const d1 = disputeId({ cidHash: "0xaa", txHash: "0xT", logIndex: 0 });
    const d2 = disputeId({ cidHash: "0xaa", txHash: "0xT", logIndex: 1 });
    expect(d1).not.toBe(d2);
  });
});
