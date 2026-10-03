/**
 * PrinterLogAdapter re-entered from inside every collaborator call (steward ruling on 199,
 * part (1)). Three review rounds each found one more window in which a collaborator that
 * re-enters the adapter saw an operation before it was registered: overlapping polls (190),
 * the start (198) and the timer poll (199). A fourth found a failure the poll's latch missed
 * (200). This walks the whole class instead of the next instance.
 *
 * The run is a start, one timer poll and a stop. The k-th call of each collaborator (the log
 * capture's reset, the log provider, the log capture's captureEntry) calls one of the
 * adapter's public operations, and an asynchronous one then holds its answer until everything
 * else has run. Then it answers, or fails with a reason that has no text form. Whatever
 * re-enters where, the evidence keeps its invariants:
 *   - nothing of a job's recording is emitted after its printer_job_verified;
 *   - a summary covers exactly the entries emitted before it in its recording;
 *   - a recording in which a log poll failed emits no summary;
 *   - quiesceEvidence() never answers while a start, a recording or a stop is in flight, and
 *     once it answers nothing more is emitted until a new start or stop is asked for;
 *   - nothing is captured after dispose;
 *   - a stop asked while a recording starts, runs or stops is that recording's stop: it is
 *     refused only because a poll failed;
 *   - every call settles, nothing is left unhandled, and the adapter ends idle, stopFailed or
 *     disposed.
 * Against the adapter at 5b9aafeb this finds 198's windows, at c4d991ce 199's, and at
 * 89a230e2 200's.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";

import { PrinterLogAdapter } from "../adapters/printer-log-adapter.js";
import type { LogCaptureService } from "../log-capture-service.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-printer-log-reentrancy";
const ACTIONS = ["stop", "quiesce", "dispose", "start-same", "start-other"] as const;
const ASYNC_SITES = ["provider#1", "provider#2", "provider#3", "capture#1", "capture#2", "capture#3"] as const;
const CASES = [
  ...["reset#1", "reset#2"].flatMap((site) => ACTIONS.map((action) => [site, action, "answers"] as const)),
  ...ASYNC_SITES.flatMap((site) => ACTIONS.flatMap((action) => [[site, action, "answers"] as const, [site, action, "fails"] as const])),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(CASES)("%s re-enters %s, then %s", async (site, action, outcome) => {
  const events: Emitted[] = [];
  const chain: Array<{ entryHash: string; previousHash: string }> = [];
  const counts = { reset: 0, provider: 0, capture: 0 };
  let n = 0;
  let fired = false;
  let failedPoll = false;
  let disposed = false;
  let capturedAfterDispose = 0;
  let asks = 0; // starts and stops asked for, by the driver or a re-entrant call
  const hook = { resolved: false, seen: -1, asksAt: -1, stateAt: "" };
  const calls: Array<{ what: string; done: boolean; error?: string }> = [];
  const held: Array<() => void> = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => void unhandled.push(err);
  let log!: PrinterLogAdapter;

  const track = (what: string, p: Promise<unknown>) => {
    const call: { what: string; done: boolean; error?: string } = { what, done: false };
    calls.push(call);
    p.then(
      () => (call.done = true),
      (err: unknown) => {
        call.done = true;
        call.error = err instanceof Error ? err.message : "a reason with no text form";
      },
    );
  };
  const reenter = () => {
    fired = true;
    if (action === "stop") {
      asks++;
      track("re-entrant stop", log.stopRecording());
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
    } else {
      asks++;
      track(`re-entrant ${action}`, log.startRecording(action === "start-same" ? "job-a" : "job-b"));
    }
  };
  /** At the chosen site the collaborator re-enters, then holds its answer until released: it answers, or fails. */
  const answer = <T>(here: string, value: () => T): Promise<T> => {
    if (here !== site) return Promise.resolve().then(value);
    reenter();
    return new Promise<T>((resolve, reject) =>
      held.push(() => {
        if (outcome === "answers") return resolve(value());
        failedPoll = true;
        reject(Object.create(null)); // a legal rejection with no text form (astra pack 200)
      }),
    );
  };
  const capture = {
    reset: () => {
      counts.reset += 1;
      chain.length = 0;
      if (`reset#${counts.reset}` === site) reenter();
    },
    getChain: () => chain,
    captureEntry: (rawContent: string) => {
      counts.capture += 1;
      if (disposed) capturedAfterDispose += 1;
      return answer(`capture#${counts.capture}`, () => {
        const entry = { entryId: `e${++n}`, entryHash: `h${n}`, previousHash: `h${n - 1}`, rawContent, capturedAt: new Date().toISOString(), kernelSignature: "sig" };
        chain.push(entry);
        return entry;
      });
    },
  } as unknown as LogCaptureService;
  const logProvider = (jobId: string): Promise<string | null> => {
    counts.provider += 1;
    const k = counts.provider;
    return answer(`provider#${k}`, () => `${jobId} line ${k}`);
  };

  process.on("unhandledRejection", onUnhandled);
  try {
    log = new PrinterLogAdapter("log-reentrancy", KERNEL_ID, capture, { pollIntervalMs: 1_000, logProvider });
    log.onEvidence((e) => events.push(e));

    /** Lets everything run, then releases the held answers one at a time. */
    const drain = async () => {
      await vi.advanceTimersByTimeAsync(0);
      while (held.length > 0) {
        held.shift()!();
        await vi.advanceTimersByTimeAsync(0);
      }
    };
    asks++;
    track("start", log.startRecording("job-a"));
    await drain();
    await vi.advanceTimersByTimeAsync(1_000); // one timer poll
    await drain();
    asks++;
    track("stop", log.stopRecording());
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

  // The re-entrant call ran (a site the run never reaches would make the case vacuous).
  expect.soft(fired, "the re-entrant call ran").toBe(true);
  // Every call settled, nothing was left unhandled, and the adapter ended with nothing running.
  expect.soft(calls.filter((c) => !c.done).map((c) => c.what), "calls still pending").toEqual([]);
  expect.soft(unhandled.length, "unhandled rejections").toBe(0);
  expect.soft(["idle", "stopFailed", "disposed"], `the final state (${state})`).toContain(state);
  expect.soft(quiet.resolved, "quiesceEvidence() at the end").toBe(true);
  // Nothing of a recording after its summary, each summary covers exactly its entries, and a
  // recording in which a log poll failed has no summary.
  const summaries = events.filter((e) => e.type === "printer_job_verified");
  if (failedPoll) expect.soft(summaries.map((e) => e.payload.chainLength), "summaries of a recording in which a log poll failed").toEqual([]);
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
    const later = events.slice(i + 1).filter((x) => x.type === "log_hash_chain_entry" && x.payload.jobId === job);
    expect.soft(later.map((x) => x.payload.rawContent), `summary ${i}: entries of job ${String(job)} after it`).toEqual([]);
    since = [];
  });
  // quiesceEvidence(), asked from inside a collaborator, never answered with work in flight,
  // and once it answered nothing more was emitted unless a start or stop was asked for later.
  if (hook.resolved) {
    expect.soft(["idle", "stopFailed", "disposed"], `the state when quiesceEvidence() answered (${hook.stateAt})`).toContain(hook.stateAt);
    if (asks === hook.asksAt) expect.soft(events.length, "events after quiesceEvidence() answered").toBe(hook.seen);
  }
  expect.soft(capturedAfterDispose, "captures after dispose").toBe(0);
  // Every collaborator call is made while a recording starts, runs or stops, so a stop asked
  // from inside one is that recording's stop: refused only because a poll failed.
  if (action === "stop" && !failedPoll) expect.soft(calls.find((c) => c.what === "re-entrant stop")?.error, "the re-entrant stop's refusal").toBeUndefined();
});
