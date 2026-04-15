import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createCidHandoff,
  makeSha256CidHandoff,
} from "../../src/data-port/cid-handoff.js";
import { openSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";

describe("CidHandoff — sha256 test adapter", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("pin produces a deterministic sha256:<hex> CID from canonical JSON", async () => {
    const handoff = makeSha256CidHandoff<{ a: number; b: number }>(store);
    const a = await handoff.pin({ a: 1, b: 2 });
    const b = await handoff.pin({ b: 2, a: 1 }); // different key order, same logical value
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
    expect(a.slice("sha256:".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fetch round-trips to the same value", async () => {
    const handoff = makeSha256CidHandoff<{ x: number }>(store);
    const cid = await handoff.pin({ x: 42 });
    const v = await handoff.fetch(cid);
    expect(v).toEqual({ x: 42 });
  });

  it("fetch on unknown CID rejects", async () => {
    const handoff = makeSha256CidHandoff<{ x: number }>(store);
    await expect(handoff.fetch("sha256:" + "0".repeat(64))).rejects.toThrow(
      /not found/,
    );
  });

  it("toDataLocation produces a DataLocationRegisterArgs-like payload", async () => {
    const handoff = makeSha256CidHandoff<{ x: number }>(store);
    const cid = await handoff.pin({ x: 1 });
    const staged = await handoff.toDataLocation(cid, "my-port", "run-xyz");
    expect(staged.portId).toBe("my-port");
    expect(staged.runId).toBe("run-xyz");
    expect(staged.path).toBe(cid);
    expect(staged.kernelId).toBe("storacha");
    expect(staged.available).toBe(true);
  });
});

describe("CidHandoff — custom injected pin/fetch", () => {
  it("uses injected pin + fetch exactly once per call", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    let pinCalls = 0;
    let fetchCalls = 0;
    const handoff = createCidHandoff<{ id: string }>({
      store,
      async pin(v) {
        pinCalls++;
        return "custom:" + v.id;
      },
      async fetch(cid) {
        fetchCalls++;
        return { id: cid.replace(/^custom:/, "") };
      },
      kernelId: "custom-kernel",
      scheme: "ipfs",
    });
    const cid = await handoff.pin({ id: "abc" });
    expect(cid).toBe("custom:abc");
    expect(pinCalls).toBe(1);
    const v = await handoff.fetch(cid);
    expect(v).toEqual({ id: "abc" });
    expect(fetchCalls).toBe(1);
    await store.close();
  });

  it("injected kernelId and scheme propagate through toDataLocation", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const handoff = createCidHandoff<{ id: string }>({
      store,
      async pin() {
        return "cid-1";
      },
      async fetch() {
        return { id: "dummy" };
      },
      kernelId: "custom-kernel",
      scheme: "ipfs",
    });
    const staged = await handoff.toDataLocation("cid-1", "port-x");
    expect(staged.kernelId).toBe("custom-kernel");
    await store.close();
  });
});

describe("CidHandoff — end-to-end with DataLocationStore", () => {
  it("pin → toDataLocation → store.dataLocations.register registers a 'primary' ipfs row", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const handoff = makeSha256CidHandoff<{ n: number }>(store);
    const cid = await handoff.pin({ n: 7 });
    const staged = await handoff.toDataLocation(cid, "port-1", "run-1");
    const loc = await store.dataLocations.register({
      ...staged,
      scheme: "storacha",
      dataType: "primary",
    });
    expect(loc.kernelId).toBe("storacha");
    expect(loc.path).toBe(cid);
    expect(loc.available).toBe(true);
    expect(loc.runId).toBe("run-1");
    await store.close();
  });
});
