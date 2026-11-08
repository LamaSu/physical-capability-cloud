/**
 * E11f HIGH 1: a TMP task's terms are durable and write-once on the gateway's volume (the steward's ruling
 * on #6309). One file per milestone, named by the sha256 hex of its id, created exclusively.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsTmpTaskStore, MemoryTmpTaskStore, tmpTaskFileName, type TmpTaskRecord } from "../services/tmp-task-store.js";

const task = (milestoneId: string, acceptedTier: 0 | 1 | 2 | 3 = 3): TmpTaskRecord =>
  ({
    milestoneId,
    mode: "benchmark",
    modeConfig: { mode: "benchmark", metricTarget: "dimensional_accuracy >= 0.95", proofType: "sensor_evidence" },
    acceptedTier,
    owner: "op-admin",
    status: "pending",
    createdAt: "2026-10-03T12:00:00.000Z",
  }) as TmpTaskRecord;

describe("FsTmpTaskStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmp-task-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("creates a task once; a second creation, even through another store on the directory (a restart), changes nothing", async () => {
    const first = new FsTmpTaskStore(dir);
    expect(await first.createOnce(task("m-1", 3))).toBe(true);
    expect(await first.createOnce(task("m-1", 0))).toBe(false);
    const restarted = new FsTmpTaskStore(dir);
    expect(await restarted.createOnce(task("m-1", 0))).toBe(false);
    expect((await restarted.get("m-1"))?.acceptedTier).toBe(3);
    expect(await restarted.get("m-2")).toBeUndefined();
  });

  it("concurrent creations of one milestone: exactly one wins, and its record is the one stored", async () => {
    const tiers = [0, 1, 2, 3] as const;
    const results = await Promise.all(tiers.map((t) => new FsTmpTaskStore(dir).createOnce(task("m-race", t))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await new FsTmpTaskStore(dir).get("m-race"))?.acceptedTier).toBe(tiers[results.indexOf(true)]);
  });

  it("names each file by the sha256 hex of the milestone id, so no id names a path outside the directory", async () => {
    const store = new FsTmpTaskStore(dir);
    const ids = ["../../escape", "/etc/passwd", "a/b", "..", "m-1", "nul\u0000byte"];
    for (const id of ids) expect(await store.createOnce(task(id)), id).toBe(true);
    const expected = ids.map((id) => `${createHash("sha256").update(id, "utf8").digest("hex")}.json`).sort();
    expect(readdirSync(dir).sort()).toEqual(expected);
    for (const id of ids) expect((await store.get(id))?.milestoneId, id).toBe(id);
    expect(tmpTaskFileName("m-1")).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("leaves no temporary file behind, whether it creates or refuses", async () => {
    const store = new FsTmpTaskStore(dir);
    await store.createOnce(task("m-1"));
    await store.createOnce(task("m-1", 0));
    expect(readdirSync(dir)).toEqual([tmpTaskFileName("m-1")]);
  });

  it("refuses a record that isn't the milestone's own, and an unreadable one", async () => {
    const store = new FsTmpTaskStore(dir);
    // A record copied under another milestone's name.
    writeFileSync(join(dir, tmpTaskFileName("m-2")), JSON.stringify(task("m-1", 0)));
    await expect(store.get("m-2")).rejects.toThrow(/not this milestone's/);
    writeFileSync(join(dir, tmpTaskFileName("m-3")), "{not json");
    await expect(store.get("m-3")).rejects.toThrow();
    writeFileSync(join(dir, tmpTaskFileName("m-4")), "null");
    await expect(store.get("m-4")).rejects.toThrow(/not this milestone's/);
  });

  it("resolves its root like the gateway's other durable stores: PCC_TMP_TASK_DIR, then the Railway volume, then ./data", () => {
    vi.stubEnv("PCC_TMP_TASK_DIR", "/override/tmp-tasks");
    expect(new FsTmpTaskStore().rootDir).toBe("/override/tmp-tasks");
    vi.stubEnv("PCC_TMP_TASK_DIR", "");
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "/volume");
    expect(new FsTmpTaskStore().rootDir).toBe(join("/volume", "tmp-tasks"));
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
    expect(new FsTmpTaskStore().rootDir).toBe(join("./data", "tmp-tasks"));
  });
});

describe("MemoryTmpTaskStore (tests only)", () => {
  it("is write-once, and what it returns is a copy", async () => {
    const store = new MemoryTmpTaskStore();
    expect(await store.createOnce(task("m-1", 3))).toBe(true);
    expect(await store.createOnce(task("m-1", 0))).toBe(false);
    const got = await store.get("m-1");
    got!.acceptedTier = 0;
    expect((await store.get("m-1"))?.acceptedTier).toBe(3);
  });
});
