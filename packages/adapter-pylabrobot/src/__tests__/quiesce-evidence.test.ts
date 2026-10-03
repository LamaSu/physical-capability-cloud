/**
 * PyLabRobotAdapter.quiesceEvidence() (#502 round 3b): it resolves at once when nothing is
 * outstanding, and otherwise only once every run or call in flight has returned and every
 * mock completion has been emitted, so the adapter's evidence for that work is all out.
 */

import { describe, expect, it } from "vitest";
import { PyLabRobotAdapter } from "../adapter.js";
import { InMemoryTransport, SidecarClient } from "../sidecar-client.js";
import type { AdapterEvidenceEvent } from "../types.js";

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
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
