import { describe, it, expect } from "vitest";
import { ResourcePool, ResourceBusyError } from "../resource-pool.js";

describe("ResourcePool", () => {
  it("claims and releases a resource", () => {
    const pool = new ResourcePool();
    const claim = pool.claim("node_A", "wf_1");

    expect(claim.nodeId).toBe("node_A");
    expect(claim.claimedBy).toBe("wf_1");
    expect(claim.released).toBe(false);
    expect(pool.isAvailable("node_A")).toBe(false);

    pool.release(claim.id);

    expect(claim.released).toBe(true);
    expect(claim.releasedAt).toBeDefined();
    expect(pool.isAvailable("node_A")).toBe(true);
  });

  it("throws ResourceBusyError on double claim", () => {
    const pool = new ResourcePool();
    pool.claim("node_A", "wf_1");

    expect(() => pool.claim("node_A", "wf_2")).toThrow(ResourceBusyError);

    try {
      pool.claim("node_A", "wf_2");
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceBusyError);
      expect((err as ResourceBusyError).nodeId).toBe("node_A");
    }
  });

  it("waitForAvailability resolves when released", async () => {
    const pool = new ResourcePool();
    const firstClaim = pool.claim("node_A", "wf_1");

    // Start waiting in the background
    const waitPromise = pool.waitForAvailability("node_A", "wf_2");

    // Release after a short delay
    setTimeout(() => pool.release(firstClaim.id), 10);

    const secondClaim = await waitPromise;
    expect(secondClaim.nodeId).toBe("node_A");
    expect(secondClaim.claimedBy).toBe("wf_2");
  });

  it("waitForAvailability rejects on timeout", async () => {
    const pool = new ResourcePool();
    pool.claim("node_A", "wf_1");

    await expect(
      pool.waitForAvailability("node_A", "wf_2", 15),
    ).rejects.toThrow(/Timed out/);
  });

  it("resolves waiters in FIFO order", async () => {
    const pool = new ResourcePool();
    const claim = pool.claim("node_A", "wf_0");

    const order: string[] = [];

    const p1 = pool.waitForAvailability("node_A", "wf_1").then((c) => {
      order.push("wf_1");
      // Release so next waiter can proceed
      pool.release(c.id);
    });

    const p2 = pool.waitForAvailability("node_A", "wf_2").then((c) => {
      order.push("wf_2");
      pool.release(c.id);
    });

    const p3 = pool.waitForAvailability("node_A", "wf_3").then((c) => {
      order.push("wf_3");
      pool.release(c.id);
    });

    // Kick off the chain by releasing the initial claim
    pool.release(claim.id);

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["wf_1", "wf_2", "wf_3"]);
  });

  it("auto-releases expired claims", async () => {
    const pool = new ResourcePool();

    // Claim with a very short expiration
    pool.claim("node_A", "wf_1", 10);

    expect(pool.isAvailable("node_A")).toBe(false);

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 20));

    // checkExpired is called internally by isAvailable
    expect(pool.isAvailable("node_A")).toBe(true);
  });

  it("getAllClaims returns all claims including released", () => {
    const pool = new ResourcePool();
    const c1 = pool.claim("node_A", "wf_1");
    const c2 = pool.claim("node_B", "wf_2");
    pool.release(c1.id);

    const all = pool.getAllClaims();
    expect(all).toHaveLength(2);

    const released = all.find((c) => c.id === c1.id);
    expect(released?.released).toBe(true);

    const active = all.find((c) => c.id === c2.id);
    expect(active?.released).toBe(false);
  });
});
