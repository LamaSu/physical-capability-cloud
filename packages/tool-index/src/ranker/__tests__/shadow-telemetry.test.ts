import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendShadowEvent,
  buildShadowEvent,
  resolveShadowLogPath,
} from "../shadow-telemetry.js";

describe("resolveShadowLogPath", () => {
  it("honors PCC_RANKER_SHADOW_LOG when set", () => {
    const p = resolveShadowLogPath({
      PCC_RANKER_SHADOW_LOG: "/tmp/x.jsonl",
    } as NodeJS.ProcessEnv);
    expect(p).toMatch(/x\.jsonl$/);
  });

  it("falls back to ~/.claude/audit/ranker-shadow.jsonl", () => {
    const p = resolveShadowLogPath({ HOME: "/home/test" } as NodeJS.ProcessEnv);
    expect(p).toBe("/home/test/.claude/audit/ranker-shadow.jsonl");
  });
});

describe("buildShadowEvent", () => {
  it("computes overlap correctly", () => {
    const event = buildShadowEvent({
      query: "summarize",
      legacyTop5: [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.8 },
        { id: "c", score: 0.7 },
      ],
      hybridTop5: [
        { id: "a", score: 10 },
        { id: "c", score: 8 },
        { id: "d", score: 5 },
      ],
      now: new Date("2026-05-23T12:00:00.000Z"),
    });
    expect(event.overlap).toBe(2);
    expect(event.ts).toBe("2026-05-23T12:00:00.000Z");
    expect(event.query).toBe("summarize");
  });

  it("rankDelta reflects rank shifts per id", () => {
    const event = buildShadowEvent({
      query: "x",
      legacyTop5: [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.8 },
      ],
      hybridTop5: [
        { id: "b", score: 10 },
        { id: "a", score: 5 },
      ],
    });
    const a = event.rankDelta.find((d) => d.id === "a");
    const b = event.rankDelta.find((d) => d.id === "b");
    expect(a?.legacyRank).toBe(1);
    expect(a?.hybridRank).toBe(2);
    expect(b?.legacyRank).toBe(2);
    expect(b?.hybridRank).toBe(1);
  });

  it("null ranks for ids present in only one list", () => {
    const event = buildShadowEvent({
      query: "x",
      legacyTop5: [{ id: "a", score: 0.9 }],
      hybridTop5: [{ id: "b", score: 10 }],
    });
    const a = event.rankDelta.find((d) => d.id === "a");
    const b = event.rankDelta.find((d) => d.id === "b");
    expect(a?.hybridRank).toBeNull();
    expect(b?.legacyRank).toBeNull();
  });
});

describe("appendShadowEvent (fire-and-forget)", () => {
  const tmpPath = join(tmpdir(), `pcc-ranker-shadow-${process.pid}.jsonl`);
  afterEach(async () => {
    await rm(tmpPath, { force: true });
  });

  it("writes JSONL line + creates parent dir", async () => {
    const event = buildShadowEvent({
      query: "x",
      legacyTop5: [{ id: "a", score: 0.5 }],
      hybridTop5: [{ id: "a", score: 10 }],
    });
    await appendShadowEvent(event, { path: tmpPath });
    const contents = await readFile(tmpPath, "utf-8");
    expect(contents.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(contents.trim());
    expect(parsed.query).toBe("x");
    expect(parsed.overlap).toBe(1);
  });

  it("never throws — error hook receives the error", async () => {
    let err: unknown;
    // Use a path with a colon on Windows / an obviously-invalid char
    // on POSIX. Either way the write should fail and the hook should fire.
    const invalid = join(tmpdir(), "\0invalid", "x.jsonl");
    const event = buildShadowEvent({
      query: "x",
      legacyTop5: [],
      hybridTop5: [],
    });
    await expect(
      appendShadowEvent(event, {
        path: invalid,
        onError: (e) => {
          err = e;
        },
      }),
    ).resolves.toBeUndefined();
    expect(err).toBeTruthy();
  });

  it("appends successive events as separate lines", async () => {
    // Pre-create the dir so this case isolates the append behaviour.
    await mkdir(tmpdir(), { recursive: true });
    const e1 = buildShadowEvent({
      query: "q1",
      legacyTop5: [{ id: "a", score: 1 }],
      hybridTop5: [{ id: "a", score: 1 }],
    });
    const e2 = buildShadowEvent({
      query: "q2",
      legacyTop5: [{ id: "b", score: 1 }],
      hybridTop5: [{ id: "b", score: 1 }],
    });
    await appendShadowEvent(e1, { path: tmpPath });
    await appendShadowEvent(e2, { path: tmpPath });
    const lines = (await readFile(tmpPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).query).toBe("q1");
    expect(JSON.parse(lines[1]!).query).toBe("q2");
  });
});
