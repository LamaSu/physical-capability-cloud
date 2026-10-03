/**
 * One run per device (astra pack 473 (a), steward #5528). The adapter records one job at a time:
 * its collector and the job it binds notifications to are the adapter's own, and the sidecar
 * keeps one recording window per device. A second start while a run is in flight used to
 * take both over. The first job's ops were then dropped as "not recording", and it still
 * completed. So a start is refused while a run is in flight, before anything reaches the
 * sidecar. The run is reserved before the first await, so two starts in the same tick cannot
 * both pass the check. Every request is answered by a fake sidecar on an InMemoryTransport.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { PyLabRobotAdapter } from "../adapter.js";
import { InMemoryTransport, SidecarClient } from "../sidecar-client.js";
import type { AdapterEvidenceEvent } from "../types.js";

type Failure = { code: number; message: string; data?: unknown };

/**
 * A sidecar whose runs are held until the test releases them. Window opens answer at once,
 * unless `openFails` names the job. Every request is recorded as "method(jobId)".
 */
function heldSidecar(openFails?: string): {
  transport: InMemoryTransport;
  sent: string[];
  release: (jobId: string) => void;
  running: (jobId: string) => boolean;
} {
  const transport = new InMemoryTransport();
  const sent: string[] = [];
  const held = new Map<string, () => void>();
  const send = transport.send.bind(transport);
  transport.send = (line: string) => {
    send(line);
    const msg = JSON.parse(line) as { id?: string | number; method: string; params?: Record<string, unknown> };
    const p = msg.params ?? {};
    sent.push(`${msg.method}${typeof p.jobId === "string" ? `(${p.jobId})` : ""}`);
    if (msg.id === undefined) return;
    const id = msg.id;
    const answer = (result: unknown) => queueMicrotask(() => transport.respondSuccess(id, result));
    const fail = (e: Failure) => queueMicrotask(() => transport.respondError(id, e.code, e.message, e.data));
    switch (msg.method) {
      case "backend.init":
        return answer({ ok: true, deviceId: "dev-one", plrBackend: "chatterbox", generation: "g1" });
      case "evidence.startRecording":
        if (p.jobId === openFails) return fail({ code: -32603, message: "window refused" });
        return answer({ ok: true, jobId: p.jobId, startedAt: new Date().toISOString(), generation: "g1" });
      case "backend.run":
        held.set(String(p.jobId), () => transport.respondSuccess(id, { ok: true, jobId: p.jobId, opCount: 1, durationMs: 5 }));
        return;
      case "evidence.stopRecording":
        return answer({ ok: true, jobId: p.jobId, opCount: 1, generation: "g1" });
      default:
        return answer({ ok: true });
    }
  };
  return {
    transport,
    sent,
    release: (jobId) => held.get(jobId)?.(),
    running: (jobId) => held.has(jobId),
  };
}

async function adapterOn(transport: InMemoryTransport) {
  const sidecar = new SidecarClient({ inMemoryTransport: transport });
  await sidecar.start();
  const adapter = new PyLabRobotAdapter({ deviceId: "dev-one", kernelId: "kernel-one", plrBackend: "chatterbox", backendConfig: {}, sidecar });
  const events: AdapterEvidenceEvent[] = [];
  adapter.onEvidence((e) => events.push(e));
  return { adapter, events };
}

/** The job's own events, as "type" or "type:sidecarType". */
function of(events: AdapterEvidenceEvent[], jobId: string): string[] {
  return events
    .filter((e) => e.payload.jobId === jobId)
    .map((e) => (typeof e.payload.sidecarType === "string" ? `${e.type}:${e.payload.sidecarType}` : e.type));
}

const op = (jobId: string) => ({ type: "aspirate", deviceId: "dev-one", jobId, timestamp: new Date().toISOString(), payload: { well: "A1" } });
const pause = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("one run per device (astra pack 473 (a))", () => {
  it("a start while a run is in flight is refused before anything reaches the sidecar, and the first run keeps all of its evidence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = heldSidecar();
    const { adapter, events } = await adapterOn(fake.transport);

    const a = adapter.execute({ type: "start", payload: { jobId: "job-A" } });
    await vi.waitFor(() => expect(fake.running("job-A")).toBe(true));
    const pendingB = adapter.execute({ type: "start", payload: { jobId: "job-B" } });
    await pause();
    fake.transport.notify("evidence", op("job-A")); // job A's run goes on
    await pause();
    fake.release("job-A");
    const ra = await a;
    fake.release("job-B"); // a run of job B, had it been let through
    const b = await pendingB;

    expect.soft(b.success, "job B's start").toBe(false);
    expect.soft(b.message ?? "", "why").toMatch(/busy with job job-A/);
    expect.soft(fake.sent.filter((s) => s.includes("job-B")), "requests for job B").toEqual([]);
    expect.soft(ra.success, "job A").toBe(true);
    expect.soft(of(events, "job-A"), "job A's events").toEqual(["execution_started", expect.stringMatching(/:aspirate$/), "execution_completed"]);
    expect.soft(of(events, "job-B"), "job B's events").toEqual([]);

    // Once job A has ended, the device takes a new job.
    const c = adapter.execute({ type: "start", payload: { jobId: "job-C" } });
    await vi.waitFor(() => expect(fake.running("job-C")).toBe(true));
    fake.release("job-C");
    expect.soft((await c).success, "job C, after job A").toBe(true);
  });

  it("two starts in the same tick: only the first reaches the sidecar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = heldSidecar();
    const { adapter, events } = await adapterOn(fake.transport);

    // Both are asked before backend.init has answered, so neither has reached handleStart.
    const a = adapter.execute({ type: "start", payload: { jobId: "job-A" } });
    const b = adapter.execute({ type: "start", payload: { jobId: "job-B" } });
    await vi.waitFor(() => expect(fake.running("job-A")).toBe(true));
    await pause();
    fake.transport.notify("evidence", op("job-A"));
    await pause();
    fake.release("job-A");
    const ra = await a;
    fake.release("job-B"); // a run of job B, had it been let through
    const rb = await b;

    expect.soft(rb.message ?? "", "job B's start").toMatch(/busy with job job-A/);
    expect.soft(fake.sent.filter((s) => s.includes("job-B")), "requests for job B").toEqual([]);
    expect.soft(ra.success, "job A").toBe(true);
    expect.soft(of(events, "job-A"), "job A's events").toEqual(["execution_started", expect.stringMatching(/:aspirate$/), "execution_completed"]);
  });

  it("a start that fails before its run releases the device: the next start is accepted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = heldSidecar("job-A");
    const { adapter } = await adapterOn(fake.transport);

    const ra = await adapter.execute({ type: "start", payload: { jobId: "job-A" } }); // its window is refused
    expect.soft(ra.success, "job A, whose window was refused").toBe(false);
    expect.soft(ra.message ?? "", "why").not.toMatch(/busy/);
  });

  it("a start refused for having no job id holds nothing: the next start is accepted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = heldSidecar();
    const { adapter } = await adapterOn(fake.transport);

    const bare = await adapter.execute({ type: "start", payload: {} });
    const a = adapter.execute({ type: "start", payload: { jobId: "job-A" } });
    await vi.waitFor(() => expect(fake.running("job-A")).toBe(true));
    fake.release("job-A");
    expect.soft(bare.success, "the start with no job id").toBe(false);
    expect.soft((await a).success, "job A, after it").toBe(true);
  });
});
