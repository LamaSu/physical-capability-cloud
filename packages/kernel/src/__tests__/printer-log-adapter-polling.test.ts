/**
 * PrinterLogAdapter's polling state machine (astra pack 190, MEDIUMs tracked as follow-ups):
 * its timer polls never overlap, so the chain keeps the log's order; a poll that fails during
 * a recording means its summary cannot be trusted, so the stop refuses; there is no summary
 * without a recording; and a stop is single-flight and is the adapter's outstanding work, so
 * quiesceEvidence() waits for a stop in flight, a retry included. On the fake clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";

import { PrinterLogAdapter } from "../adapters/printer-log-adapter.js";
import type { LogCaptureService } from "../log-capture-service.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-printer-log-polling";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A log capture that chains entries in memory. */
function memoryLogCapture(): LogCaptureService {
  let n = 0;
  const chain: Array<{ entryHash: string; previousHash: string }> = [];
  return {
    reset: () => void (chain.length = 0),
    getChain: () => chain,
    captureEntry: async (rawContent: string) => {
      const entry = { entryId: `e${++n}`, entryHash: `h${n}`, previousHash: `h${n - 1}`, rawContent, capturedAt: new Date().toISOString(), kernelSignature: "sig" };
      chain.push(entry);
      return entry;
    },
  } as unknown as LogCaptureService;
}

function record(log: PrinterLogAdapter): Emitted[] {
  const events: Emitted[] = [];
  log.onEvidence((e) => events.push(e));
  return events;
}

/** Ask the adapter to quiesce; note whether, and when, it resolved. */
function ask(log: PrinterLogAdapter): { resolved: boolean } {
  const state = { resolved: false };
  void log.quiesceEvidence().then(() => (state.resolved = true));
  return state;
}

const entries = (events: Emitted[]) => events.filter((e) => e.type === "log_hash_chain_entry").map((e) => e.payload.rawContent);
const summaries = (events: Emitted[]) => events.filter((e) => e.type === "printer_job_verified");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PrinterLogAdapter polling (astra pack 190)", () => {
  it("timer polls never overlap: a slow poll is not overtaken, so the chain keeps the log's order", async () => {
    const slow = deferred();
    let calls = 0;
    const logProvider = async () => {
      calls += 1;
      if (calls === 1) return "line 1"; // startRecording's first poll
      if (calls === 2) {
        await slow.promise; // the 1000 ms tick's poll waits on the log source
        return "line 2";
      }
      if (calls === 3) return "line 3";
      return null;
    };
    const log = new PrinterLogAdapter("log-overlap", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider });
    const events = record(log);

    await log.startRecording("job-o");
    await vi.advanceTimersByTimeAsync(2_500); // ticks at 1000 (held) and 2000
    slow.resolve();
    await vi.advanceTimersByTimeAsync(1_000); // a tick at 3000
    const stopped = log.stopRecording();
    await vi.advanceTimersByTimeAsync(0);
    const summary = await stopped;

    expect.soft(entries(events), "entries, in the log's order").toEqual(["line 1", "line 2", "line 3"]);
    expect.soft(summary.payload, "the summary").toMatchObject({ jobId: "job-o", chainLength: 3 });
  });

  it("a timer poll that fails makes the stop refuse: no summary vouches for a chain that may be missing lines", async () => {
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return "line 1";
      if (calls === 2) throw new Error("log source unreachable");
      return null;
    };
    const log = new PrinterLogAdapter("log-poll-fails", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider });
    const events = record(log);

    await log.startRecording("job-f");
    await vi.advanceTimersByTimeAsync(1_000); // the timer's poll fails
    const stopped = log.stopRecording().then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect.soft(await stopped, "the stop").toMatch(/a log poll failed during the recording \(log source unreachable\)/);
    expect.soft(summaries(events), "summaries").toEqual([]);
    const hook = ask(log);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, after the refused stop").toBe(true);
  });

  it("there is no summary without a recording: a stop before any start, or after the stop, refuses and emits nothing", async () => {
    const log = new PrinterLogAdapter("log-inactive", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider: async () => null });
    const events = record(log);

    await expect.soft(log.stopRecording(), "a stop before any start").rejects.toThrow(/no recording to stop/);
    expect.soft(events, "events").toEqual([]);

    await log.startRecording("job-i");
    await log.stopRecording();
    const once = events.length;
    await expect.soft(log.stopRecording(), "a second stop").rejects.toThrow(/no recording to stop/);
    expect.soft(events.length, "events after the second stop").toBe(once);
  });

  it("two stops at once are one stop: one summary, the same result", async () => {
    let calls = 0;
    const finalPoll = deferred();
    const logProvider = async () => {
      calls += 1;
      if (calls === 1) return "line 1";
      if (calls === 2) {
        await finalPoll.promise;
        return "line 2";
      }
      return null;
    };
    const log = new PrinterLogAdapter("log-twice", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 60_000, logProvider });
    const events = record(log);

    await log.startRecording("job-t");
    const a = log.stopRecording();
    const b = log.stopRecording();
    finalPoll.resolve();
    const [ra, rb] = await Promise.all([a, b]);

    expect.soft(summaries(events).length, "summaries").toBe(1);
    expect.soft(rb, "the second stop's result").toBe(ra);
    expect.soft(entries(events), "entries").toEqual(["line 1", "line 2"]);
  });

  it("a stop retried after a failed one is the adapter's work: the hook waits until it has emitted", async () => {
    let calls = 0;
    const retryPoll = deferred();
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return "line 1";
      if (calls === 2) throw new Error("final poll failed once"); // the first stop's final poll
      if (calls === 3) {
        await retryPoll.promise; // the retried stop's final poll waits on the log source
        return "line 2";
      }
      return null;
    };
    const log = new PrinterLogAdapter("log-retry", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 60_000, logProvider });
    const events = record(log);

    await log.startRecording("job-r");
    await expect(log.stopRecording()).rejects.toThrow("final poll failed once");
    const retry = log.stopRecording();
    const hook = ask(log);
    await vi.advanceTimersByTimeAsync(10_000);
    expect.soft(hook.resolved, "the hook, while the retried stop is in flight").toBe(false);
    const emittedBefore = events.length;
    retryPoll.resolve();
    await retry;
    await vi.advanceTimersByTimeAsync(0);

    expect.soft(hook.resolved, "the hook, once the retry has emitted").toBe(true);
    expect.soft(events.slice(emittedBefore).map((e) => e.type), "what the retry emitted").toEqual(["log_hash_chain_entry", "printer_job_verified"]);
  });
});
