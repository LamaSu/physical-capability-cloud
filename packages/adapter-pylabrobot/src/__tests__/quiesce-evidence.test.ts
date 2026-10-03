/**
 * PyLabRobotAdapter.quiesceEvidence() (#502 round 3b): it resolves at once when nothing is
 * outstanding, and otherwise only once every run or call in flight has returned and every
 * mock completion has been emitted, so the adapter's evidence for that work is all out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PyLabRobotAdapter } from "../adapter.js";
import { InMemoryTransport, SidecarClient } from "../sidecar-client.js";
import type { AdapterEvidenceEvent } from "../types.js";

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Answer the sidecar call the adapter sent last, as a sidecar that succeeds would; return its method. */
function answerLast(transport: InMemoryTransport, deviceId: string, jobId: string): string {
  const sent = transport.lastSent() as { id: string; method: string };
  const results: Record<string, unknown> = {
    "backend.init": { ok: true, deviceId, plrBackend: "chatterbox" },
    "evidence.startRecording": { ok: true },
    "backend.run": { ok: true, jobId, opCount: 1, durationMs: 10 },
    "evidence.stopRecording": { ok: true },
    "backend.shutdown": { ok: true },
  };
  transport.respondSuccess(sent.id, results[sent.method]);
  return sent.method;
}

/** Ask the adapter to quiesce; note whether it resolved, and the events it had emitted by then. */
function ask(adapter: PyLabRobotAdapter, events: AdapterEvidenceEvent[]): { resolved: boolean; seen?: string[] } {
  const state: { resolved: boolean; seen?: string[] } = { resolved: false };
  void adapter.quiesceEvidence().then(() => {
    state.resolved = true;
    state.seen = events.map((e) => e.type);
  });
  return state;
}

describe("PyLabRobotAdapter.quiesceEvidence", () => {
  it("(mock mode) resolves at once when idle, and after start only once the scheduled execution_completed is emitted", async () => {
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, mockMode: true });
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));
    const idle = ask(adapter, events);
    await Promise.resolve();
    expect(idle.resolved).toBe(true);

    await adapter.execute({ type: "start", payload: { jobId: "mock-q" } });
    const hook = ask(adapter, events);
    await Promise.resolve();
    expect(hook.resolved, "the completion is still scheduled").toBe(false);
    await tick();
    expect(hook.resolved).toBe(true);
    expect(hook.seen?.at(-1)).toBe("execution_completed");
  });

  it("(sidecar) resolves only once the start call, which runs the whole protocol, has returned with every notification forwarded", async () => {
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-real", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const startP = adapter.execute({ type: "start", payload: { jobId: "j-q" } });
    const hook = ask(adapter, events);
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true, deviceId: "dev-q-real", plrBackend: "chatterbox" }); // backend.init
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true }); // evidence.startRecording
    await tick();
    transport.notify("evidence", { type: "aspirate", deviceId: "dev-q-real", jobId: "j-q", timestamp: new Date().toISOString(), payload: { well: "A1" } });
    await tick();
    expect(hook.resolved, "backend.run is in flight").toBe(false);
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true, jobId: "j-q", opCount: 1, durationMs: 10 }); // backend.run
    await tick();
    expect(hook.resolved, "evidence.stopRecording is in flight").toBe(false);
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true }); // evidence.stopRecording
    await startP;
    await tick();

    expect(hook.resolved).toBe(true);
    expect(hook.seen).toEqual(["device_birth", "execution_started", "instrument_result", "execution_completed"]);
  });

  it("(sidecar) waits for a status call in flight, which can initialise the sidecar and emit device_birth", async () => {
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-status", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const statusP = adapter.getStatus();
    const hook = ask(adapter, events);
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true, deviceId: "dev-q-status", plrBackend: "chatterbox" }); // backend.init
    await tick();
    expect(hook.resolved, "backend.status is in flight").toBe(false);
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { status: "idle", progress: 0 }); // backend.status
    await expect(statusP).resolves.toBe("idle");
    await tick();
    expect(hook).toMatchObject({ resolved: true, seen: ["device_birth"] });
  });
});

describe("astra pack 186 HIGH: a job-bound notification after its job's window is never forwarded", () => {
  it("(sidecar) astra's recipe: an aspirate of job j-q that arrives after evidence.stopRecording answered, and after the hook resolved, is dropped", async () => {
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-late", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const startP = adapter.execute({ type: "start", payload: { jobId: "j-q" } });
    const hook = ask(adapter, events);
    for (const method of ["backend.init", "evidence.startRecording", "backend.run", "evidence.stopRecording"]) {
      await tick();
      expect(answerLast(transport, "dev-q-late", "j-q")).toBe(method);
    }
    await startP;
    await tick();
    expect(hook.resolved).toBe(true);

    const atResolution = events.map((e) => e.type);
    transport.notify("evidence", { type: "aspirate", deviceId: "dev-q-late", jobId: "j-q", timestamp: new Date().toISOString(), payload: { well: "A1" } });
    await tick();
    expect(events.map((e) => e.type), "events emitted after the hook resolved").toEqual(atResolution);
  });

  it("(sidecar) a late notification of job A that arrives while job B is recording is never recorded under B", async () => {
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-ab", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const runA = adapter.execute({ type: "start", payload: { jobId: "j-a" } });
    for (const method of ["backend.init", "evidence.startRecording", "backend.run", "evidence.stopRecording"]) {
      await tick();
      expect(answerLast(transport, "dev-q-ab", "j-a")).toBe(method);
    }
    await runA;

    const runB = adapter.execute({ type: "start", payload: { jobId: "j-b" } });
    const fromB = events.length;
    await tick();
    expect(answerLast(transport, "dev-q-ab", "j-b")).toBe("evidence.startRecording");
    await tick();
    transport.notify("evidence", { type: "aspirate", deviceId: "dev-q-ab", jobId: "j-a", timestamp: new Date().toISOString(), payload: { well: "A1", of: "job A" } });
    await tick();
    for (const method of ["backend.run", "evidence.stopRecording"]) {
      expect(answerLast(transport, "dev-q-ab", "j-b")).toBe(method);
      await tick();
    }
    await runB;

    const duringB = events.slice(fromB);
    expect(duringB.map((e) => e.type), "B's events").toEqual(["execution_started", "execution_completed"]);
    expect(duringB.map((e) => e.payload), "B's payloads").not.toContainEqual(expect.objectContaining({ of: "job A" }));
  });
});

describe("astra pack 186 HIGH: the sidecar's stopRecording answer is the barrier, and nothing skips it", () => {
  it("(sidecar) a notification of the job that arrives after backend.run answered, before the barrier's answer, comes before execution_completed and is counted", async () => {
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-order", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const startP = adapter.execute({ type: "start", payload: { jobId: "j-o" } });
    for (const method of ["backend.init", "evidence.startRecording", "backend.run"]) {
      await tick();
      expect(answerLast(transport, "dev-q-order", "j-o")).toBe(method);
    }
    await tick();
    // Written by the sidecar before it answers the barrier.
    transport.notify("evidence", { type: "aspirate", deviceId: "dev-q-order", jobId: "j-o", timestamp: new Date().toISOString(), payload: { well: "A1" } });
    await tick();
    expect(answerLast(transport, "dev-q-order", "j-o")).toBe("evidence.stopRecording");
    await startP;

    expect(events.map((e) => e.type)).toEqual(["device_birth", "execution_started", "instrument_result", "execution_completed"]);
    expect(events.at(-1)?.payload, "execution_completed").toMatchObject({ jobId: "j-o", opCount: 1 });
  });

  it("(sidecar) a failed run's notification that arrives before the barrier's answer is recorded, before execution_failed", async () => {
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-fail", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const startP = adapter.execute({ type: "start", payload: { jobId: "j-f" } });
    for (const method of ["backend.init", "evidence.startRecording"]) {
      await tick();
      expect(answerLast(transport, "dev-q-fail", "j-f")).toBe(method);
    }
    await tick();
    const run = transport.lastSent() as { id: string; method: string };
    expect(run.method).toBe("backend.run");
    transport.respondError(run.id, -32001, "protocol failed: tip collision");
    await tick();
    // Written by the sidecar before it answers the barrier.
    transport.notify("evidence", { type: "aspirate", deviceId: "dev-q-fail", jobId: "j-f", timestamp: new Date().toISOString(), payload: { well: "A1" } });
    await tick();
    expect(answerLast(transport, "dev-q-fail", "j-f")).toBe("evidence.stopRecording");
    const result = await startP;

    expect(result.success).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["device_birth", "execution_started", "instrument_result", "execution_failed"]);
  });

  it("(sidecar) when the sidecar is recycled after a job, the old sidecar answers the barrier first", async () => {
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-recycle", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar, restartAfterJobs: 1 });
    await sidecar.start();

    const startP = adapter.execute({ type: "start", payload: { jobId: "j-r" } });
    const methods: string[] = [];
    for (let i = 0; i < 5; i++) {
      await tick();
      methods.push(answerLast(transport, "dev-q-recycle", "j-r"));
    }
    await startP;
    expect(methods).toEqual(["backend.init", "evidence.startRecording", "backend.run", "evidence.stopRecording", "backend.shutdown"]);
  });
});

describe("astra pack 191 HIGH: a barrier that fails proves nothing, so the run fails and the sidecar is stopped", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive start up to the barrier: init, startRecording and run answered; returns the barrier's request id. */
  async function upToTheBarrier(transport: InMemoryTransport, deviceId: string, jobId: string, run: "ok" | "fails"): Promise<string> {
    for (const method of ["backend.init", "evidence.startRecording"]) {
      await vi.advanceTimersByTimeAsync(0);
      expect(answerLast(transport, deviceId, jobId)).toBe(method);
    }
    await vi.advanceTimersByTimeAsync(0);
    const runCall = transport.lastSent() as { id: string; method: string };
    expect(runCall.method).toBe("backend.run");
    if (run === "ok") transport.respondSuccess(runCall.id, { ok: true, jobId, opCount: 1, durationMs: 10 });
    else transport.respondError(runCall.id, -32001, "protocol failed: tip collision");
    await vi.advanceTimersByTimeAsync(0);
    const barrier = transport.lastSent() as { id: string; method: string };
    expect(barrier.method).toBe("evidence.stopRecording");
    return barrier.id;
  }

  it.each([
    ["rejects", "fails"],
    ["times out", "fails"],
  ] as const)("(sidecar) after a run that succeeded, a barrier that %s fails the run with no execution_completed, and stops the sidecar before start returns", async (how) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-barrier", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));
    let done = false;
    let aliveAtReturn: boolean | undefined;
    const startP = adapter.execute({ type: "start", payload: { jobId: "j-bar" } }).then((r) => ((done = true), (aliveAtReturn = sidecar.isAlive()), r));
    const hook = ask(adapter, events);

    const barrierId = await upToTheBarrier(transport, "dev-q-barrier", "j-bar", "ok");
    if (how === "rejects") transport.respondError(barrierId, -32603, "drain failed");
    else await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    // A shutdown, if the adapter stops the sidecar: answer it, so the stop completes.
    const after = transport.lastSent() as { id: string; method: string };
    if (after.method === "backend.shutdown") transport.respondSuccess(after.id, { ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await startP;

    expect.soft(result.success, "the run").toBe(false);
    expect.soft(events.map((e) => e.type), "events").not.toContain("execution_completed");
    expect.soft(events.map((e) => e.type), "events").toContain("execution_failed");
    expect.soft(after.method, "the call after the failed barrier").toBe("backend.shutdown");
    expect.soft(aliveAtReturn, "the sidecar, when start returned").toBe(false);
    expect.soft(done && hook.resolved, "the hook answered, once start returned").toBe(true);
    // Whatever the stopped sidecar's transport still delivers is not forwarded.
    const settled = events.length;
    transport.notify("evidence", { type: "aspirate", deviceId: "dev-q-barrier", jobId: "j-bar", timestamp: new Date().toISOString(), payload: { well: "A1" } });
    transport.notify("evidence", { type: "calibration_record", deviceId: "dev-q-barrier", jobId: null, timestamp: new Date().toISOString(), payload: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(events.length, "events from the stopped sidecar").toBe(settled);
  });

  it("(sidecar) after a run that failed, a barrier that fails also stops the sidecar before start returns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const transport = new InMemoryTransport();
    const sidecar = new SidecarClient({ inMemoryTransport: transport });
    const adapter = new PyLabRobotAdapter({ deviceId: "dev-q-barrier-f", kernelId: "kernel-q", plrBackend: "chatterbox", backendConfig: {}, sidecar });
    await sidecar.start();
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));
    const startP = adapter.execute({ type: "start", payload: { jobId: "j-bar-f" } });

    const barrierId = await upToTheBarrier(transport, "dev-q-barrier-f", "j-bar-f", "fails");
    transport.respondError(barrierId, -32603, "drain failed");
    await vi.advanceTimersByTimeAsync(0);
    const after = transport.lastSent() as { id: string; method: string };
    if (after.method === "backend.shutdown") transport.respondSuccess(after.id, { ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await startP;

    expect.soft(result.success, "the run").toBe(false);
    expect.soft(after.method, "the call after the failed barrier").toBe("backend.shutdown");
    expect.soft(events.map((e) => e.type), "events").not.toContain("execution_completed");
  });
});
