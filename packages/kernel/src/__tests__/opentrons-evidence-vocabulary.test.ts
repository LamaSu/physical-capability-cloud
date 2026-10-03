/**
 * The Opentrons adapter's evidence uses the closed vocabulary and says what
 * the robot reported, against a fake Opentrons HTTP API (real mode).
 *
 *   upload           -> method_loaded (with the protocol's sha256)
 *   first play       -> execution_started
 *   pause / resume   -> execution_progress
 *   stop             -> execution_failed
 *   robot: succeeded -> execution_completed, once
 *   robot: failed    -> execution_failed, once, and the run is released
 *
 * Robot-local ids are opentronsRunId / opentronsProtocolId: jobId and the unit
 * fields are reserved for the PCC binding the EvidenceEmitter stamps.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { EVIDENCE_EVENT_TYPES, type EvidenceEvent } from "@pcc/spec";
import { OpentronsMachineAdapter } from "../opentrons/adapter.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
const RESERVED = ["jobId", "settlementUnitId", "challengeNonce", "kernelId", "outputHash"];
const SOURCE = "from opentrons import protocol_api\nmetadata = {'apiLevel': '2.18'}\n";

/** A fake robot: one protocol, one run, whose status the test sets. */
function fakeRobot() {
  const robot = {
    runStatus: "running" as string,
    errors: [] as Array<{ detail: string; createdAt: string }>,
    actions: [] as string[],
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/health") return json({});
    if (path === "/protocols" && method === "POST") return json({ data: { id: "proto-1" } });
    if (path === "/protocols") return json({ data: [{ id: "proto-1", metadata: { protocolName: "p" } }] });
    if (path === "/runs" && method === "POST") return json({ data: { id: "run-1" } });
    if (path === "/runs/run-1/actions") {
      robot.actions.push(JSON.parse(String(init?.body)).data.actionType);
      return json({ data: {} });
    }
    if (path === "/runs/run-1") {
      return json({
        data: {
          id: "run-1",
          protocolId: "proto-1",
          status: robot.runStatus,
          progress: 0,
          errors: robot.errors,
          createdAt: "2026-09-24T00:00:00Z",
          commands: [
            { id: "c1", commandType: "aspirate", status: "succeeded", params: {}, createdAt: "2026-09-24T00:00:01Z" },
            { id: "c2", commandType: "dispense", status: robot.runStatus === "succeeded" ? "succeeded" : "running", params: {}, createdAt: "2026-09-24T00:00:02Z" },
          ],
        },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return robot;
}

async function adapterWithRobot() {
  const robot = fakeRobot();
  const ot = new OpentronsMachineAdapter("otkernel-vocab", { url: "http://ot2.local:31950", mockMode: false });
  const events: Emitted[] = [];
  ot.onEvidence((e) => events.push(e));
  return { robot, ot, events };
}

function expectVocabularyOnly(events: Emitted[]) {
  for (const e of events) {
    expect(EVIDENCE_EVENT_TYPES, e.type).toContain(e.type);
    for (const k of RESERVED) expect(e.payload, `${e.type} carries reserved ${k}`).not.toHaveProperty(k);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Opentrons evidence (real mode) — closed vocabulary", () => {
  it("upload, play, pause, resume, then the robot's success: one completion, all vocabulary", async () => {
    const { robot, ot, events } = await adapterWithRobot();
    await ot.execute({ type: "load_gcode", payload: { protocolSource: SOURCE, protocolName: "p" } });
    await ot.execute({ type: "start" });
    await ot.execute({ type: "pause" });
    await ot.execute({ type: "resume" });
    expect(await ot.getProgress()).toBe(50);
    robot.runStatus = "succeeded";
    expect(await ot.getProgress()).toBe(100);
    await ot.getProgress(); // polled again: no second completion

    expect(events.map((e) => e.type)).toEqual([
      "method_loaded",
      "execution_started",
      "execution_progress",
      "execution_progress",
      "execution_completed",
    ]);
    expect(events[0]!.payload).toEqual({
      opentronsProtocolId: "proto-1",
      name: "p",
      protocolHash: `sha256:${createHash("sha256").update(SOURCE, "utf8").digest("hex")}`,
    });
    expect(events[1]!.payload).toEqual({ opentronsRunId: "run-1" });
    expect(events.slice(2, 4).map((e) => e.payload.action)).toEqual(["pause", "resume"]);
    expect(events[4]!.payload).toMatchObject({ opentronsRunId: "run-1", status: "succeeded", commandsSucceeded: 2, commandsTotal: 2 });
    expect(robot.actions).toEqual(["play", "pause", "play"]);
    expectVocabularyOnly(events);
    expect(await ot.getStatus()).toBe("idle"); // the finished run is released
  });

  it("the robot's failure is execution_failed with its errors, once, and the runner sees idle", async () => {
    const { robot, ot, events } = await adapterWithRobot();
    await ot.execute({ type: "load_gcode", payload: { protocolSource: SOURCE } });
    await ot.execute({ type: "start" });
    robot.runStatus = "failed";
    robot.errors = [{ detail: "tip not attached", createdAt: "2026-09-24T00:00:03Z" }];
    expect(await ot.getProgress()).toBe(0);
    await ot.getProgress();
    const terminal = events.filter((e) => e.type === "execution_failed" || e.type === "execution_completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.payload).toEqual({ opentronsRunId: "run-1", status: "failed", errors: ["tip not attached"] });
    expect(await ot.getStatus()).toBe("idle");
    expectVocabularyOnly(events);
  });

  it("an operator stop is execution_failed, never a completion", async () => {
    const { ot, events } = await adapterWithRobot();
    await ot.execute({ type: "load_gcode", payload: { protocolSource: SOURCE } });
    await ot.execute({ type: "start" });
    await ot.execute({ type: "stop" });
    expect(events.map((e) => e.type)).toEqual(["method_loaded", "execution_started", "execution_failed"]);
    expect(events[2]!.payload).toEqual({ opentronsRunId: "run-1", reason: "stopped before completion" });
    expectVocabularyOnly(events);
  });
});

describe("Opentrons evidence (mock mode) — closed vocabulary, marked simulated", () => {
  it("a mock run is method_loaded, started, progress, completed; a mock stop is a failure", async () => {
    vi.useFakeTimers();
    try {
      const ot = new OpentronsMachineAdapter("otkernel-mock", { url: "http://localhost:31950", mockMode: true });
      const events: Emitted[] = [];
      ot.onEvidence((e) => events.push(e));
      await ot.execute({ type: "load_gcode", payload: { protocolSource: SOURCE } });
      await ot.execute({ type: "start" });
      await vi.advanceTimersByTimeAsync(10_500);
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("method_loaded");
      expect(types[1]).toBe("execution_started");
      expect(types.at(-1)).toBe("execution_completed");
      expectVocabularyOnly(events);
      for (const e of events) expect(e.source.simulated).toBe(true);

      await ot.execute({ type: "start" });
      await ot.execute({ type: "stop" });
      expect(events.at(-1)!.type).toBe("execution_failed");
      await ot.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
