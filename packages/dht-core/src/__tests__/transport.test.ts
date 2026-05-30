import { describe, expect, it, afterEach } from "vitest";
import { CoreTransport } from "../transport.js";
import type { CoreMessage } from "../transport.js";

// Each test allocates fresh ports to avoid collisions.
let nextPort = 41000;
const freePort = (): number => nextPort++;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.shift();
    if (fn) await fn();
  }
});

const track = (t: CoreTransport): CoreTransport => {
  cleanups.push(() => t.close());
  return t;
};

describe("CoreTransport", () => {
  it("listen + close are idempotent", async () => {
    const t = track(new CoreTransport({ label: "test" }));
    const port = freePort();
    await t.listen(port);
    await t.listen(port); // second call no-ops
    await t.close();
    await t.close(); // second call no-ops
  });

  it("connect peers exchange messages bidirectionally", async () => {
    const server = track(new CoreTransport({ label: "srv" }));
    const client = track(new CoreTransport({ label: "cli" }));
    const port = freePort();
    await server.listen(port);

    const received: Array<{ side: string; msg: CoreMessage }> = [];
    server.onMessage((_id, msg) => received.push({ side: "server", msg }));
    client.onMessage((_id, msg) => received.push({ side: "client", msg }));

    const peerId = await client.connect(`ws://127.0.0.1:${port}`);

    const m1: CoreMessage = { protocol: "/test/1", payload: { hello: "world" } };
    client.send(peerId, m1);

    // give the event loop a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.side).toBe("server");
    expect(received[0]?.msg.payload).toEqual({ hello: "world" });
  });

  it("broadcast hits all connected peers, optionally excluding one", async () => {
    const server = track(new CoreTransport({ label: "srv" }));
    const a = track(new CoreTransport({ label: "a" }));
    const b = track(new CoreTransport({ label: "b" }));
    const port = freePort();
    await server.listen(port);

    const aGot: CoreMessage[] = [];
    const bGot: CoreMessage[] = [];
    a.onMessage((_id, m) => aGot.push(m));
    b.onMessage((_id, m) => bGot.push(m));

    await a.connect(`ws://127.0.0.1:${port}`);
    await b.connect(`ws://127.0.0.1:${port}`);

    await new Promise((r) => setTimeout(r, 30));
    expect(server.peerCount).toBe(2);

    const peers = server.getPeerIds();
    const m1: CoreMessage = { protocol: "/test/1", payload: "all" };
    server.broadcast(m1);

    await new Promise((r) => setTimeout(r, 50));
    expect(aGot).toHaveLength(1);
    expect(bGot).toHaveLength(1);

    // exclude one
    const onlyOne: CoreMessage = { protocol: "/test/1", payload: "one" };
    server.broadcast(onlyOne, peers[0]);

    await new Promise((r) => setTimeout(r, 50));
    expect(aGot.length + bGot.length).toBe(3); // 2 from earlier + 1 from exclude
  });

  it("connect handlers fire for both sides", async () => {
    const server = track(new CoreTransport({ label: "srv" }));
    const client = track(new CoreTransport({ label: "cli" }));
    const port = freePort();
    await server.listen(port);

    const serverConnects: string[] = [];
    const clientConnects: string[] = [];
    server.onPeerConnect((id) => serverConnects.push(id));
    client.onPeerConnect((id) => clientConnects.push(id));

    await client.connect(`ws://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 30));

    expect(serverConnects).toHaveLength(1);
    expect(clientConnects).toHaveLength(1);
  });

  it("disconnect handlers fire on close", async () => {
    const server = track(new CoreTransport({ label: "srv" }));
    const client = track(new CoreTransport({ label: "cli" }));
    const port = freePort();
    await server.listen(port);

    const serverDisc: string[] = [];
    server.onPeerDisconnect((id) => serverDisc.push(id));

    await client.connect(`ws://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 30));

    await client.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(serverDisc).toHaveLength(1);
  });

  it("getStats reports byte and connection counters", async () => {
    const server = track(new CoreTransport({ label: "srv" }));
    const client = track(new CoreTransport({ label: "cli" }));
    const port = freePort();
    await server.listen(port);

    await client.connect(`ws://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 30));

    client.send(client.getPeerIds()[0]!, { protocol: "/p/1", payload: "x" });
    await new Promise((r) => setTimeout(r, 30));

    const cStats = client.getStats();
    const sStats = server.getStats();
    expect(cStats.outboundConnections).toBe(1);
    expect(sStats.inboundConnections).toBe(1);
    expect(cStats.bytesSent).toBeGreaterThan(0);
    expect(sStats.bytesReceived).toBeGreaterThan(0);
  });

  it("malformed JSON does not crash the receiver", async () => {
    const server = track(new CoreTransport({ label: "srv" }));
    const port = freePort();
    await server.listen(port);

    const { WebSocket } = await import("ws");
    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => raw.once("open", r));

    // garbage message
    raw.send("this is not json");
    await new Promise((r) => setTimeout(r, 30));

    expect(server.peerCount).toBe(1); // still connected, didn't blow up
    raw.close();
  });
});
