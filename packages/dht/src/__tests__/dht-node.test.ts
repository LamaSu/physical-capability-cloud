import { describe, it, expect, afterEach } from "vitest";
import { DHTNode } from "../dht-node.js";
import { AnnouncementRegistry } from "../registry.js";
import type { CapabilityAnnouncement, PeerIdentity } from "@pcc/spec";

// ── Helpers ──────────────────────────────────────────────────────

function makeIdentity(id: string): PeerIdentity {
  return {
    did: `did:pcc:${id}`,
    publicKey: "0".repeat(64),
    endpoints: [],
  };
}

function makeAnnouncement(
  kernelDid: string,
  overrides: Partial<CapabilityAnnouncement> = {},
): CapabilityAnnouncement {
  return {
    kernelDid,
    kernelId: kernelDid.replace("did:pcc:", ""),
    capabilities: [{ type: "fdm_print", materials: ["PLA"] }],
    endpoints: [],
    ttlSeconds: 300,
    timestamp: new Date().toISOString(),
    signature: "mock-sig",
    ...overrides,
  };
}

// Keep track of nodes for cleanup
const activeNodes: DHTNode[] = [];

function createNode(id: string, port: number, bootstrap: string[] = []): DHTNode {
  const node = new DHTNode({
    identity: makeIdentity(id),
    bootstrapNodes: bootstrap,
    port,
    defaultTTL: 3,
    queryTimeoutMs: 1000,
    pruneIntervalMs: 60_000,
  });
  activeNodes.push(node);
  return node;
}

afterEach(async () => {
  // Clean up all nodes
  for (const node of activeNodes) {
    await node.stop().catch(() => {});
  }
  activeNodes.length = 0;
});

// ── DHTNode Tests ────────────────────────────────────────────────

describe("DHTNode", () => {
  it("starts and stops without error", async () => {
    const node = createNode("solo", 0); // no server
    await node.start();
    await node.stop();
  });

  it("announces locally without peers", async () => {
    const node = createNode("solo", 0);
    await node.start();

    const a = makeAnnouncement("did:pcc:solo-kernel");
    await node.announce(a);

    const results = await node.query({ type: "fdm_print" });
    expect(results).toHaveLength(1);
    expect(results[0].kernelDid).toBe("did:pcc:solo-kernel");
  });

  it("query returns empty for non-matching type", async () => {
    const node = createNode("solo", 0);
    await node.start();

    const a = makeAnnouncement("did:pcc:fdm", {
      capabilities: [{ type: "fdm_print" }],
    });
    await node.announce(a);

    const results = await node.query({ type: "laser_cut" });
    expect(results).toHaveLength(0);
  });

  it("two nodes can connect and exchange announcements", async () => {
    // Node A listens on a port
    const nodeA = createNode("a", 19201);
    await nodeA.start();

    // Node B connects to Node A
    const nodeB = createNode("b", 0, ["ws://127.0.0.1:19201"]);
    await nodeB.start();

    // Wait for connection to establish
    await sleep(200);

    // Node A announces
    const a = makeAnnouncement("did:pcc:from-a", {
      capabilities: [{ type: "fdm_print" }],
    });
    await nodeA.announce(a);

    // Wait for gossip propagation
    await sleep(200);

    // Node B should have it
    const resultsB = await nodeB.query({ type: "fdm_print" });
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].kernelDid).toBe("did:pcc:from-a");
  });

  it("Node B queries Node A for capabilities", async () => {
    const nodeA = createNode("server", 19202);
    await nodeA.start();

    // Seed Node A with an announcement
    nodeA.getRegistry().store(
      makeAnnouncement("did:pcc:seeded", {
        capabilities: [{ type: "liquid-handler" }],
      }),
    );

    const nodeB = createNode("client", 0, ["ws://127.0.0.1:19202"]);
    await nodeB.start();
    await sleep(200);

    // Node B queries (should get Node A's local data via query_result message)
    const results = await nodeB.query({ type: "liquid-handler" });
    expect(results).toHaveLength(1);
    expect(results[0].kernelDid).toBe("did:pcc:seeded");
  });

  it("three-node gossip: A -> B -> C", async () => {
    const nodeA = createNode("hub", 19203);
    await nodeA.start();

    const nodeB = createNode("relay", 19204, ["ws://127.0.0.1:19203"]);
    await nodeB.start();
    await sleep(200);

    const nodeC = createNode("leaf", 0, ["ws://127.0.0.1:19204"]);
    await nodeC.start();
    await sleep(200);

    // Announce from A (TTL=3 → B receives at TTL=2 → C at TTL=1)
    await nodeA.announce(
      makeAnnouncement("did:pcc:origin", {
        capabilities: [{ type: "cnc_mill" }],
      }),
    );
    await sleep(300);

    // C should have it via gossip through B
    const resultsC = await nodeC.query({ type: "cnc_mill" });
    expect(resultsC.length).toBeGreaterThanOrEqual(1);
    expect(resultsC[0].kernelDid).toBe("did:pcc:origin");
  });

  it("getPeers returns connected peer list", async () => {
    const nodeA = createNode("server", 19205);
    await nodeA.start();

    const nodeB = createNode("client", 0, ["ws://127.0.0.1:19205"]);
    await nodeB.start();
    await sleep(200);

    const peersA = nodeA.getPeers();
    const peersB = nodeB.getPeers();
    expect(peersA.length).toBe(1);
    expect(peersB.length).toBe(1);
  });

  it("ping/pong works between nodes", async () => {
    const nodeA = createNode("pinger", 19206);
    await nodeA.start();

    const nodeB = createNode("ponger", 0, ["ws://127.0.0.1:19206"]);
    await nodeB.start();
    await sleep(200);

    // Send a ping from A to B
    const peerIds = nodeA.getTransport().getPeerIds();
    expect(peerIds).toHaveLength(1);
    nodeA.getTransport().send(peerIds[0], { type: "ping" });

    // Just verify no error occurs (pong is handled internally)
    await sleep(100);
  });

  it("handles external WebSocket connections via handleConnection", async () => {
    const node = createNode("gateway-like", 0);
    await node.start();

    // Seed some data
    node.getRegistry().store(
      makeAnnouncement("did:pcc:gateway-data", {
        capabilities: [{ type: "bioprinter" }],
      }),
    );

    // The handleConnection method exists and is callable
    expect(typeof node.handleConnection).toBe("function");
  });

  it("does not re-gossip announcements it has already seen", async () => {
    const nodeA = createNode("dedup-server", 19207);
    await nodeA.start();

    const nodeB = createNode("dedup-client", 0, ["ws://127.0.0.1:19207"]);
    await nodeB.start();
    await sleep(200);

    const a = makeAnnouncement("did:pcc:dedup-test");

    // Announce twice from A
    await nodeA.announce(a);
    await nodeA.announce(a);
    await sleep(200);

    // B should only have one entry (announcements overwrite by kernelDid, and dedup prevents extra gossip)
    const results = await nodeB.query({});
    const matching = results.filter((r) => r.kernelDid === "did:pcc:dedup-test");
    expect(matching).toHaveLength(1);
  });

  it("stop cancels pending queries gracefully", async () => {
    const node = createNode("stopping", 0);
    await node.start();

    // Start a query (will timeout since no peers)
    const queryPromise = node.query({ type: "anything" });

    // Stop the node immediately
    await node.stop();

    // Query should still resolve (with empty results)
    const results = await queryPromise;
    expect(Array.isArray(results)).toBe(true);
  });
});

// ── Utility ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
