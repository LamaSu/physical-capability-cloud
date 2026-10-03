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

/** A log capture that chains entries in memory. With `hold`, each capture (its hashing and signing) waits for it. */
function memoryLogCapture(hold?: Promise<void>): LogCaptureService {
  let n = 0;
  const chain: Array<{ entryHash: string; previousHash: string }> = [];
  return {
    reset: () => void (chain.length = 0),
    getChain: () => chain,
    captureEntry: async (rawContent: string) => {
      if (hold) await hold;
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

/** A log line the log source returns when the test says, or a failure. */
function deferredLine(): { promise: Promise<string | null>; resolve: (line: string | null) => void; reject: (err: Error) => void } {
  let resolve!: (line: string | null) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A call's outcome, never an unhandled rejection: its value, or its error's message. */
function settle<T>(call: Promise<T>): Promise<{ value?: T; error?: string }> {
  return call.then(
    (value) => ({ value }),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
}

/** Ask the adapter to quiesce; note whether it resolved, and how many events had been emitted when it did. */
function ask(log: PrinterLogAdapter, events?: Emitted[]): { resolved: boolean; seen?: number } {
  const state: { resolved: boolean; seen?: number } = { resolved: false };
  void log.quiesceEvidence().then(() => {
    state.resolved = true;
    state.seen = events?.length;
  });
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

  it("a failed poll refuses only its own recording's summary: the next recording stops with one", async () => {
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 2) throw new Error("log source unreachable"); // the first recording's timer poll
      return calls === 1 ? "line 1" : calls === 4 ? "line A" : null;
    };
    const log = new PrinterLogAdapter("log-next", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider });
    const events = record(log);

    await log.startRecording("job-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(log.stopRecording()).rejects.toThrow(/a log poll failed/);
    await log.startRecording("job-2"); // its first poll reads "line A"
    const summary = await log.stopRecording();
    expect.soft(summary.payload, "the next recording's summary").toMatchObject({ jobId: "job-2", chainLength: 1 });
    expect.soft(summaries(events).length, "summaries").toBe(1);
  });

  it("after a first poll that failed, there is no recording: a stop refuses and emits nothing", async () => {
    const log = new PrinterLogAdapter("log-failed-start", KERNEL_ID, memoryLogCapture(), {
      pollIntervalMs: 1_000,
      logProvider: async () => {
        throw new Error("log source unreachable");
      },
    });
    const events = record(log);
    await expect(log.startRecording("job-s")).rejects.toThrow("log source unreachable");
    await expect.soft(log.stopRecording(), "the stop").rejects.toThrow(/no recording to stop/);
    expect.soft(events, "events").toEqual([]);
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

describe("PrinterLogAdapter lifecycle (astra pack 196)", () => {
  it("a stop during a pending start whose first poll succeeds waits for that start: the summary is last and covers every entry of its job, and nothing is emitted after the hook answers", async () => {
    const firstPoll = deferredLine();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return firstPoll.promise; // startRecording's first poll waits on the log source
      return calls === 2 ? "line 2" : null;
    };
    const log = new PrinterLogAdapter("log-stop-starting", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider });
    const events = record(log);

    const started = settle(log.startRecording("job-a"));
    const stopped = settle(log.stopRecording());
    const hook = ask(log, events);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, while the first poll is pending").toBe(false);
    expect.soft(summaries(events), "summaries, while the first poll is pending").toEqual([]);

    firstPoll.resolve("line 1");
    await vi.advanceTimersByTimeAsync(0);
    const [start, stop] = await Promise.all([started, stopped]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(start.error, "startRecording").toBeUndefined();
    expect.soft(stop.value?.payload, "the summary").toMatchObject({ jobId: "job-a", chainLength: 2 });
    expect.soft(events.map((e) => e.type), "events, the summary last").toEqual(["log_hash_chain_entry", "log_hash_chain_entry", "printer_job_verified"]);
    expect.soft(events.map((e) => e.payload.jobId), "each event's jobId").toEqual(["job-a", "job-a", "job-a"]);
    expect.soft(entries(events), "entries, in the log's order").toEqual(["line 1", "line 2"]);
    expect.soft(hook.resolved, "the hook, once the stop has emitted").toBe(true);
    expect.soft(hook.seen, "events emitted when the hook answered: every one, none after").toBe(events.length);
    expect.soft(vi.getTimerCount(), "timers left").toBe(0);
    // The start handed the recording to that stop, which ended it: nothing is left to stop.
    expect.soft((await log.getCurrentReading()).recording, "recording, after the stop").toBe(false);
    expect.soft((await settle(log.stopRecording())).error ?? "resolved", "a stop after it").toMatch(/no recording to stop/);
  });

  it("a stop during a pending start whose first poll fails refuses: no summary for a recording that never started, and startRecording rejects", async () => {
    const firstPoll = deferredLine();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return firstPoll.promise; // startRecording's first poll waits on the log source, then fails
      return calls === 2 ? "line 2" : null;
    };
    const log = new PrinterLogAdapter("log-stop-failed-start", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider });
    const events = record(log);

    const started = settle(log.startRecording("job-a"));
    const stopped = settle(log.stopRecording());
    const hook = ask(log, events);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, while the first poll is pending").toBe(false);

    firstPoll.reject(new Error("log source unreachable"));
    await vi.advanceTimersByTimeAsync(0);
    const [start, stop] = await Promise.all([started, stopped]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(start.error, "startRecording").toBe("log source unreachable");
    expect.soft(stop.error ?? "resolved", "the stop").toMatch(/no recording to stop/);
    expect.soft(events, "events").toEqual([]);
    expect.soft(hook.resolved, "the hook, once the start has failed").toBe(true);
    expect.soft(calls, "log polls: the first only").toBe(1);
    expect.soft(vi.getTimerCount(), "timers left").toBe(0);
    // The refused stop left the adapter idle, not stopping: the next start records.
    const next = await settle(log.startRecording("job-next")); // its first poll reads "line 2"
    expect.soft(next.error, "a start once the stop has refused").toBeUndefined();
    expect.soft((await settle(log.stopRecording())).value?.payload, "its summary").toMatchObject({ jobId: "job-next", chainLength: 1 });
  });

  it("a start of the next job while a stop is in flight does not begin: the stop's summary is its own job's, and nothing of it lands in the next job", async () => {
    const finalPollA = deferredLine();
    const polled: string[] = [];
    const logProvider = async (jobId: string): Promise<string | null> => {
      polled.push(jobId);
      const nth = polled.filter((j) => j === jobId).length;
      if (jobId === "job-a") return nth === 1 ? "A1" : nth === 2 ? finalPollA.promise : null;
      return nth === 1 ? "B1" : nth === 2 ? "B2" : null;
    };
    const log = new PrinterLogAdapter("log-next-job", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 60_000, logProvider });
    const events = record(log);

    await log.startRecording("job-a"); // its first poll reads A1
    const stoppedA = settle(log.stopRecording()); // its final poll waits on the log source
    await vi.advanceTimersByTimeAsync(0);
    const startedDuringStop = settle(log.startRecording("job-b"));
    await vi.advanceTimersByTimeAsync(0);
    finalPollA.resolve("A2");
    await vi.advanceTimersByTimeAsync(0);
    const [a, during] = await Promise.all([stoppedA, startedDuringStop]);
    await log.startRecording("job-b"); // once A's stop has settled
    const b = await settle(log.stopRecording());
    await vi.advanceTimersByTimeAsync(0);
    const hook = ask(log, events);
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(during.error ?? "resolved", "a start while a stop is in flight").toMatch(/a stop is in flight/);
    expect.soft(a.value?.payload, "A's summary").toMatchObject({ jobId: "job-a", chainLength: 2 });
    expect
      .soft(
        events.map((e) => [e.type, e.payload.jobId, e.payload.rawContent ?? e.payload.chainLength]),
        "every event, in order, with its job",
      )
      .toEqual([
        ["log_hash_chain_entry", "job-a", "A1"],
        ["log_hash_chain_entry", "job-a", "A2"],
        ["printer_job_verified", "job-a", 2],
        ["log_hash_chain_entry", "job-b", "B1"],
        ["log_hash_chain_entry", "job-b", "B2"],
        ["printer_job_verified", "job-b", 2],
      ]);
    const ofB = events.filter((e) => e.type === "log_hash_chain_entry" && String(e.payload.rawContent).startsWith("B"));
    expect.soft(b.value?.payload, "B's summary: B's entries only").toMatchObject({
      jobId: "job-b",
      chainLength: ofB.length,
      tailHash: ofB[0]?.payload.previousHash,
      headHash: ofB.at(-1)?.payload.entryHash,
    });
    expect.soft(hook.resolved, "the hook, once both stops have emitted").toBe(true);
    expect.soft(hook.seen, "events emitted when the hook answered: every one, none after").toBe(events.length);
    expect.soft(vi.getTimerCount(), "timers left").toBe(0);
  });

  it("dispose during a pending start: once the first poll answers, no timer is installed and nothing is emitted, and the hook waits for that poll", async () => {
    const firstPoll = deferredLine();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      return calls === 1 ? firstPoll.promise : `line ${calls}`; // the first poll waits on the log source
    };
    const capture = memoryLogCapture();
    const captured = vi.spyOn(capture, "captureEntry");
    const log = new PrinterLogAdapter("log-dispose-starting", KERNEL_ID, capture, { pollIntervalMs: 1_000, logProvider });

    const started = settle(log.startRecording("job-d"));
    await vi.advanceTimersByTimeAsync(0);
    await log.dispose();
    const heard = record(log); // a listener added after dispose hears whatever is still emitted
    const hook = ask(log, heard);
    await vi.advanceTimersByTimeAsync(5_000);
    expect.soft(hook.resolved, "the hook, while the first poll is pending").toBe(false);

    firstPoll.resolve("line 1");
    await vi.advanceTimersByTimeAsync(0);
    const start = await started;
    expect.soft(vi.getTimerCount(), "timers, once the start has continued").toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(start.error ?? "resolved", "startRecording").toMatch(/disposed/);
    expect.soft(heard, "events emitted after dispose").toEqual([]);
    expect.soft(captured, "entries captured after dispose").not.toHaveBeenCalled();
    expect.soft(calls, "log polls: the first only").toBe(1);
    expect.soft(hook.resolved, "the hook, once the first poll has settled").toBe(true);
  });

  it("a start while one is starting or recording: the same job's is that start, another job's is refused, and a start in flight is outstanding work", async () => {
    const firstPoll = deferredLine();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return firstPoll.promise;
      return calls === 2 ? "line 2" : null;
    };
    const log = new PrinterLogAdapter("log-busy", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 60_000, logProvider });
    const events = record(log);

    const first = log.startRecording("job-a");
    const again = log.startRecording("job-a");
    const other = settle(log.startRecording("job-b"));
    const hook = ask(log, events);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(again, "a start of the same job while it is starting").toBe(first);
    expect.soft((await other).error ?? "resolved", "a start of another job while one is starting").toMatch(/busy with job job-a, so job job-b cannot start/);
    expect.soft((await log.getCurrentReading()).recording, "recording, while starting").toBe(true);
    expect.soft(hook.resolved, "the hook, while the start is in flight").toBe(false);

    firstPoll.resolve("line 1");
    await first;
    expect.soft((await settle(log.startRecording("job-a"))).error, "a start of the same job while it records").toBeUndefined();
    expect.soft((await settle(log.startRecording("job-b"))).error ?? "resolved", "a start of another job while one records").toMatch(/busy with job job-a/);
    const summary = await log.stopRecording();
    await vi.advanceTimersByTimeAsync(0);

    expect.soft(summary.payload, "the summary").toMatchObject({ jobId: "job-a", chainLength: 2 });
    expect.soft(events.map((e) => e.payload.jobId), "each event's jobId").toEqual(["job-a", "job-a", "job-a"]);
    expect.soft(calls, "log polls: job-a's first and final").toBe(2);
    expect.soft(hook.resolved, "the hook, once the stop has emitted").toBe(true);
  });

  it("a first poll that fails returns the adapter to idle: the next start records", async () => {
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) throw new Error("log source unreachable");
      return calls === 2 ? "line 1" : null;
    };
    const log = new PrinterLogAdapter("log-restart", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 60_000, logProvider });
    const events = record(log);

    await expect(log.startRecording("job-1")).rejects.toThrow("log source unreachable");
    expect.soft((await log.getCurrentReading()).recording, "recording, after the failed start").toBe(false);
    const again = await settle(log.startRecording("job-1"));
    const stop = await settle(log.stopRecording());

    expect.soft(again.error, "the next start").toBeUndefined();
    expect.soft(stop.value?.payload, "its summary").toMatchObject({ jobId: "job-1", chainLength: 1 });
    expect.soft(summaries(events).length, "summaries").toBe(1);
  });

  it("dispose while an entry is being captured: the entry is not emitted, and the start installs nothing", async () => {
    const signing = deferred();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => `line ${++calls}`;
    const log = new PrinterLogAdapter("log-dispose-capturing", KERNEL_ID, memoryLogCapture(signing.promise), { pollIntervalMs: 1_000, logProvider });

    const started = settle(log.startRecording("job-c"));
    await vi.advanceTimersByTimeAsync(0); // the first line is being hashed and signed
    await log.dispose();
    const heard = record(log);
    const hook = ask(log, heard);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, while the entry is being captured").toBe(false);
    signing.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft((await started).error ?? "resolved", "startRecording").toMatch(/disposed while job job-c was starting/);
    expect.soft(heard, "events emitted after dispose").toEqual([]);
    expect.soft(calls, "log polls: the first only").toBe(1);
    expect.soft(vi.getTimerCount(), "timers").toBe(0);
    expect.soft(hook.resolved, "the hook, once the capture has settled").toBe(true);
  });

  it("dispose while recording: the timer's poll in flight captures and emits nothing, and the hook answers once it settles", async () => {
    const timerPoll = deferredLine();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return "line 1";
      return calls === 2 ? timerPoll.promise : `line ${calls}`; // the 1000 ms tick's poll waits on the log source
    };
    const capture = memoryLogCapture();
    const log = new PrinterLogAdapter("log-dispose-recording", KERNEL_ID, capture, { pollIntervalMs: 1_000, logProvider });

    await log.startRecording("job-r");
    await vi.advanceTimersByTimeAsync(1_000);
    const captured = vi.spyOn(capture, "captureEntry");
    await log.dispose();
    const heard = record(log);
    const hook = ask(log, heard);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, while the timer's poll is in flight").toBe(false);
    timerPoll.resolve("line 2");
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(captured, "entries captured after dispose").not.toHaveBeenCalled();
    expect.soft(heard, "events emitted after dispose").toEqual([]);
    expect.soft(calls, "log polls: the first and the timer's").toBe(2);
    expect.soft(hook.resolved, "the hook, once that poll has settled").toBe(true);
  });

  it("dispose while a stop waits for the timer's poll: no final poll and no summary, and the stop rejects", async () => {
    const timerPoll = deferredLine();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return "line 1";
      return calls === 2 ? timerPoll.promise : `line ${calls}`; // the 1000 ms tick's poll waits on the log source
    };
    const log = new PrinterLogAdapter("log-dispose-stop-waits", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider });

    await log.startRecording("job-w");
    await vi.advanceTimersByTimeAsync(1_000);
    const stopped = settle(log.stopRecording()); // it waits for that poll
    await vi.advanceTimersByTimeAsync(0);
    await log.dispose();
    const heard = record(log);
    const hook = ask(log, heard);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, while the timer's poll is in flight").toBe(false);
    timerPoll.resolve("line 2");
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft((await stopped).error ?? "resolved", "the stop").toMatch(/disposed while job job-w was stopping, so it has no summary/);
    expect.soft(heard, "events emitted after dispose").toEqual([]);
    expect.soft(calls, "log polls: the first and the timer's, and no final poll").toBe(2);
    expect.soft(hook.resolved, "the hook, once the stop has settled").toBe(true);
  });

  it("dispose during a stop's final poll: no summary, the stop rejects, and a retried stop refuses and polls nothing", async () => {
    const finalPoll = deferredLine();
    let calls = 0;
    const logProvider = async (): Promise<string | null> => {
      calls += 1;
      if (calls === 1) return "line 1";
      return calls === 2 ? finalPoll.promise : `line ${calls}`; // the stop's final poll waits on the log source
    };
    const log = new PrinterLogAdapter("log-dispose-final-poll", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 60_000, logProvider });

    await log.startRecording("job-f");
    const stopped = settle(log.stopRecording());
    await vi.advanceTimersByTimeAsync(0);
    await log.dispose();
    const heard = record(log);
    const hook = ask(log, heard);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, while the final poll is in flight").toBe(false);
    finalPoll.resolve("line 2");
    await vi.advanceTimersByTimeAsync(0);
    const stop = await stopped;
    const retry = await settle(log.stopRecording());
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(stop.error ?? "resolved", "the stop").toMatch(/disposed while job job-f was stopping, so it has no summary/);
    expect.soft(retry.error ?? "resolved", "a retried stop").toMatch(/disposed, so there is no recording to stop/);
    expect.soft(heard, "events emitted after dispose").toEqual([]);
    expect.soft(calls, "log polls: the first and the final").toBe(2);
    expect.soft(hook.resolved, "the hook, once the stop has settled").toBe(true);
  });

  it.each(["succeeds", "fails"] as const)(
    "dispose during a start that a stop waits on, whose first poll then %s: both refuse, nothing is emitted, and the adapter stays disposed",
    async (outcome) => {
      const firstPoll = deferredLine();
      let calls = 0;
      const logProvider = async (): Promise<string | null> => {
        calls += 1;
        return calls === 1 ? firstPoll.promise : `line ${calls}`;
      };
      const log = new PrinterLogAdapter(`log-dispose-start-stop-${outcome}`, KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider });

      const started = settle(log.startRecording("job-x"));
      const stopped = settle(log.stopRecording()); // it waits for the start
      await vi.advanceTimersByTimeAsync(0);
      await log.dispose();
      const heard = record(log);
      const hook = ask(log, heard);
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(hook.resolved, "the hook, while the first poll is pending").toBe(false);
      if (outcome === "succeeds") firstPoll.resolve("line 1");
      else firstPoll.reject(new Error("log source unreachable"));
      await vi.advanceTimersByTimeAsync(0);
      const [start, stop] = await Promise.all([started, stopped]);
      const next = await settle(log.startRecording("job-next"));
      await vi.advanceTimersByTimeAsync(60_000);

      expect.soft(start.error ?? "resolved", "startRecording").toMatch(outcome === "succeeds" ? /disposed while job job-x was starting/ : /log source unreachable/);
      expect.soft(stop.error ?? "resolved", "the stop").toMatch(/disposed, so there is no recording to stop/);
      expect.soft(next.error ?? "resolved", "a start afterwards").toMatch(/disposed, so job job-next cannot start/);
      expect.soft(heard, "events emitted after dispose").toEqual([]);
      expect.soft(calls, "log polls: the first only").toBe(1);
      expect.soft(vi.getTimerCount(), "timers").toBe(0);
      expect.soft(hook.resolved, "the hook, once the start has settled").toBe(true);
    },
  );

  it("dispose is final: a dispose made while the stop emits its summary is not undone", async () => {
    let calls = 0;
    const log = new PrinterLogAdapter("log-dispose-on-summary", KERNEL_ID, memoryLogCapture(), {
      pollIntervalMs: 60_000,
      logProvider: async () => (++calls === 1 ? "line 1" : null),
    });
    log.onEvidence((e) => {
      if (e.type === "printer_job_verified") void log.dispose();
    });

    await log.startRecording("job-s");
    const summary = await log.stopRecording();
    const next = await settle(log.startRecording("job-next"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(summary.payload, "the summary, emitted before dispose").toMatchObject({ jobId: "job-s", chainLength: 1 });
    expect.soft(next.error ?? "resolved", "a start after dispose").toMatch(/disposed, so job job-next cannot start/);
    expect.soft(calls, "log polls: job-s's first and final").toBe(2);
    expect.soft(vi.getTimerCount(), "timers").toBe(0);
  });

  it("after dispose, a start refuses and polls nothing, and a stop refuses", async () => {
    let calls = 0;
    const log = new PrinterLogAdapter("log-disposed", KERNEL_ID, memoryLogCapture(), { pollIntervalMs: 1_000, logProvider: async () => `line ${++calls}` });
    await log.dispose();
    const heard = record(log);

    const start = await settle(log.startRecording("job-late"));
    const stop = await settle(log.stopRecording());
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(start.error ?? "resolved", "a start after dispose").toMatch(/disposed, so job job-late cannot start/);
    expect.soft(stop.error ?? "resolved", "a stop after dispose").toMatch(/disposed, so there is no recording to stop/);
    expect.soft(calls, "log polls").toBe(0);
    expect.soft(heard, "events").toEqual([]);
    expect.soft(vi.getTimerCount(), "timers").toBe(0);
  });
});
