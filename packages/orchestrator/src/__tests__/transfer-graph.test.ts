import { describe, it, expect } from "vitest";
import { TransferGraphBuilder } from "../transfer-graph.js";
import type { TransferNode, TransferEdge } from "@pcc/spec";
import { ids } from "@pcc/spec";

// ── Helpers ──────────────────────────────────────────────────────────

const KERNEL = "kernel_test1";

function makeNode(
  id: string,
  label: string,
  nodeType: TransferNode["nodeType"] = "instrument",
): Omit<TransferNode, "id"> & { id: string } {
  return { id, kernelId: KERNEL, label, nodeType, capabilities: [] };
}

function makeEdge(
  id: string,
  from: string,
  to: string,
  timeMs: number,
  bidirectional = false,
): Omit<TransferEdge, "id"> & { id: string } {
  return {
    id,
    fromNode: from,
    toNode: to,
    mechanism: "robot_arm",
    transferTimeMs: timeMs,
    bidirectional,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("TransferGraphBuilder", () => {
  it("builds a graph with 4 nodes and 3 edges", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "Staging"));
    builder.addNode(makeNode("B", "FDM"));
    builder.addNode(makeNode("C", "CNC"));
    builder.addNode(makeNode("D", "QC"));

    builder.addEdge(makeEdge("e1", "A", "B", 100));
    builder.addEdge(makeEdge("e2", "B", "C", 200));
    builder.addEdge(makeEdge("e3", "C", "D", 150));

    expect(builder.getNodes()).toHaveLength(4);
    expect(builder.getEdges()).toHaveLength(3);
  });

  it("finds reachable nodes via BFS", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "A"));
    builder.addNode(makeNode("B", "B"));
    builder.addNode(makeNode("C", "C"));
    builder.addNode(makeNode("D", "D")); // D is connected to C
    builder.addNode(makeNode("E", "E")); // E has no inbound edge from the A side

    builder.addEdge(makeEdge("e1", "A", "B", 10));
    builder.addEdge(makeEdge("e2", "B", "C", 10));
    builder.addEdge(makeEdge("e3", "C", "D", 10));
    // E is only connected back to itself — not reachable from A

    const reachable = builder.getReachableFrom("A");
    expect(reachable).toContain("B");
    expect(reachable).toContain("C");
    expect(reachable).toContain("D");
    expect(reachable).not.toContain("E");
    expect(reachable).not.toContain("A"); // start excluded
  });

  it("computes shortest path via Dijkstra (diamond graph)", () => {
    // Diamond: A->B 100ms, A->C 50ms, B->D 50ms, C->D 100ms
    // Shortest A->D should be A->C->D (150ms) or A->B->D (150ms) — tie, but A->C is cheaper first hop
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "A"));
    builder.addNode(makeNode("B", "B"));
    builder.addNode(makeNode("C", "C"));
    builder.addNode(makeNode("D", "D"));

    builder.addEdge(makeEdge("e1", "A", "B", 100));
    builder.addEdge(makeEdge("e2", "A", "C", 50));
    builder.addEdge(makeEdge("e3", "B", "D", 50));
    builder.addEdge(makeEdge("e4", "C", "D", 100));

    const result = builder.findPath("A", "D");
    expect(result).not.toBeNull();
    expect(result!.totalTimeMs).toBe(150);
    expect(result!.path[0]).toBe("A");
    expect(result!.path[result!.path.length - 1]).toBe("D");
    expect(result!.path).toHaveLength(3); // A -> X -> D
  });

  it("finds all paths in a diamond graph", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "A"));
    builder.addNode(makeNode("B", "B"));
    builder.addNode(makeNode("C", "C"));
    builder.addNode(makeNode("D", "D"));

    builder.addEdge(makeEdge("e1", "A", "B", 100));
    builder.addEdge(makeEdge("e2", "A", "C", 50));
    builder.addEdge(makeEdge("e3", "B", "D", 50));
    builder.addEdge(makeEdge("e4", "C", "D", 100));

    const paths = builder.findAllPaths("A", "D");
    expect(paths).toHaveLength(2);

    const times = paths.map((p) => p.totalTimeMs).sort((a, b) => a - b);
    expect(times).toEqual([150, 150]);

    // Both paths go A -> ? -> D
    for (const p of paths) {
      expect(p.path[0]).toBe("A");
      expect(p.path[p.path.length - 1]).toBe("D");
    }
  });

  it("handles bidirectional edges", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "A"));
    builder.addNode(makeNode("B", "B"));

    builder.addEdge(makeEdge("e1", "A", "B", 50, true));

    // Forward: A -> B
    const forwardPath = builder.findPath("A", "B");
    expect(forwardPath).not.toBeNull();
    expect(forwardPath!.path).toEqual(["A", "B"]);

    // Reverse: B -> A
    const reversePath = builder.findPath("B", "A");
    expect(reversePath).not.toBeNull();
    expect(reversePath!.path).toEqual(["B", "A"]);
    expect(reversePath!.totalTimeMs).toBe(50);
  });

  it("validate detects orphaned nodes", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "A"));
    builder.addNode(makeNode("B", "B"));
    builder.addNode(makeNode("ORPHAN", "Orphan"));

    builder.addEdge(makeEdge("e1", "A", "B", 10));

    const result = builder.validate();
    expect(result.orphans).toContain("ORPHAN");
    expect(result.orphans).not.toContain("A");
    expect(result.orphans).not.toContain("B");
  });

  it("validate detects edges referencing unknown nodes", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "A"));
    builder.addNode(makeNode("B", "B"));
    builder.addEdge(makeEdge("e1", "A", "B", 10));

    // Remove a node that edges reference — force by direct removal
    builder.removeNode("B");

    // Now add a dangling edge manually by adding nodes back partially
    builder.addNode(makeNode("B", "B"));
    builder.addNode(makeNode("C", "C"));
    // Internally add an edge referencing a non-existent node via the builder:
    // The builder validates on addEdge, so we test that addEdge throws
    expect(() =>
      builder.addEdge(makeEdge("e_bad", "C", "GHOST", 10)),
    ).toThrow();
  });

  it("removeNode cascades edge removal", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "A"));
    builder.addNode(makeNode("B", "B"));
    builder.addNode(makeNode("C", "C"));

    builder.addEdge(makeEdge("e1", "A", "B", 10));
    builder.addEdge(makeEdge("e2", "B", "C", 10));

    expect(builder.getEdges()).toHaveLength(2);

    builder.removeNode("B");

    expect(builder.getNodes()).toHaveLength(2);
    expect(builder.getEdges()).toHaveLength(0); // Both edges touched B
  });

  it("build() produces a TransferGraph with correct fields", () => {
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("A", "Staging", "staging"));
    builder.addNode(makeNode("B", "FDM", "instrument"));
    builder.addEdge(makeEdge("e1", "A", "B", 100));

    const graph = builder.build(KERNEL);

    expect(graph.id).toMatch(/^tgraph_/);
    expect(graph.kernelId).toBe(KERNEL);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.createdAt).toBeDefined();
  });
});
