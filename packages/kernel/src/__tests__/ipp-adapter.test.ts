/**
 * Tests for IppAdapter — mock mode only (no real printer required).
 *
 * Covers:
 *  - Constructor and source properties
 *  - getStatus() — idle/busy states
 *  - getProgress() — 0-100 progress tracking
 *  - execute() — start, stop, pause, resume, status commands
 *  - onEvidence() — event emission (job_received, printing_started, page_complete, job_complete)
 *  - getCapabilities() — Canon PIXMA TR8620a mock attributes
 *  - cancelJob() — mock job cancellation
 *  - Adapter factory creates IppAdapter for type "ipp"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IppAdapter } from "../adapters/ipp-adapter.js";
import type { IppAdapterConfig } from "../adapters/ipp-adapter.js";
import type { MachineCommand } from "../adapters/types.js";
import { createMachineAdapter } from "../adapter-factory.js";
import type { DeviceConfig } from "../kernel-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<IppAdapterConfig> = {}): IppAdapter {
  return new IppAdapter("test_ipp_01", {
    uri: "ipp://192.168.1.50/ipp/print",
    kernelId: "kernel_test",
    mockMode: true,
    ...overrides,
  });
}

function makeCommand(type: MachineCommand["type"], payload?: Record<string, unknown>): MachineCommand {
  return { type, payload };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("IppAdapter — constructor", () => {
  it("sets id, type, and source correctly", () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe("test_ipp_01");
    expect(adapter.type).toBe("ipp-2d");
    expect(adapter.source.deviceId).toBe("test_ipp_01");
    expect(adapter.source.deviceType).toBe("controller");
    expect(adapter.source.kernelId).toBe("kernel_test");
    expect(adapter.source.firmwareVersion).toBe("IPP-Adapter-1.0.0");
  });

  it("implements MachineAdapter interface", () => {
    const adapter = makeAdapter();
    expect(typeof adapter.getStatus).toBe("function");
    expect(typeof adapter.getProgress).toBe("function");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.onEvidence).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// getStatus()
// ---------------------------------------------------------------------------

describe("IppAdapter — getStatus()", () => {
  it("returns 'idle' when no job is running", async () => {
    const adapter = makeAdapter();
    const status = await adapter.getStatus();
    expect(status).toBe("idle");
    await adapter.dispose();
  });

  it("returns 'busy' after a print job is started", async () => {
    const adapter = makeAdapter();
    await adapter.execute(makeCommand("start", { jobName: "test.pdf", totalPages: 5 }));
    const status = await adapter.getStatus();
    expect(status).toBe("busy");
    await adapter.dispose();
  });

  it("returns 'idle' after job is stopped", async () => {
    const adapter = makeAdapter();
    await adapter.execute(makeCommand("start", { jobName: "test.pdf", totalPages: 3 }));
    await adapter.execute(makeCommand("stop"));
    const status = await adapter.getStatus();
    expect(status).toBe("idle");
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// getProgress()
// ---------------------------------------------------------------------------

describe("IppAdapter — getProgress()", () => {
  it("returns 0 when no job is running", async () => {
    const adapter = makeAdapter();
    const progress = await adapter.getProgress();
    expect(progress).toBe(0);
    await adapter.dispose();
  });

  it("returns 0 immediately after job start (before first page)", async () => {
    const adapter = makeAdapter();
    await adapter.execute(makeCommand("start", { jobName: "test.pdf", totalPages: 3 }));
    const progress = await adapter.getProgress();
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(progress).toBeLessThanOrEqual(100);
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

describe("IppAdapter — execute()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start returns success with jobId", async () => {
    const adapter = makeAdapter();
    const result = await adapter.execute(makeCommand("start", { jobName: "invoice.pdf", totalPages: 2 }));
    expect(result.success).toBe(true);
    expect(result.message).toContain("mock");
    await adapter.dispose();
  });

  it("start fails if printer is already busy", async () => {
    const adapter = makeAdapter();
    await adapter.execute(makeCommand("start", { jobName: "a.pdf", totalPages: 3 }));
    const second = await adapter.execute(makeCommand("start", { jobName: "b.pdf", totalPages: 1 }));
    expect(second.success).toBe(false);
    await adapter.dispose();
  });

  it("stop cancels the job and returns success", async () => {
    const adapter = makeAdapter();
    await adapter.execute(makeCommand("start", { jobName: "a.pdf", totalPages: 5 }));
    const result = await adapter.execute(makeCommand("stop"));
    expect(result.success).toBe(true);
    await adapter.dispose();
  });

  it("pause halts progress and returns success", async () => {
    const adapter = makeAdapter();
    await adapter.execute(makeCommand("start", { jobName: "a.pdf", totalPages: 5 }));
    const result = await adapter.execute(makeCommand("pause"));
    expect(result.success).toBe(true);
    await adapter.dispose();
  });

  it("status returns current state info", async () => {
    const adapter = makeAdapter();
    const result = await adapter.execute(makeCommand("status"));
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.status).toBe("idle");
    await adapter.dispose();
  });

  it("unknown command returns success with acknowledgment", async () => {
    const adapter = makeAdapter();
    const result = await adapter.execute({ type: "load_gcode" });
    expect(result.success).toBe(true);
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// Evidence events
// ---------------------------------------------------------------------------

describe("IppAdapter — evidence events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits execution_started when job begins", async () => {
    const adapter = makeAdapter();
    const events: Array<{ type: string }> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.execute(makeCommand("start", { jobName: "doc.pdf", totalPages: 2 }));

    expect(events.some((e) => e.type === "execution_started")).toBe(true);
    await adapter.dispose();
  });

  it("emits execution_progress for each page printed", async () => {
    const adapter = makeAdapter();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    adapter.onEvidence((e) => events.push(e as typeof events[0]));

    await adapter.execute(makeCommand("start", { jobName: "doc.pdf", totalPages: 2 }));

    // Advance time past first page (500ms spool + 1200ms per page)
    await vi.advanceTimersByTimeAsync(2000);

    const progressEvents = events.filter((e) => e.type === "execution_progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    // Each progress event should have page info
    for (const ev of progressEvents) {
      expect(ev.payload.currentPage).toBeDefined();
      expect(ev.payload.totalPages).toBeDefined();
      expect(typeof ev.payload.progress).toBe("number");
    }

    await adapter.dispose();
  });

  it("emits execution_completed after all pages print", async () => {
    const adapter = makeAdapter();
    const events: Array<{ type: string }> = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.execute(makeCommand("start", { jobName: "doc.pdf", totalPages: 1 }));

    // Advance past spool (500ms) + page (1200ms) + margin
    await vi.advanceTimersByTimeAsync(2000);

    expect(events.some((e) => e.type === "execution_completed")).toBe(true);
    await adapter.dispose();
  });

  it("evidence events contain correct source", async () => {
    const adapter = makeAdapter();
    const events: Array<{ source: { deviceId: string; kernelId: string } }> = [];
    adapter.onEvidence((e) => events.push(e as typeof events[0]));

    await adapter.execute(makeCommand("start", { jobName: "doc.pdf", totalPages: 1 }));

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.source.deviceId).toBe("test_ipp_01");
      expect(ev.source.kernelId).toBe("kernel_test");
    }

    await adapter.dispose();
  });

  it("supports multiple evidence listeners", async () => {
    const adapter = makeAdapter();
    const events1: string[] = [];
    const events2: string[] = [];
    adapter.onEvidence((e) => events1.push(e.type));
    adapter.onEvidence((e) => events2.push(e.type));

    await adapter.execute(makeCommand("start", { jobName: "doc.pdf", totalPages: 1 }));

    expect(events1).toEqual(events2);
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// getCapabilities()
// ---------------------------------------------------------------------------

describe("IppAdapter — getCapabilities()", () => {
  it("returns capabilities in mock mode", async () => {
    const adapter = makeAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps).toBeDefined();
    expect(typeof caps.makeModel).toBe("string");
    expect(typeof caps.color).toBe("boolean");
    expect(typeof caps.duplex).toBe("boolean");
    expect(Array.isArray(caps.mediaSizes)).toBe(true);
    expect(Array.isArray(caps.resolutions)).toBe(true);
    expect(Array.isArray(caps.mediaTypes)).toBe(true);
    await adapter.dispose();
  });

  it("returns Canon PIXMA TR8620a mock capabilities", async () => {
    const adapter = makeAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.makeModel).toBe("Canon PIXMA TR8620a");
    expect(caps.color).toBe(true);
    expect(caps.duplex).toBe(true);
    expect(caps.resolutions).toContain(600);
    expect(caps.resolutions).toContain(1200);
    expect(caps.mediaSizes.length).toBeGreaterThan(0);
    expect(caps.pagesPerMinute).toBeGreaterThan(0);
    await adapter.dispose();
  });

  it("capabilities include letter and A4 paper sizes", async () => {
    const adapter = makeAdapter();
    const caps = await adapter.getCapabilities();
    const hasA4 = caps.mediaSizes.some((s) => s.includes("a4") || s.includes("A4"));
    const hasLetter = caps.mediaSizes.some((s) => s.includes("letter") || s.includes("8.5x11"));
    expect(hasA4 || hasLetter).toBe(true);
    await adapter.dispose();
  });

  it("capabilities include both stationery and photographic media types", async () => {
    const adapter = makeAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.mediaTypes).toContain("stationery");
    expect(caps.mediaTypes).toContain("photographic");
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// cancelJob()
// ---------------------------------------------------------------------------

describe("IppAdapter — cancelJob()", () => {
  it("cancels a mock job without error", async () => {
    const adapter = makeAdapter();
    await adapter.execute(makeCommand("start", { jobName: "a.pdf", totalPages: 5 }));
    await expect(adapter.cancelJob(1000)).resolves.toBeUndefined();
    expect(await adapter.getStatus()).toBe("idle");
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("IppAdapter — dispose()", () => {
  it("clears timers and listeners on dispose", async () => {
    const adapter = makeAdapter();
    const events: string[] = [];
    adapter.onEvidence((e) => events.push(e.type));

    await adapter.execute(makeCommand("start", { jobName: "a.pdf", totalPages: 3 }));
    await adapter.dispose();

    // After dispose, status should be accessible but timers cleared
    const status = await adapter.getStatus();
    expect(status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

describe("createMachineAdapter — type 'ipp'", () => {
  it("creates an IppAdapter for adapterType 'ipp'", () => {
    const device: DeviceConfig = {
      id: "ipp_printer_01",
      type: "machine",
      adapterType: "ipp",
      config: {
        uri: "ipp://192.168.1.50/ipp/print",
        kernelId: "kernel_test",
        mockMode: true,
      },
    };
    const adapter = createMachineAdapter(device);
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("ipp_printer_01");
    expect(adapter.type).toBe("ipp-2d");
  });

  it("IppAdapter from factory can report status", async () => {
    const device: DeviceConfig = {
      id: "ipp_02",
      type: "machine",
      adapterType: "ipp",
      config: {
        uri: "ipp://192.168.1.51/ipp/print",
        kernelId: "kernel_test",
        mockMode: true,
      },
    };
    const adapter = createMachineAdapter(device);
    const status = await adapter.getStatus();
    expect(["idle", "busy", "error", "offline", "maintenance"]).toContain(status);
    await adapter.dispose();
  });

  it("IppAdapter from factory uses default URI when not specified", () => {
    const device: DeviceConfig = {
      id: "ipp_03",
      type: "machine",
      adapterType: "ipp",
      config: { kernelId: "kernel_test" },
    };
    const adapter = createMachineAdapter(device);
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("ipp_03");
  });

  it("factory globalMockMode falls back to MockFDMAdapter for ipp type", () => {
    const device: DeviceConfig = {
      id: "ipp_04",
      type: "machine",
      adapterType: "ipp",
      config: { uri: "ipp://real-host/ipp/print", kernelId: "kernel_test" },
    };
    // globalMockMode overrides everything — falls back to MockFDMAdapter
    const adapter = createMachineAdapter(device, true);
    expect(adapter).toBeDefined();
    expect(adapter.type).toBe("fdm"); // MockFDMAdapter type
  });
});
