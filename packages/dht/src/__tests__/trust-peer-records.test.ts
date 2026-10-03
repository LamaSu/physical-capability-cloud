/**
 * WP-A round 6 (wpa-326-admingates-astra: "bind announcements to an authorized
 * kernel"): a node that does not trust peer records keeps its registry to what IT
 * stored.
 *
 * A peer's announcement carries no verified signature and no owner check. The
 * gateway authenticates /ws/dht peers, but any key holder is a peer, so a peer
 * could inject kernel records that the gateway's public query then served. With
 * trustPeerRecords: false the node drops inbound announcements, ignores peers'
 * query answers and answers queries from its own registry. It still serves peers,
 * and still syncs its own records to them.
 */
import { describe, it, expect, afterEach } from "vitest";
import { DHTNode } from "../dht-node.js";
import type { CapabilityAnnouncement, PeerIdentity } from "@pcc/spec";

const identity = (id: string): PeerIdentity => ({ did: `did:pcc:${id}`, publicKey: "0".repeat(64), endpoints: [] });
const announcement = (kernelDid: string, type: string): CapabilityAnnouncement => ({
  kernelDid,
  kernelId: kernelDid.replace("did:pcc:", ""),
  capabilities: [{ type }],
  endpoints: [],
  ttlSeconds: 300,
  timestamp: new Date().toISOString(),
  signature: "unverified",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const nodes: DHTNode[] = [];
function node(id: string, port: number, bootstrap: string[] = [], trustPeerRecords?: boolean): DHTNode {
  const n = new DHTNode({
    identity: identity(id),
    bootstrapNodes: bootstrap,
    port,
    defaultTTL: 3,
    queryTimeoutMs: 500,
    pruneIntervalMs: 60_000,
    ...(trustPeerRecords === undefined ? {} : { trustPeerRecords }),
  });
  nodes.push(n);
  return n;
}

afterEach(async () => {
  for (const n of nodes) await n.stop().catch(() => {});
  nodes.length = 0;
});

describe("trustPeerRecords: false", () => {
  it("[neg] a peer's announcement is neither stored nor served", async () => {
    const guarded = node("guarded", 19311, [], false);
    await guarded.start();
    const peer = node("peer", 0, ["ws://127.0.0.1:19311"]);
    await peer.start();
    await sleep(200);

    await peer.announce(announcement("did:pcc:injected-by-peer", "fdm_print"));
    await sleep(200);

    expect(guarded.getRegistry().size).toBe(0);
    expect(await guarded.query({ type: "fdm_print" })).toEqual([]);
  });

  it("[neg] a peer's query answer is ignored: the guarded node answers from its own registry", async () => {
    const peer = node("peer-with-records", 19312);
    await peer.start();
    peer.getRegistry().store(announcement("did:pcc:only-on-the-peer", "laser_cut"));
    const guarded = node("guarded-client", 0, ["ws://127.0.0.1:19312"], false);
    await guarded.start();
    await sleep(200);

    expect(await guarded.query({ type: "laser_cut" })).toEqual([]);
  });

  it("control: it still syncs its OWN records to a peer, and answers a peer's query", async () => {
    const guarded = node("guarded-server", 19313, [], false);
    await guarded.start();
    await guarded.announce(announcement("did:pcc:owned-by-guarded", "cnc"));
    const peer = node("reader", 0, ["ws://127.0.0.1:19313"]);
    await peer.start();
    await sleep(200);

    const seen = await peer.query({ type: "cnc" });
    expect(seen.map((a) => a.kernelDid)).toEqual(["did:pcc:owned-by-guarded"]);
  });

  it("control: by default (true) a peer's announcement is stored, as before", async () => {
    const open = node("open", 19314);
    await open.start();
    const peer = node("peer2", 0, ["ws://127.0.0.1:19314"]);
    await peer.start();
    await sleep(200);

    await peer.announce(announcement("did:pcc:gossiped", "fdm_print"));
    await sleep(200);

    expect(open.getRegistry().size).toBe(1);
  });
});
