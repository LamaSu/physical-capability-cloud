/**
 * TransferGraphBuilder — constructs, validates, and queries the physical
 * topology of instruments within a shop kernel.
 *
 * Nodes represent physical locations (instruments, staging areas, etc.)
 * and edges represent valid transfer paths between them.
 */

import type {
  TransferNode,
  TransferEdge,
  TransferGraph,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

export class TransferGraphBuilder {
  private nodes = new Map<string, TransferNode>();
  private edges = new Map<string, TransferEdge>();
  /** nodeId → Set of edge IDs originating from (or bidirectionally reachable from) that node */
  private adjacency = new Map<string, Set<string>>();

  // ── Mutation ────────────────────────────────────────────────────

  addNode(node: Omit<TransferNode, "id"> & { id?: string }): TransferNode {
    const full: TransferNode = { ...node, id: node.id ?? ids.transferNode() };
    this.nodes.set(full.id, full);
    if (!this.adjacency.has(full.id)) {
      this.adjacency.set(full.id, new Set());
    }
    return full;
  }

  addEdge(edge: Omit<TransferEdge, "id"> & { id?: string }): TransferEdge {
    if (!this.nodes.has(edge.fromNode)) {
      throw new Error(`fromNode ${edge.fromNode} does not exist in the graph`);
    }
    if (!this.nodes.has(edge.toNode)) {
      throw new Error(`toNode ${edge.toNode} does not exist in the graph`);
    }

    const full: TransferEdge = { ...edge, id: edge.id ?? ids.transferEdge() };
    this.edges.set(full.id, full);

    // Forward direction
    this.getOrCreateAdj(full.fromNode).add(full.id);

    // Reverse direction for bidirectional edges
    if (full.bidirectional) {
      this.getOrCreateAdj(full.toNode).add(full.id);
    }

    return full;
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    // Cascade: remove every edge that touches this node
    for (const [edgeId, edge] of this.edges) {
      if (edge.fromNode === id || edge.toNode === id) {
        this.edges.delete(edgeId);
      }
    }
    // Rebuild adjacency for affected nodes
    this.adjacency.delete(id);
    for (const [nodeId, edgeIds] of this.adjacency) {
      for (const eid of edgeIds) {
        if (!this.edges.has(eid)) {
          edgeIds.delete(eid);
        }
      }
    }
  }

  removeEdge(id: string): void {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.edges.delete(id);
    this.adjacency.get(edge.fromNode)?.delete(id);
    if (edge.bidirectional) {
      this.adjacency.get(edge.toNode)?.delete(id);
    }
  }

  // ── Queries ─────────────────────────────────────────────────────

  getNode(id: string): TransferNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(): TransferNode[] {
    return [...this.nodes.values()];
  }

  getEdges(): TransferEdge[] {
    return [...this.edges.values()];
  }

  /** Get all edges traversable FROM nodeId (including reverse of bidirectional edges). */
  getEdgesFrom(nodeId: string): TransferEdge[] {
    const edgeIds = this.adjacency.get(nodeId);
    if (!edgeIds) return [];
    return [...edgeIds]
      .map((eid) => this.edges.get(eid))
      .filter((e): e is TransferEdge => e !== undefined);
  }

  /** BFS reachability from a starting node. Returns reachable node IDs (excluding start). */
  getReachableFrom(nodeId: string): string[] {
    const visited = new Set<string>();
    const queue: string[] = [nodeId];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.getEdgesFrom(current)) {
        const neighbor = edge.fromNode === current ? edge.toNode : edge.fromNode;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    visited.delete(nodeId);
    return [...visited];
  }

  /** Dijkstra shortest path by transferTimeMs. */
  findPath(
    from: string,
    to: string,
  ): { path: string[]; totalTimeMs: number; edges: TransferEdge[] } | null {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    if (from === to) return { path: [from], totalTimeMs: 0, edges: [] };

    const dist = new Map<string, number>();
    const prev = new Map<string, { nodeId: string; edge: TransferEdge }>();
    const unvisited = new Set<string>(this.nodes.keys());

    dist.set(from, 0);

    while (unvisited.size > 0) {
      // Pick unvisited node with smallest distance
      let current: string | null = null;
      let minDist = Infinity;
      for (const nid of unvisited) {
        const d = dist.get(nid) ?? Infinity;
        if (d < minDist) {
          minDist = d;
          current = nid;
        }
      }
      if (current === null || minDist === Infinity) break;
      if (current === to) break;

      unvisited.delete(current);

      for (const edge of this.getEdgesFrom(current)) {
        const neighbor = edge.fromNode === current ? edge.toNode : edge.fromNode;
        if (!unvisited.has(neighbor)) continue;
        const alt = minDist + edge.transferTimeMs;
        if (alt < (dist.get(neighbor) ?? Infinity)) {
          dist.set(neighbor, alt);
          prev.set(neighbor, { nodeId: current, edge });
        }
      }
    }

    if (!prev.has(to) && from !== to) return null;

    // Reconstruct path
    const path: string[] = [];
    const edges: TransferEdge[] = [];
    let cur = to;
    while (cur !== from) {
      path.unshift(cur);
      const p = prev.get(cur)!;
      edges.unshift(p.edge);
      cur = p.nodeId;
    }
    path.unshift(from);

    return { path, totalTimeMs: dist.get(to)!, edges };
  }

  /** DFS enumeration of all simple paths up to maxDepth. */
  findAllPaths(
    from: string,
    to: string,
    maxDepth = 10,
  ): Array<{ path: string[]; totalTimeMs: number }> {
    const results: Array<{ path: string[]; totalTimeMs: number }> = [];
    const visited = new Set<string>();

    const dfs = (current: string, path: string[], time: number, depth: number) => {
      if (depth > maxDepth) return;
      if (current === to) {
        results.push({ path: [...path], totalTimeMs: time });
        return;
      }
      visited.add(current);
      for (const edge of this.getEdgesFrom(current)) {
        const neighbor = edge.fromNode === current ? edge.toNode : edge.fromNode;
        if (!visited.has(neighbor)) {
          path.push(neighbor);
          dfs(neighbor, path, time + edge.transferTimeMs, depth + 1);
          path.pop();
        }
      }
      visited.delete(current);
    };

    dfs(from, [from], 0, 0);
    return results;
  }

  // ── Validation ──────────────────────────────────────────────────

  validate(): { valid: boolean; orphans: string[]; errors: string[] } {
    const errors: string[] = [];
    const orphans: string[] = [];

    // Check for edges referencing missing nodes
    for (const edge of this.edges.values()) {
      if (!this.nodes.has(edge.fromNode)) {
        errors.push(`Edge ${edge.id} references missing fromNode ${edge.fromNode}`);
      }
      if (!this.nodes.has(edge.toNode)) {
        errors.push(`Edge ${edge.id} references missing toNode ${edge.toNode}`);
      }
    }

    // Check for orphaned nodes (no edges at all)
    for (const nodeId of this.nodes.keys()) {
      const hasEdge = [...this.edges.values()].some(
        (e) => e.fromNode === nodeId || e.toNode === nodeId,
      );
      if (!hasEdge) {
        orphans.push(nodeId);
      }
    }

    return { valid: errors.length === 0, orphans, errors };
  }

  // ── Build ───────────────────────────────────────────────────────

  build(kernelId: string): TransferGraph {
    return {
      id: ids.transferGraph(),
      kernelId,
      nodes: this.getNodes(),
      edges: this.getEdges(),
      createdAt: new Date().toISOString(),
    };
  }

  // ── Internals ───────────────────────────────────────────────────

  private getOrCreateAdj(nodeId: string): Set<string> {
    let set = this.adjacency.get(nodeId);
    if (!set) {
      set = new Set();
      this.adjacency.set(nodeId, set);
    }
    return set;
  }
}
