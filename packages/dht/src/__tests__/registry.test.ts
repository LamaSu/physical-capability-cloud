import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AnnouncementRegistry } from "../registry.js";
import type { CapabilityAnnouncement } from "@pcc/spec";

// ── Helpers ──────────────────────────────────────────────────────

function makeAnnouncement(
  overrides: Partial<CapabilityAnnouncement> = {},
): CapabilityAnnouncement {
  return {
    kernelDid: `did:pcc:kernel-${Math.random().toString(36).slice(2, 8)}`,
    kernelId: "kernel-001",
    capabilities: [{ type: "fdm_print", materials: ["PLA", "PETG"] }],
    endpoints: [
      { transport: "websocket-direct", url: "wss://k.local:8443", priority: 1 },
    ],
    ttlSeconds: 300,
    timestamp: new Date().toISOString(),
    signature: "mock-sig",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("AnnouncementRegistry", () => {
  let registry: AnnouncementRegistry;

  beforeEach(() => {
    registry = new AnnouncementRegistry({ pruneIntervalMs: 60_000 });
  });

  afterEach(() => {
    registry.stopPruning();
  });

  // ── store ──────────────────────────────────────────────────────

  it("stores an announcement and retrieves it", () => {
    const a = makeAnnouncement({ kernelDid: "did:pcc:k1" });
    registry.store(a);
    expect(registry.size).toBe(1);

    const stored = registry.get("did:pcc:k1");
    expect(stored).toBeDefined();
    expect(stored!.announcement.kernelDid).toBe("did:pcc:k1");
    expect(stored!.hops).toBe(0);
  });

  it("overwrites an existing announcement for the same kernelDid", () => {
    const a1 = makeAnnouncement({ kernelDid: "did:pcc:k1", kernelId: "v1" });
    const a2 = makeAnnouncement({ kernelDid: "did:pcc:k1", kernelId: "v2" });
    registry.store(a1);
    registry.store(a2);
    expect(registry.size).toBe(1);
    expect(registry.get("did:pcc:k1")!.announcement.kernelId).toBe("v2");
  });

  it("stores multiple announcements from different kernels", () => {
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:k1" }));
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:k2" }));
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:k3" }));
    expect(registry.size).toBe(3);
  });

  it("records hops count", () => {
    const a = makeAnnouncement();
    registry.store(a, 3);
    const stored = registry.get(a.kernelDid);
    expect(stored!.hops).toBe(3);
  });

  // ── prune ──────────────────────────────────────────────────────

  it("prunes expired announcements", () => {
    // Store with a very short TTL
    const a = makeAnnouncement({ kernelDid: "did:pcc:expired", ttlSeconds: 0 });
    registry.store(a);
    expect(registry.size).toBe(1);

    // TTL of 0 means immediate expiry
    const pruned = registry.prune();
    expect(pruned).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("does not prune non-expired announcements", () => {
    const a = makeAnnouncement({ ttlSeconds: 600 });
    registry.store(a);
    const pruned = registry.prune();
    expect(pruned).toBe(0);
    expect(registry.size).toBe(1);
  });

  it("prunes a mix of expired and active announcements", () => {
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:alive", ttlSeconds: 600 }));
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:dead", ttlSeconds: 0 }));
    const pruned = registry.prune();
    expect(pruned).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.get("did:pcc:alive")).toBeDefined();
    expect(registry.get("did:pcc:dead")).toBeUndefined();
  });

  // ── query ──────────────────────────────────────────────────────

  it("queries by capability type", () => {
    registry.store(
      makeAnnouncement({
        kernelDid: "did:pcc:fdm",
        capabilities: [{ type: "fdm_print" }],
      }),
    );
    registry.store(
      makeAnnouncement({
        kernelDid: "did:pcc:laser",
        capabilities: [{ type: "laser_cut" }],
      }),
    );

    const results = registry.query({ type: "fdm_print" });
    expect(results).toHaveLength(1);
    expect(results[0].kernelDid).toBe("did:pcc:fdm");
  });

  it("returns all when no filters specified", () => {
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:a" }));
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:b" }));
    const results = registry.query({});
    expect(results).toHaveLength(2);
  });

  it("queries by materials", () => {
    registry.store(
      makeAnnouncement({
        kernelDid: "did:pcc:pla",
        capabilities: [{ type: "fdm_print", materials: ["PLA"] }],
      }),
    );
    registry.store(
      makeAnnouncement({
        kernelDid: "did:pcc:metal",
        capabilities: [{ type: "cnc", materials: ["Aluminum"] }],
      }),
    );

    const results = registry.query({ materials: ["PLA"] });
    expect(results).toHaveLength(1);
    expect(results[0].kernelDid).toBe("did:pcc:pla");
  });

  // ── getAll ─────────────────────────────────────────────────────

  it("getAll returns all active announcements", () => {
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:x" }));
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:y" }));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
  });

  // ── remove ─────────────────────────────────────────────────────

  it("removes a specific announcement", () => {
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:rm" }));
    expect(registry.size).toBe(1);
    const removed = registry.remove("did:pcc:rm");
    expect(removed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("returns false when removing non-existent announcement", () => {
    const removed = registry.remove("did:pcc:nope");
    expect(removed).toBe(false);
  });

  // ── stats ──────────────────────────────────────────────────────

  it("stats returns counts by capability type", () => {
    registry.store(
      makeAnnouncement({
        kernelDid: "did:pcc:a",
        capabilities: [{ type: "fdm_print" }, { type: "laser_cut" }],
      }),
    );
    registry.store(
      makeAnnouncement({
        kernelDid: "did:pcc:b",
        capabilities: [{ type: "fdm_print" }],
      }),
    );

    const s = registry.stats();
    expect(s["fdm_print"]).toBe(2);
    expect(s["laser_cut"]).toBe(1);
  });

  it("stats returns empty for empty registry", () => {
    expect(registry.stats()).toEqual({ _evidence_total: 0 });
  });

  // ── clear ──────────────────────────────────────────────────────

  it("clear removes all announcements", () => {
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:a" }));
    registry.store(makeAnnouncement({ kernelDid: "did:pcc:b" }));
    registry.clear();
    expect(registry.size).toBe(0);
  });
});
