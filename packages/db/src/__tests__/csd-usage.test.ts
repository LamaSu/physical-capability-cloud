import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store, type ICsdUsageRepository } from "../index.js";

// ── CsdUsageRepository (SQLite-backed) ───────────────────────────────────────
//
// Mirrors the in-memory contract in @pcc/spec exactly: count, dedup-with-cap
// on recentAdopters, lastUsedAt stamp. The shared behavior is what makes the
// gateway swap-in safe.

describe("CsdUsageRepository", () => {
  let store: Store;
  let repo: ICsdUsageRepository;

  beforeEach(() => {
    store = createStore({ seed: false });
    repo = store.repos.csdUsage;
  });

  afterEach(() => {
    store.close();
  });

  // ── get / zero shape ───────────────────────────────────────────────────────

  it("get returns the zero shape for a never-recorded URL", () => {
    const u = repo.get("pcc://capabilities/fdm/v2");
    expect(u.count).toBe(0);
    expect(u.recentAdopters).toEqual([]);
    expect(u.lastUsedAt).toBeNull();
  });

  // ── record / increment ─────────────────────────────────────────────────────

  it("record creates a row on first call with count=1 and the adopter", () => {
    repo.record("pcc://capabilities/fdm/v2", "agent-1");
    const u = repo.get("pcc://capabilities/fdm/v2");
    expect(u.count).toBe(1);
    expect(u.recentAdopters).toEqual(["agent-1"]);
    expect(u.lastUsedAt).toBeTruthy();
    // ISO-8601 string
    expect(new Date(u.lastUsedAt!).toString()).not.toBe("Invalid Date");
  });

  it("record increments count on subsequent calls", () => {
    repo.record("pcc://capabilities/fdm/v2", "agent-1");
    repo.record("pcc://capabilities/fdm/v2", "agent-2");
    repo.record("pcc://capabilities/fdm/v2", "agent-3");
    const u = repo.get("pcc://capabilities/fdm/v2");
    expect(u.count).toBe(3);
    expect(u.recentAdopters).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  // ── dedup behavior ─────────────────────────────────────────────────────────

  it("dedupes recent adopters but still counts every adoption", () => {
    repo.record("pcc://capabilities/fdm/v2", "agent-1");
    repo.record("pcc://capabilities/fdm/v2", "agent-2");
    repo.record("pcc://capabilities/fdm/v2", "agent-1"); // dedup — moves agent-1 to end
    const u = repo.get("pcc://capabilities/fdm/v2");
    expect(u.count).toBe(3);
    // agent-1 should appear once, at the end (most recent)
    expect(u.recentAdopters).toEqual(["agent-2", "agent-1"]);
  });

  // ── 50-cap ─────────────────────────────────────────────────────────────────

  it("caps recentAdopters at 50, dropping the oldest first", () => {
    for (let i = 0; i < 55; i++) {
      repo.record("pcc://capabilities/fdm/v2", `agent-${i}`);
    }
    const u = repo.get("pcc://capabilities/fdm/v2");
    expect(u.count).toBe(55);
    expect(u.recentAdopters.length).toBe(50);
    // The 5 oldest (agent-0..agent-4) should be dropped; newest is agent-54.
    expect(u.recentAdopters[0]).toBe("agent-5");
    expect(u.recentAdopters[u.recentAdopters.length - 1]).toBe("agent-54");
  });

  // ── getMany ────────────────────────────────────────────────────────────────

  it("getMany returns rows for recorded URLs and zero shape for the rest", () => {
    repo.record("pcc://capabilities/fdm/v2", "a");
    repo.record("pcc://capabilities/sla/v2", "b");
    const m = repo.getMany([
      "pcc://capabilities/fdm/v2",
      "pcc://capabilities/sla/v2",
      "pcc://capabilities/cnc-3axis/v2", // never recorded
    ]);
    expect(m.get("pcc://capabilities/fdm/v2")?.count).toBe(1);
    expect(m.get("pcc://capabilities/sla/v2")?.count).toBe(1);
    const cnc = m.get("pcc://capabilities/cnc-3axis/v2");
    expect(cnc).toBeDefined();
    expect(cnc!.count).toBe(0);
    expect(cnc!.recentAdopters).toEqual([]);
  });

  it("getMany returns empty map for empty input", () => {
    const m = repo.getMany([]);
    expect(m.size).toBe(0);
  });

  // ── persistence — file-backed roundtrip ────────────────────────────────────

  it("survives store close+reopen on a file-backed database", async () => {
    store.close();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "csd-usage-roundtrip-"));
    const dbPath = join(dir, "pcc.sqlite");
    try {
      // Round 1 — write
      const s1 = createStore({ dbPath, seed: false });
      s1.repos.csdUsage.record("pcc://capabilities/fdm/v2", "agent-1");
      s1.repos.csdUsage.record("pcc://capabilities/fdm/v2", "agent-2");
      s1.repos.csdUsage.record("pcc://capabilities/sla/v2", "agent-1");
      const beforeClose = s1.repos.csdUsage.get("pcc://capabilities/fdm/v2");
      expect(beforeClose.count).toBe(2);
      s1.close();

      // Round 2 — reopen the same file
      const s2 = createStore({ dbPath, seed: false });
      const afterReopen = s2.repos.csdUsage.get("pcc://capabilities/fdm/v2");
      expect(afterReopen.count).toBe(2);
      expect(afterReopen.recentAdopters).toEqual(["agent-1", "agent-2"]);
      expect(afterReopen.lastUsedAt).toBe(beforeClose.lastUsedAt);
      // SLA usage also survived
      expect(s2.repos.csdUsage.get("pcc://capabilities/sla/v2").count).toBe(1);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The outer afterEach() expects store.close() to be valid; recreate an in-memory store
    store = createStore({ seed: false });
    repo = store.repos.csdUsage;
  });
});
