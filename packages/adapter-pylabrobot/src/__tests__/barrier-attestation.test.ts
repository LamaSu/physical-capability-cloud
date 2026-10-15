/**
 * astra pack 194, under steward #5413's rule (no success without proven, job-bound evidence).
 * The sidecar's recording window is attested: it names the job and the sidecar process (its
 * generation) on open, on close and on a retried close. Nothing else counts as proof:
 *   - a barrier answered by another process (a restart) never releases a held adapter;
 *   - a window that could not be opened stops the run before anything physical;
 *   - the job is JobRunner's own id, end to end;
 *   - lifecycle events are the adapter's own: the sidecar cannot send a completion.
 * Every request is answered by a fake sidecar on an InMemoryTransport.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceEmitter, JobRunner } from "@pcc/kernel";
import type { EvidenceBundle } from "@pcc/spec";

import { PyLabRobotAdapter } from "../adapter.js";
import { InMemoryTransport, SidecarClient } from "../sidecar-client.js";
import type { AdapterEvidenceEvent } from "../types.js";

type Answer = { result: unknown } | { error: { code: number; message: string; data?: unknown } } | "hang";
type Handlers = Partial<Record<string, (params: Record<string, unknown>, transport: InMemoryTransport) => Answer>>;

/** A sidecar that answers each request by its method, on the next microtask. Unlisted methods answer { ok: true }. */
function fakeSidecar(handlers: Handlers): { transport: InMemoryTransport; methods: () => string[]; params: (method: string) => Array<Record<string, unknown>> } {
  const transport = new InMemoryTransport();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const send = transport.send.bind(transport);
  transport.send = (line: string) => {
    send(line);
    const msg = JSON.parse(line) as { id?: string | number; method: string; params?: Record<string, unknown> };
    sent.push({ method: msg.method, params: msg.params ?? {} });
    if (msg.id === undefined) return;
    const id = msg.id;
    const handler = handlers[msg.method];
    const answer: Answer = handler ? handler(msg.params ?? {}, transport) : { result: { ok: true } };
    if (answer === "hang") return;
    queueMicrotask(() => {
      if ("error" in answer) transport.respondError(id, answer.error.code, answer.error.message, answer.error.data);
      else transport.respondSuccess(id, answer.result);
    });
  };
  return {
    transport,
    methods: () => sent.map((s) => s.method),
    params: (method) => sent.filter((s) => s.method === method).map((s) => s.params),
  };
}

const GEN = "gen-1";
const init = (deviceId: string, generation = GEN) => () => ({ result: { ok: true, deviceId, plrBackend: "chatterbox", generation } });
const opened = (generation = GEN) => (p: Record<string, unknown>) => ({ result: { ok: true, jobId: p.jobId, startedAt: new Date().toISOString(), generation } });
const ran = (p: Record<string, unknown>) => ({ result: { ok: true, jobId: p.jobId, opCount: 1, durationMs: 5 } });
const closed = (generation = GEN) => (p: Record<string, unknown>) => ({ result: { ok: true, jobId: p.jobId, opCount: 1, generation } });

async function adapterOn(transport: InMemoryTransport, deviceId: string) {
  const sidecar = new SidecarClient({ inMemoryTransport: transport });
  await sidecar.start();
  const adapter = new PyLabRobotAdapter({ deviceId, kernelId: "kernel-att", plrBackend: "chatterbox", backendConfig: {}, sidecar });
  const events: AdapterEvidenceEvent[] = [];
  adapter.onEvidence((e) => events.push(e));
  return { sidecar, adapter, events };
}

function ask(adapter: PyLabRobotAdapter): { resolved: boolean } {
  const state = { resolved: false };
  void adapter.quiesceEvidence().then(() => (state.resolved = true));
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("astra pack 194: the barrier is proof only from the process that recorded the job", () => {
  it("HIGH 1: a retried barrier answered by another sidecar process (a restart) never releases the hold, and a new start stays refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let stops = 0;
    const fake = fakeSidecar({
      "backend.init": init("dev-gen"),
      "evidence.startRecording": opened(),
      "backend.run": ran,
      // The first barrier fails; every retry is answered by a fresh process: generation gen-2.
      "evidence.stopRecording": (p) => (++stops === 1 ? { error: { code: -32603, message: "drain failed" } } : closed("gen-2")(p)),
    });
    const { adapter } = await adapterOn(fake.transport, "dev-gen");
    const result = await (async () => {
      const r = adapter.execute({ type: "start", payload: { jobId: "j-gen" } });
      await vi.advanceTimersByTimeAsync(0);
      return r;
    })();
    expect.soft(result.success, "the run").toBe(false);
    const hook = ask(adapter);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000); // three retries, each answered by gen-2
    expect.soft(stops, "barrier calls").toBeGreaterThanOrEqual(3);
    expect.soft(hook.resolved, "the hook, after a restarted process answered").toBe(false);
    const refused = await adapter.execute({ type: "start", payload: { jobId: "j-next" } });
    expect.soft(refused.success, "a new start").toBe(false);
    expect.soft(fake.params("evidence.startRecording").map((p) => p.jobId), "windows opened").toEqual(["j-gen"]);
  });

  it("HIGH 3: a recording window that could not be opened stops the run before anything physical", async () => {
    const fake = fakeSidecar({
      "backend.init": init("dev-open"),
      "evidence.startRecording": () => ({ error: { code: -32603, message: "window refused" } }),
      "backend.run": ran,
      "evidence.stopRecording": closed(),
    });
    const { adapter, events } = await adapterOn(fake.transport, "dev-open");
    const result = await adapter.execute({ type: "start", payload: { jobId: "j-open" } });

    expect.soft(result.success, "the run").toBe(false);
    expect.soft(fake.methods(), "calls").not.toContain("backend.run");
    expect.soft(events.map((e) => e.type), "events").not.toContain("execution_completed");
  });

  it("MEDIUM: a completion the sidecar sends is not the adapter's to publish; with the barrier failing, none appears", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSidecar({
      "backend.init": init("dev-life"),
      "evidence.startRecording": opened(),
      "backend.run": (p, transport) => {
        transport.notify("evidence", { type: "execution_completed", deviceId: "dev-life", jobId: p.jobId, timestamp: new Date().toISOString(), payload: {} });
        return ran(p);
      },
      "evidence.stopRecording": () => ({ error: { code: -32603, message: "drain failed" } }),
    });
    const { adapter, events } = await adapterOn(fake.transport, "dev-life");
    const r = adapter.execute({ type: "start", payload: { jobId: "j-life" } });
    await vi.advanceTimersByTimeAsync(0);
    const result = await r;

    expect.soft(result.success, "the run").toBe(false);
    expect.soft(events.map((e) => e.type), "events").not.toContain("execution_completed");
  });
});

describe("the fix's own rules (astra pack 194)", () => {
  it.each([
    ["the same process says it never opened one", GEN, true],
    ["a restarted process says so", "gen-2", false],
  ] as const)("a window whose opening timed out holds the adapter until %s: released %s", async (_how, answeredBy, released) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSidecar({
      "backend.init": init("dev-unsure"),
      "evidence.startRecording": () => "hang",
      "evidence.stopRecording": () => ({ error: { code: -32006, message: "no recording window", data: { generation: answeredBy } } }),
    });
    const { adapter, events } = await adapterOn(fake.transport, "dev-unsure");
    const r = adapter.execute({ type: "start", payload: { jobId: "j-unsure" } });
    await vi.advanceTimersByTimeAsync(5_000); // the open times out
    const result = await r;
    expect.soft(result.success, "the run").toBe(false);
    expect.soft(fake.methods(), "calls").not.toContain("backend.run");
    expect.soft(events.map((e) => e.type), "events").toEqual(["device_birth", "execution_started", "execution_failed"]);
    const hook = ask(adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(hook.resolved, "the hook, before the sidecar has said").toBe(false);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    expect.soft(hook.resolved, "the hook, once it has").toBe(released);
  });

  it("once the window was attested open, the same process's \"no window\" is no proof: a held adapter stays held", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let stops = 0;
    const fake = fakeSidecar({
      "backend.init": init("dev-confirmed"),
      "evidence.startRecording": opened(),
      "backend.run": ran,
      // The barrier fails; every retry says no such window, from the SAME process.
      "evidence.stopRecording": () =>
        ++stops === 1
          ? { error: { code: -32603, message: "drain failed" } }
          : { error: { code: -32006, message: "no recording window", data: { generation: GEN } } },
    });
    const { adapter } = await adapterOn(fake.transport, "dev-confirmed");
    const r = adapter.execute({ type: "start", payload: { jobId: "j-confirmed" } });
    await vi.advanceTimersByTimeAsync(0);
    expect.soft((await r).success, "the run").toBe(false);
    const hook = ask(adapter);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect.soft(stops, "barrier calls").toBeGreaterThanOrEqual(3);
    expect.soft(hook.resolved, "the hook").toBe(false);
  });

  it("a start without the job's id is refused before anything reaches the sidecar", async () => {
    const fake = fakeSidecar({ "backend.init": init("dev-noid") });
    const { adapter } = await adapterOn(fake.transport, "dev-noid");
    const result = await adapter.execute({ type: "start", payload: { protocolSource: "inline-ops" } });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/start needs the job's id/);
    // Not even backend.init, which can run a backend's setup() on the device (astra pack 197).
    expect(fake.methods(), "calls the refused start made").toEqual([]);
  });

  it("a sidecar that names no generation cannot attest a window: the start fails, and opens none", async () => {
    const fake = fakeSidecar({ "backend.init": () => ({ result: { ok: true, deviceId: "dev-nogen", plrBackend: "chatterbox" } }) });
    const { adapter } = await adapterOn(fake.transport, "dev-nogen");
    const result = await adapter.execute({ type: "start", payload: { jobId: "j-nogen" } });
    expect(result.success).toBe(false);
    expect(fake.methods()).not.toContain("evidence.startRecording");
  });

  it("a close that attests another job, or no generation, proves nothing: the run fails and the adapter is held", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSidecar({
      "backend.init": init("dev-other"),
      "evidence.startRecording": opened(),
      "backend.run": ran,
      "evidence.stopRecording": () => ({ result: { ok: true, jobId: "j-someone-else", generation: GEN } }),
    });
    const { adapter, events } = await adapterOn(fake.transport, "dev-other");
    const r = adapter.execute({ type: "start", payload: { jobId: "j-mine" } });
    await vi.advanceTimersByTimeAsync(0);
    const result = await r;
    expect.soft(result.success, "the run").toBe(false);
    expect.soft(result.message, "why").toMatch(/did not attest job j-mine's window/);
    expect.soft(events.map((e) => e.type), "events").not.toContain("execution_completed");
    const hook = ask(adapter);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect.soft(hook.resolved, "the hook").toBe(false);
  });
});

describe("astra pack 194 HIGH 2: JobRunner's job id is the one PyLabRobot records under, end to end", () => {
  it("JobRunner over the adapter: the window opens for JobRunner's job, and every execution event the bundle signs names it", async () => {
    const fake = fakeSidecar({
      "backend.init": init("dev-int"),
      "backend.status": () => ({ result: { status: "idle", progress: 100 } }),
      "evidence.startRecording": opened(),
      "backend.run": (p, transport) => {
        transport.notify("evidence", { type: "aspirate", deviceId: "dev-int", jobId: p.jobId, timestamp: new Date().toISOString(), payload: { well: "A1" } });
        return ran(p);
      },
      "evidence.stopRecording": closed(),
    });
    const { adapter } = await adapterOn(fake.transport, "dev-int");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new EvidenceEmitter("kernel-att");
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));

    const result = await new JobRunner(adapter, [], null, emitter).run({
      jobId: "job-A",
      stepId: "step-1",
      gcodeHash: `sha256:${"ab".repeat(32)}`,
      assuranceTier: 0,
    });

    expect.soft(result.success, "the run").toBe(true);
    expect.soft(fake.params("evidence.startRecording").map((p) => p.jobId), "the window's job").toEqual(["job-A"]);
    expect.soft(fake.params("backend.run").map((p) => p.jobId), "the run's job").toEqual(["job-A"]);
    const named = (bundles[0]?.events ?? [])
      .map((e) => (e.payload as Record<string, unknown>).jobId)
      .filter((j) => j !== undefined);
    expect.soft(named.length, "events naming a job").toBeGreaterThan(0);
    expect.soft([...new Set(named)], "the jobs the bundle's events name").toEqual(["job-A"]);
  });
});
