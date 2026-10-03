/**
 * IppAdapter while its optional `ipp` import is still loading (astra pack 467, steward #5495).
 *
 * A real-configured adapter (mockMode:false) cannot tell, until the import settles, whether it
 * will run real IPP or fall back to the mock. So it is marked simulated until the import
 * succeeds, and every call waits for the import: no call takes the mock path unmarked, an import
 * that fails marks the adapter before any mock answer, and only a loaded `ipp` says
 * simulated:false. A real-configured adapter never answers with the mock printer's data.
 *
 * The `ipp` package is not installed here: each test holds `import("ipp")` pending with its own
 * gated mock of it. Events are recorded as they were when emitted, since they share the
 * adapter's `source` object and a later marker would otherwise show on them too.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";

import type { IppAdapter as IppAdapterClass } from "../adapters/ipp-adapter.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
type Answer = [Error | null, Record<string, unknown>];

const KERNEL_ID = "kernel-ipp-loading";
const URI = "ipp://printer.test/ipp/print";

afterEach(() => {
  vi.doUnmock("ipp");
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A fake IPP printer: each operation answers from `answers` (an empty success by default), and is recorded. */
function fakePrinter(requests: string[], answers: Record<string, () => Answer> = {}) {
  return class Printer {
    constructor(readonly uri: string) {}
    execute(op: string, _msg: unknown, _data: unknown, cb: (err: Error | null, res: Record<string, unknown>) => void): void {
      requests.push(op);
      const [err, res] = answers[op]?.() ?? [null, {}];
      queueMicrotask(() => cb(err, res));
    }
  };
}

/**
 * A fresh IppAdapter class whose `import("ipp")` stays pending until the test settles it:
 * `resolve()` loads a module with `Printer`, `reject()` fails as an uninstalled package does.
 */
async function gatedIpp(Printer?: unknown): Promise<{ IppAdapter: typeof IppAdapterClass; resolve: () => void; reject: () => void }> {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  let fails = false;
  vi.resetModules();
  vi.doMock("ipp", async () => {
    await opened;
    if (fails) throw new Error("Cannot find package 'ipp'");
    return { Printer };
  });
  const { IppAdapter } = await import("../adapters/ipp-adapter.js");
  return {
    IppAdapter,
    resolve: () => open(),
    reject: () => {
      fails = true;
      open();
    },
  };
}

/** Each event as it was when emitted. */
function record(ipp: IppAdapterClass): Emitted[] {
  const events: Emitted[] = [];
  ipp.onEvidence((e) => events.push(structuredClone(e)));
  return events;
}

function settle<T>(call: Promise<T>): Promise<{ value?: T; error?: string }> {
  return call.then(
    (value) => ({ value }),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
}

/** Lets pending microtasks and short timers run, as a caller waiting on its own work would. */
const pause = () => new Promise((r) => setTimeout(r, 20));

describe("IppAdapter while its optional `ipp` import loads (astra pack 467)", () => {
  it("is marked simulated until the import settles: simulated:false once `ipp` loaded, simulated:true if it failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = await gatedIpp(fakePrinter([]));
    const real = new ok.IppAdapter("ipp-load-ok", { uri: URI, kernelId: KERNEL_ID, mockMode: false });
    expect.soft(real.source.simulated, "while `ipp` loads").toBe(true);
    ok.resolve();
    await vi.dynamicImportSettled();
    await pause();
    expect.soft(real.source.simulated, "once `ipp` loaded").toBe(false);

    const failing = await gatedIpp();
    const downgraded = new failing.IppAdapter("ipp-load-fails", { uri: URI, kernelId: KERNEL_ID, mockMode: false });
    expect.soft(downgraded.source.simulated, "while `ipp` loads").toBe(true);
    failing.reject();
    await vi.dynamicImportSettled();
    await pause();
    expect.soft(downgraded.source.simulated, "once `ipp` failed to load").toBe(true);
  });

  it("a start while `ipp` loads waits for it, then prints on the real printer: nothing mock, and its events say simulated:false", async () => {
    const requests: string[] = [];
    const g = await gatedIpp(fakePrinter(requests, { "Print-Job": () => [null, { "job-attributes-tag": { "job-id": 42 } }] }));
    const ipp = new g.IppAdapter("ipp-load-start", { uri: URI, kernelId: KERNEL_ID, mockMode: false, pollIntervalMs: 60_000 });
    const events = record(ipp);

    const started = settle(ipp.execute({ type: "start", payload: { documentData: "%PDF-1.4", jobName: "doc" } }));
    await pause();
    expect.soft(events, "events while `ipp` loads").toEqual([]);
    expect.soft(requests, "printer requests while `ipp` loads").toEqual([]);

    g.resolve();
    const result = await started;
    expect.soft(result.value, "the start").toMatchObject({ success: true, data: { jobId: 42 } });
    expect.soft(requests, "printer requests").toEqual(["Print-Job"]);
    expect.soft(events.map((e) => [e.type, e.source.simulated, e.payload.mock]), "events, as emitted").toEqual([["execution_started", false, undefined]]);
    await ipp.dispose();
  });

  it("an import that fails marks the adapter before any mock answer: a start while it loads then runs the mock, and every event says simulated:true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = await gatedIpp();
    const ipp = new g.IppAdapter("ipp-load-downgrade", { uri: URI, kernelId: KERNEL_ID, mockMode: false });
    const events = record(ipp);

    const started = settle(ipp.execute({ type: "start", payload: { jobName: "doc", totalPages: 1 } }));
    await pause();
    expect.soft(events, "events while `ipp` loads").toEqual([]);

    g.reject();
    const result = await started;
    expect.soft(result.value?.success, "the start, on the mock").toBe(true);
    expect.soft(events.map((e) => [e.type, e.source.simulated, e.payload.mock]), "events, as emitted").toEqual([["execution_started", true, true]]);
    expect.soft(warn, "the downgrade warning").toHaveBeenCalledTimes(1);
    await ipp.dispose();
  });

  it("status, capabilities and cancel while `ipp` loads wait for it, then answer from the real printer, not the mock", async () => {
    const requests: string[] = [];
    const g = await gatedIpp(
      fakePrinter(requests, {
        "Get-Printer-Attributes": () => [null, { "printer-attributes-tag": { "printer-state": 4, "printer-make-and-model": "HP OfficeJet Pro 9015e" } }],
      }),
    );
    const ipp = new g.IppAdapter("ipp-load-reads", { uri: URI, kernelId: KERNEL_ID, mockMode: false });

    const status = settle(ipp.getStatus());
    const caps = settle(ipp.getCapabilities());
    const cancel = settle(ipp.cancelJob(7));
    await pause();
    expect.soft(requests, "printer requests while `ipp` loads").toEqual([]);

    g.resolve();
    expect.soft((await status).value, "the status: processing").toBe("busy");
    expect.soft((await caps).value?.makeModel, "the capabilities").toBe("HP OfficeJet Pro 9015e");
    expect.soft((await cancel).error, "the cancel").toBeUndefined();
    expect.soft([...requests].sort(), "printer requests").toEqual(["Cancel-Job", "Get-Printer-Attributes", "Get-Printer-Attributes"]);
  });

  it("quiesceEvidence() while a start waits for `ipp` waits for that start, and nothing is emitted after it answers", async () => {
    const requests: string[] = [];
    const g = await gatedIpp(
      fakePrinter(requests, {
        "Print-Job": () => [null, { "job-attributes-tag": { "job-id": 43 } }],
        "Get-Job-Attributes": () => [null, { "job-attributes-tag": { "job-state": 9, "job-impressions-completed": 1 } }],
      }),
    );
    const ipp = new g.IppAdapter("ipp-load-quiesce", { uri: URI, kernelId: KERNEL_ID, mockMode: false, pollIntervalMs: 10 });
    const events = record(ipp);

    const started = settle(ipp.execute({ type: "start", payload: { documentData: "%PDF-1.4", jobName: "doc" } }));
    const hook = { resolved: false, seen: -1 };
    void ipp.quiesceEvidence().then(() => {
      hook.resolved = true;
      hook.seen = events.length;
    });
    await pause();
    expect.soft(hook.resolved, "quiesceEvidence() while the start waits for `ipp`").toBe(false);

    g.resolve();
    await started;
    await vi.waitFor(() => expect(hook.resolved).toBe(true), { timeout: 2_000 });
    expect.soft(events.map((e) => e.type), "events").toEqual(["execution_started", "execution_completed"]);
    expect.soft(hook.seen, "events emitted when it answered").toBe(events.length);
    await pause();
    expect.soft(events.length, "events after it answered").toBe(hook.seen);
    await ipp.dispose();
  });

  it("a start while `ipp` loads, then dispose: once `ipp` loads, that start runs nothing", async () => {
    const requests: string[] = [];
    const g = await gatedIpp(fakePrinter(requests, { "Print-Job": () => [null, { "job-attributes-tag": { "job-id": 44 } }] }));
    const ipp = new g.IppAdapter("ipp-load-dispose", { uri: URI, kernelId: KERNEL_ID, mockMode: false });
    const events = record(ipp);

    const started = settle(ipp.execute({ type: "start", payload: { documentData: "%PDF-1.4", jobName: "doc" } }));
    await pause();
    await ipp.dispose();
    g.resolve();
    const result = await started;
    expect.soft(result.value?.success, "the start").toBe(false);
    expect.soft(result.value?.message ?? "", "why").toMatch(/disposed while the 'ipp' package loaded: start not run/);
    expect.soft(requests, "printer requests").toEqual([]);
    expect.soft(events, "events").toEqual([]);
    let quiet = false;
    void ipp.quiesceEvidence().then(() => (quiet = true));
    await pause();
    expect.soft(quiet, "quiesceEvidence(), once that start settled").toBe(true);
  });

  it("a loaded real adapter whose printer query fails rejects getCapabilities(): it never answers with the mock printer's capabilities", async () => {
    const requests: string[] = [];
    const g = await gatedIpp(fakePrinter(requests, { "Get-Printer-Attributes": () => [new Error("connect ECONNREFUSED 192.0.2.10:631"), {}] }));
    const ipp = new g.IppAdapter("ipp-caps-fails", { uri: URI, kernelId: KERNEL_ID, mockMode: false });
    g.resolve();
    await vi.dynamicImportSettled();
    await pause();

    const caps = await settle(ipp.getCapabilities());
    expect.soft(caps.value?.makeModel, "capabilities answered").toBeUndefined();
    expect.soft(caps.error ?? "resolved", "the refusal").toMatch(/ECONNREFUSED/);
    expect.soft(requests, "printer requests").toEqual(["Get-Printer-Attributes"]);
  });
});
