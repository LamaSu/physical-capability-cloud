import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createDataPort } from "../../src/data-port/port.js";
import { createDataManager } from "../../src/data-port/manager.js";
import { openSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";
import type { Token } from "../../src/shared/types.js";
import { PortClosedError } from "../../src/shared/types.js";

function makeToken<T>(value: T, tag = "/step/iter_0"): Token<T> {
  return {
    value,
    tag,
    recoverable: true,
    locations: [],
  };
}

describe("DataPort — put/get happy path", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("put then get returns the same token (queue mode)", async () => {
    const port = createDataPort<number>({ name: "p", store });
    const token = makeToken(42);
    await port.put(token);
    const got = await port.get("consumer-1");
    expect(got.value).toBe(42);
    expect(got.tag).toBe("/step/iter_0");
  });

  it("get awaits when queue is empty, resolves on subsequent put (waiter mode)", async () => {
    const port = createDataPort<string>({ name: "p2", store });
    const fetchPromise = port.get("consumer");
    // Put after a microtask boundary.
    setTimeout(async () => {
      await port.put(makeToken("hello"));
    }, 0);
    const token = await fetchPromise;
    expect(token.value).toBe("hello");
  });

  it("multiple puts accumulate in the queue in FIFO order", async () => {
    const port = createDataPort<number>({ name: "p3", store });
    await port.put(makeToken(1, "/a"));
    await port.put(makeToken(2, "/b"));
    await port.put(makeToken(3, "/c"));
    const a = await port.get("c");
    const b = await port.get("c");
    const c = await port.get("c");
    expect([a.value, b.value, c.value]).toEqual([1, 2, 3]);
  });

  it("empty() reflects queue + waiters state", async () => {
    const port = createDataPort<number>({ name: "p4", store });
    expect(port.empty()).toBe(true);
    await port.put(makeToken(1));
    expect(port.empty()).toBe(false);
    await port.get("c");
    expect(port.empty()).toBe(true);
  });
});

describe("DataPort — close / schema / edge cases", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("close rejects pending waiters with PortClosedError", async () => {
    const port = createDataPort<number>({ name: "p5", store });
    const waiter = port.get("c");
    await port.close("c");
    await expect(waiter).rejects.toBeInstanceOf(PortClosedError);
  });

  it("put after close throws PortClosedError", async () => {
    const port = createDataPort<number>({ name: "p6", store });
    await port.close("c");
    await expect(port.put(makeToken(1))).rejects.toBeInstanceOf(PortClosedError);
  });

  it("schema validation rejects invalid put", async () => {
    const port = createDataPort<number>({
      name: "p7",
      store,
      schema: z.number().int().min(0),
    });
    await expect(port.put(makeToken(-1 as number))).rejects.toThrow();
  });

  it("schema validation passes for valid values", async () => {
    const port = createDataPort<number>({
      name: "p8",
      store,
      schema: z.number().int().min(0),
    });
    await expect(port.put(makeToken(10))).resolves.toBeUndefined();
  });
});

describe("DataManager — registration + routing", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("registerPath + getSourceLocation returns the available primary row", async () => {
    const mgr = createDataManager({ store });
    await mgr.registerPath({
      portId: "p",
      kernelId: "gateway:local",
      scheme: "fs",
      path: "/tmp/out.csv",
      dataType: "primary",
      available: true,
    });
    const loc = await mgr.getSourceLocation("p");
    expect(loc).not.toBeNull();
    expect(loc!.kernelId).toBe("gateway:local");
  });

  it("preferredKernel match wins over scheme priority", async () => {
    const mgr = createDataManager({ store });
    await mgr.registerPath({
      portId: "pq",
      kernelId: "storacha",
      scheme: "storacha",
      path: "bafy...",
      dataType: "primary",
      available: true,
    });
    await mgr.registerPath({
      portId: "pq",
      kernelId: "dgx-spark",
      scheme: "p2p",
      path: "/cache/x",
      dataType: "primary",
      available: true,
    });
    const spark = await mgr.getSourceLocation("pq", "dgx-spark");
    expect(spark?.kernelId).toBe("dgx-spark");
  });

  it("falls back to scheme priority when no kernel match (p2p > fs > ipfs > storacha > http > onchain)", async () => {
    const mgr = createDataManager({ store });
    await mgr.registerPath({
      portId: "pr",
      kernelId: "k1",
      scheme: "storacha",
      path: "x",
      dataType: "primary",
      available: true,
    });
    await mgr.registerPath({
      portId: "pr",
      kernelId: "k2",
      scheme: "p2p",
      path: "y",
      dataType: "primary",
      available: true,
    });
    const loc = await mgr.getSourceLocation("pr");
    expect(loc?.scheme).toBe("p2p");
  });

  it("invalidateLocation flips data_type to 'invalid' and removes it from source pool", async () => {
    const mgr = createDataManager({ store });
    const loc = await mgr.registerPath({
      portId: "pi",
      kernelId: "k1",
      scheme: "fs",
      path: "/x",
      dataType: "primary",
      available: true,
    });
    await mgr.invalidateLocation(loc.locationId);
    const src = await mgr.getSourceLocation("pi");
    expect(src).toBeNull();
  });

  it("transferData creates a derived row with sourceLocationId set", async () => {
    const mgr = createDataManager({ store });
    const src = await mgr.registerPath({
      portId: "pt",
      kernelId: "k1",
      scheme: "fs",
      path: "/src",
      dataType: "primary",
      available: true,
      sizeBytes: 123,
    });
    const dst = await mgr.transferData(src, {
      kernelId: "k2",
      scheme: "fs",
      path: "/dst",
      portId: "pt",
    });
    expect(dst.sourceLocationId).toBe(src.locationId);
    expect(dst.available).toBe(true);
    expect(dst.sizeBytes).toBe(123);
  });

  it("transferData from invalid source throws TransferFailedError", async () => {
    const mgr = createDataManager({ store });
    const src = await mgr.registerPath({
      portId: "pt2",
      kernelId: "k1",
      scheme: "fs",
      path: "/x",
      dataType: "primary",
      available: true,
    });
    await mgr.invalidateLocation(src.locationId);
    // We still have the old row in memory; reconstruct by reading back.
    const rows = await store.dataLocations.getByPort("pt2");
    const invalid = rows.find((r) => r.locationId === src.locationId)!;
    await expect(
      mgr.transferData(invalid, { kernelId: "k2", scheme: "fs", path: "/y", portId: "pt2" }),
    ).rejects.toThrow(/invalid source/);
  });
});
