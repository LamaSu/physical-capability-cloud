/**
 * Sidecar client tests — exercise the JSON-RPC framing + correlation +
 * notification dispatch + crash + restart paths via InMemoryTransport,
 * with no actual Python subprocess.
 */

import { describe, expect, it, vi } from "vitest";
import {
  InMemoryTransport,
  SidecarClient,
  SidecarError,
} from "../sidecar-client.js";
import { RPC_ERROR_CODES } from "../protocol.js";

describe("SidecarClient (in-memory transport)", () => {
  it("round-trips a successful request", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const callP = client.call("backend.status", { deviceId: "d1" });
    const sent = transport.lastSent()!;
    expect(sent.method).toBe("backend.status");
    expect((sent as { id: string }).id).toBe("1");

    transport.respondSuccess((sent as { id: string }).id, { status: "idle", progress: 0 });
    await expect(callP).resolves.toEqual({ status: "idle", progress: 0 });
    await client.stop();
  });

  it("correlates concurrent requests by id", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const a = client.call("backend.status", { deviceId: "a" });
    const b = client.call("backend.status", { deviceId: "b" });
    expect(transport.sent.length).toBe(2);
    const idA = (JSON.parse(transport.sent[0]!) as { id: string }).id;
    const idB = (JSON.parse(transport.sent[1]!) as { id: string }).id;

    // Out-of-order responses
    transport.respondSuccess(idB, { status: "busy" });
    transport.respondSuccess(idA, { status: "idle" });

    await expect(a).resolves.toEqual({ status: "idle" });
    await expect(b).resolves.toEqual({ status: "busy" });
    await client.stop();
  });

  it("rejects with SidecarError on RPC error response", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const callP = client.call("backend.run", { deviceId: "d1" });
    const id = (transport.lastSent() as { id: string }).id;
    transport.respondError(
      id,
      RPC_ERROR_CODES.NON_RETRYABLE,
      "No tips on deck",
      { plrException: "NoTipError" },
    );

    await expect(callP).rejects.toBeInstanceOf(SidecarError);
    try {
      await callP;
    } catch (err) {
      const e = err as SidecarError;
      expect(e.code).toBe(RPC_ERROR_CODES.NON_RETRYABLE);
      expect(e.message).toBe("No tips on deck");
      expect(e.data).toEqual({ plrException: "NoTipError" });
    }
    await client.stop();
  });

  it("dispatches server-initiated notifications by method", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const calls: Array<Record<string, unknown>> = [];
    client.onNotification("evidence", (params) => {
      calls.push(params);
    });
    transport.notify("evidence", {
      type: "instrument_result",
      deviceId: "d1",
      timestamp: "2026-05-25T00:00:00Z",
      payload: { action: "aspirate", volume_uL: 100 },
    });
    transport.notify("evidence", {
      type: "instrument_result",
      deviceId: "d1",
      timestamp: "2026-05-25T00:00:01Z",
      payload: { action: "dispense", volume_uL: 100 },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.type).toBe("instrument_result");
    expect((calls[1]!.payload as Record<string, unknown>).action).toBe("dispense");
    await client.stop();
  });

  it("times out a slow request", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const callP = client.call("backend.run", { deviceId: "d1" }, 50);
    // never respond
    await expect(callP).rejects.toBeInstanceOf(SidecarError);
    try {
      await callP;
    } catch (err) {
      expect((err as SidecarError).message).toMatch(/timed out/);
    }
    await client.stop();
  });

  it("multiple notification handlers all fire", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const a = vi.fn();
    const b = vi.fn();
    client.onNotification("evidence", a);
    client.onNotification("evidence", b);
    transport.notify("evidence", { type: "log", deviceId: "d1", timestamp: "t", payload: {} });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    await client.stop();
  });

  it("notification unsubscribe removes the handler", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const a = vi.fn();
    const unsubscribe = client.onNotification("evidence", a);
    unsubscribe();
    transport.notify("evidence", { type: "log", deviceId: "d1", timestamp: "t", payload: {} });
    expect(a).not.toHaveBeenCalled();
    await client.stop();
  });

  it("notify (fire-and-forget) does not allocate a pending entry", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();
    client.notify("ping", { hello: "world" });
    expect(transport.sent.length).toBe(1);
    const msg = JSON.parse(transport.sent[0]!) as Record<string, unknown>;
    expect(msg.method).toBe("ping");
    expect("id" in msg).toBe(false);
    await client.stop();
  });

  it("transport close fails in-flight calls with SIDECAR_RESTART code", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();

    const callP = client.call("backend.run", { deviceId: "d1" }, 1000);
    // Simulate the sidecar crashing
    await transport.close();
    await expect(callP).rejects.toBeInstanceOf(SidecarError);
    try {
      await callP;
    } catch (err) {
      expect((err as SidecarError).code).toBe(RPC_ERROR_CODES.SIDECAR_RESTART);
    }
  });

  it("rejects calls if started never called", async () => {
    const client = new SidecarClient();
    await expect(client.call("backend.status")).rejects.toBeInstanceOf(SidecarError);
  });

  it("rejects calls after stop()", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();
    await client.stop();
    await expect(client.call("backend.status")).rejects.toBeInstanceOf(SidecarError);
  });

  it("start() is idempotent (no-op when already running)", async () => {
    const transport = new InMemoryTransport();
    const client = new SidecarClient({ inMemoryTransport: transport });
    await client.start();
    await client.start();
    expect(client.isAlive()).toBe(true);
    await client.stop();
  });
});
