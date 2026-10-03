/**
 * PrinterLogAdapter re-entered from inside every collaborator and listener call (the steward's
 * ruling on 199, part (1); widened and made non-vacuous after astra pack 202).
 *
 * Four review rounds each found one more member of one class: overlapping polls (190), the
 * start window (198), the timer-poll window (199) and the failure latch (200). This test walks
 * the class instead.
 *
 * The run is a start, one timer poll and a stop, then a retried stop if the first one failed.
 *
 * Call sites. The k-th call of each of these calls one of the adapter's operations, then either
 * answers or fails:
 *   - the capture's reset;
 *   - the log provider;
 *   - captureEntry;
 *   - getChain;
 *   - an evidence listener.
 * An asynchronous call first holds its answer until everything else has run. The failure is a
 * rejection with no text form, or a synchronous throw.
 *
 * Operations: stop, quiesceEvidence, dispose, a start of the same job, a start of another job,
 * and getCurrentReading.
 *
 * Whatever re-enters where, and whatever fails, the evidence keeps its invariants:
 *   - a recording has at most one printer_job_verified, across retries;
 *   - a summary covers exactly the entries emitted before it in its recording: chainLength,
 *     headHash and tailHash;
 *   - nothing of a job's recording is emitted after its summary;
 *   - a recording whose first or timer poll failed has no summary. A failed final poll fails its
 *     stop, and a retried stop may still summarize what was captured (the lifecycle's design);
 *   - a recording that nothing disrupted (no failure, no dispose) emits its entries and exactly
 *     one summary, and every stop asked of it resolves with that summary;
 *   - quiesceEvidence() never answers while a start, a recording or a stop is in flight, and
 *     once it answers nothing more is emitted until a new start or stop is asked for;
 *   - nothing is captured, and no summary is emitted, after dispose, and a stop resolves with a
 *     summary only if the listeners received it;
 *   - every call settles, nothing is left unhandled, and the adapter ends idle, stopFailed or
 *     disposed.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";

import { PrinterLogAdapter } from "../adapters/printer-log-adapter.js";
import type { LogCaptureService } from "../log-capture-service.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-printer-log-reentrancy";
const ACTIONS = ["stop", "quiesce", "dispose", "start-same", "start-other", "read"] as const;
const SYNC_SITES = ["reset#1", "reset#2", "getChain#1", "listener#1", "listener#2", "listener#3", "listener#4"] as const;
const ASYNC_SITES = ["provider#1", "provider#2", "provider#3", "capture#1", "capture#2", "capture#3"] as const;
const CASES = [...SYNC_SITES, ...ASYNC_SITES].flatMap((site) =>
  ACTIONS.flatMap((action) => [[site, action, "answers"] as const, [site, action, "fails"] as const]),
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(CASES)("%s re-enters %s, then %s", async (site, action, outcome) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const events: Emitted[] = [];
  const chain: Array<{ entryHash: string; previousHash: string }> = [];
  const counts = { reset: 0, provider: 0, capture: 0, getChain: 0, listener: 0 };
  let n = 0;
  let fired = false;
  let failedPoll = false; // its first or timer poll failed: the recording's chain may lack lines
  let failedAny = false;
  let disposed = false;
  let capturedAfterDispose = 0;
  let summariesAfterDispose = 0;
  let asks = 0; // starts and stops asked for, by the driver or a re-entrant call
  const hook = { resolved: false, seen: -1, asksAt: -1, stateAt: "" };
  const calls: Array<{ what: string; live: boolean; done: boolean; value?: unknown; error?: string }> = [];
  const held: Array<() => void> = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => void unhandled.push(err);
  let log!: PrinterLogAdapter;

  /** `live`: the recording was starting, recording or stopping when the call was made. */
  const track = (what: string, live: boolean, p: Promise<unknown>) => {
    const call: { what: string; live: boolean; done: boolean; value?: unknown; error?: string } = { what, live, done: false };
    calls.push(call);
    p.then(
      (value) => {
        call.done = true;
        call.value = value;
      },
      (err: unknown) => {
        call.done = true;
        call.error = err instanceof Error ? err.message : "a reason with no text form";
      },
    );
  };
  const live = () => ["starting", "recording", "stopping"].includes((log as unknown as { state: string }).state);
  const reenter = () => {
    fired = true;
    if (action === "stop") {
      asks++;
      track("re-entrant stop", live(), log.stopRecording());
    } else if (action === "quiesce") {
      void log.quiesceEvidence().then(() => {
        hook.resolved = true;
        hook.seen = events.length;
        hook.asksAt = asks;
        hook.stateAt = (log as unknown as { state: string }).state;
      });
    } else if (action === "dispose") {
      disposed = true;
      void log.dispose();
    } else if (action === "read") {
      track("re-entrant read", live(), log.getCurrentReading());
    } else {
      asks++;
      track(`re-entrant ${action}`, live(), log.startRecording(action === "start-same" ? "job-a" : "job-b"));
    }
  };
  /** A synchronous call: at the chosen site it re-enters, then throws if it fails. */
  const syncCall = (here: string) => {
    if (here !== site) return;
    reenter();
    if (outcome === "fails") {
      failedAny = true;
      throw new Error(`${here} failed`);
    }
  };
  /** An asynchronous call: at the chosen site it re-enters, then holds its answer until released, and answers or fails. */
  const asyncCall = <T>(here: string, value: () => T): Promise<T> => {
    if (here !== site) return Promise.resolve().then(value);
    reenter();
    return new Promise<T>((resolve, reject) =>
      held.push(() => {
        if (outcome === "answers") return resolve(value());
        failedAny = true;
        if (!here.endsWith("#3")) failedPoll = true; // the first or the timer poll, not the final one
        reject(Object.create(null)); // a legal rejection with no text form (astra pack 200)
      }),
    );
  };
  const capture = {
    reset: () => {
      counts.reset += 1;
      syncCall(`reset#${counts.reset}`);
      chain.length = 0;
    },
    getChain: () => {
      counts.getChain += 1;
      syncCall(`getChain#${counts.getChain}`);
      return chain;
    },
    captureEntry: (rawContent: string) => {
      counts.capture += 1;
      if (disposed) capturedAfterDispose += 1;
      return asyncCall(`capture#${counts.capture}`, () => {
        const entry = { entryId: `e${++n}`, entryHash: `h${n}`, previousHash: `h${n - 1}`, rawContent, capturedAt: new Date().toISOString(), kernelSignature: "sig" };
        chain.push(entry);
        return entry;
      });
    },
  } as unknown as LogCaptureService;
  const logProvider = (jobId: string): Promise<string | null> => {
    counts.provider += 1;
    const k = counts.provider;
    return asyncCall(`provider#${k}`, () => `${jobId} line ${k}`);
  };

  process.on("unhandledRejection", onUnhandled);
  try {
    log = new PrinterLogAdapter("log-reentrancy", KERNEL_ID, capture, { pollIntervalMs: 1_000, logProvider });
    // The recorder first, then a second listener: the call site "listener#k" is its k-th event.
    log.onEvidence((e) => {
      events.push(e);
      if (disposed && e.type === "printer_job_verified") summariesAfterDispose += 1;
    });
    log.onEvidence(() => {
      counts.listener += 1;
      syncCall(`listener#${counts.listener}`);
    });

    /** Lets everything run, then releases the held answers one at a time. */
    const drain = async () => {
      await vi.advanceTimersByTimeAsync(0);
      while (held.length > 0) {
        held.shift()!();
        await vi.advanceTimersByTimeAsync(0);
      }
    };
    asks++;
    track("start", true, log.startRecording("job-a"));
    await drain();
    await vi.advanceTimersByTimeAsync(1_000); // one timer poll
    await drain();
    asks++;
    track("stop", live(), log.stopRecording());
    await drain();
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();
    // A stop that failed may be retried: it must never produce a second summary.
    asks++;
    track("retried stop", live(), log.stopRecording());
    await drain();
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();
    await new Promise((r) => setImmediate(r)); // let Node report any unhandled rejection
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  const state = (log as unknown as { state: string }).state;
  const quiet = { resolved: false };
  void log.quiesceEvidence().then(() => (quiet.resolved = true));
  await vi.advanceTimersByTimeAsync(0);
  const summaries = events.filter((e) => e.type === "printer_job_verified");
  const entriesOf = (job: string) => events.filter((e) => e.type === "log_hash_chain_entry" && e.payload.jobId === job);

  // The re-entrant call ran (a site the run never reaches would make the case vacuous).
  expect.soft(fired, "the re-entrant call ran").toBe(true);
  // Every call settled, nothing was left unhandled, and the adapter ended with nothing running.
  expect.soft(calls.filter((c) => !c.done).map((c) => c.what), "calls still pending").toEqual([]);
  expect.soft(unhandled.length, "unhandled rejections").toBe(0);
  expect.soft(["idle", "stopFailed", "disposed"], `the final state (${state})`).toContain(state);
  expect.soft(quiet.resolved, "quiesceEvidence() at the end").toBe(true);
  // At most one summary per recording, across retries.
  expect.soft(summaries.filter((e) => e.payload.jobId === "job-a").length, "summaries of job-a's recording").toBeLessThanOrEqual(1);
  // A recording whose first or timer poll failed has no summary.
  if (failedPoll) expect.soft(summaries.map((e) => e.payload.chainLength), "summaries of a recording whose first or timer poll failed").toEqual([]);
  // Each summary covers exactly the entries before it, and nothing of its job follows it.
  let since: Emitted[] = [];
  events.forEach((e, i) => {
    if (e.type === "log_hash_chain_entry") {
      since.push(e);
      return;
    }
    if (e.type !== "printer_job_verified") return;
    const job = e.payload.jobId;
    const mine = since.filter((x) => x.payload.jobId === job);
    expect.soft(e.payload.chainLength, `summary ${i}: chainLength vs the entries before it`).toBe(mine.length);
    expect.soft(e.payload.headHash, `summary ${i}: headHash`).toBe(mine.at(-1)?.payload.entryHash ?? null);
    expect.soft(e.payload.tailHash, `summary ${i}: tailHash`).toBe(mine[0]?.payload.previousHash ?? null);
    const later = events.slice(i + 1).filter((x) => x.type === "log_hash_chain_entry" && x.payload.jobId === job);
    expect.soft(later.map((x) => x.payload.rawContent), `summary ${i}: entries of job ${String(job)} after it`).toEqual([]);
    since = [];
  });
  // Not vacuous: a recording that nothing disrupted emits its entries and exactly one summary,
  // and every stop asked while it was live resolves with that summary.
  if (!failedAny && action !== "dispose") {
    expect.soft(entriesOf("job-a").length, "job-a's entries").toBeGreaterThan(0);
    expect.soft(summaries.map((e) => e.payload.jobId), "summaries").toEqual(["job-a"]);
    for (const c of calls.filter((x) => x.live && (x.what === "stop" || x.what === "re-entrant stop"))) {
      expect.soft(c.error, `${c.what}: its refusal`).toBeUndefined();
      expect.soft((c.value as Emitted | undefined)?.payload, `${c.what}: its summary`).toEqual(summaries[0]?.payload);
    }
  }
  // quiesceEvidence(), asked from inside a call, never answered with work in flight, and once
  // it answered nothing more was emitted unless a start or stop was asked for later.
  if (hook.resolved) {
    expect.soft(["idle", "stopFailed", "disposed"], `the state when quiesceEvidence() answered (${hook.stateAt})`).toContain(hook.stateAt);
    if (asks === hook.asksAt) expect.soft(events.length, "events after quiesceEvidence() answered").toBe(hook.seen);
  }
  expect.soft(capturedAfterDispose, "captures after dispose").toBe(0);
  expect.soft(summariesAfterDispose, "summaries after dispose").toBe(0);
  // A stop resolves with a summary only if its listeners received it: never one emitted to no one
  // after a dispose.
  for (const c of calls.filter((x) => (x.value as Emitted | undefined)?.type === "printer_job_verified")) {
    expect.soft(summaries.includes(c.value as Emitted), `${c.what}: its summary reached the listeners`).toBe(true);
  }
});
