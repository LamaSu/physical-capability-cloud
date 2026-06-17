import { describe, it, expect } from "vitest";
import {
  populateKernelDTO,
  populateKernelHealthSnapshot,
  populateKernelList,
  type RawKernel,
} from "../../facades/populators/kernel.populator.js";
import type { PopulationContext } from "../../facades/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeRawKernel(overrides: Partial<RawKernel> = {}): RawKernel {
  return {
    id: "kernel-001",
    name: "Test Kernel",
    operatorAddress: "0x1234567890123456789012345678901234567890",
    location: { lat: 40.71, lng: -74.0 },
    physicalAddress: "123 Test St",
    maxAssuranceTier: 2,
    publicKey: "0x" + "a".repeat(64),
    reputation: 500,
    totalJobsCompleted: 10,
    status: "online",
    registeredAt: new Date(Date.now() - 86400000).toISOString(),
    lastHeartbeat: new Date().toISOString(), // fresh
    version: "0.1.0",
    ...overrides,
  };
}

function makeStaleKernel(): RawKernel {
  return makeRawKernel({
    status: "online",
    lastHeartbeat: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // 6 min ago
  });
}

function makeCtx(overrides: Partial<PopulationContext> = {}): PopulationContext {
  return {
    currency: "USDC",
    includeReputation: false,
    includeCompliance: false,
    includeHealth: false,
    ...overrides,
  };
}

const mockCapabilities = [
  { id: "cap-001", type: "fdm", kernelId: "kernel-001" },
  { id: "cap-002", type: "cnc", kernelId: "kernel-001" },
];

// ── populateKernelDTO ──────────────────────────────────────────────────────

describe("populateKernelDTO()", () => {
  it("maps all core fields", () => {
    const model = makeRawKernel({
      id: "kern-x",
      name: "X Kernel",
      status: "online",
      version: "0.2.0",
    });
    const dto = populateKernelDTO(model, [], makeCtx());
    expect(dto.id).toBe("kern-x");
    expect(dto.name).toBe("X Kernel");
    expect(dto.status).toBe("online");
    expect(dto.version).toBe("0.2.0");
    expect(dto.operatorAddress).toBe("0x1234567890123456789012345678901234567890");
  });

  it("capabilityCount = capabilities.length", () => {
    const model = makeRawKernel();
    const dto = populateKernelDTO(model, mockCapabilities, makeCtx());
    expect(dto.capabilityCount).toBe(2);
  });

  it("capabilityTypes = capabilities.map(c => c.type)", () => {
    const model = makeRawKernel();
    const dto = populateKernelDTO(model, mockCapabilities, makeCtx());
    expect(dto.capabilityTypes).toEqual(["fdm", "cnc"]);
  });

  it("capabilities field = capabilityTypes (backward-compat alias)", () => {
    const model = makeRawKernel();
    const dto = populateKernelDTO(model, mockCapabilities, makeCtx());
    expect(dto.capabilities).toEqual(dto.capabilityTypes);
  });

  it("isStale=false when status=offline regardless of heartbeat age", () => {
    const model = makeRawKernel({
      status: "offline",
      lastHeartbeat: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    });
    const dto = populateKernelDTO(model, [], makeCtx());
    expect(dto.isStale).toBe(false);
  });

  it("isStale=true when online + heartbeat > 5min ago and NO active listing", () => {
    // No listing → bare 5-minute threshold applies.
    const model = makeStaleKernel();
    const dto = populateKernelDTO(model, [], makeCtx());
    expect(dto.isStale).toBe(true);
  });

  it("isStale=false when online + heartbeat > 5min ago BUT kernel has an active listing", () => {
    // Bug fix: a listed kernel stays available without periodic heartbeats.
    const model = makeRawKernel({
      status: "online",
      lastHeartbeat: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    });
    const dto = populateKernelDTO(model, mockCapabilities, makeCtx());
    expect(dto.isStale).toBe(false);
  });

  it("isStale=true when a listed kernel's heartbeat exceeds the 24h keepalive grace", () => {
    // The grace is finite — a long-dead listed kernel is still flagged.
    const model = makeRawKernel({
      status: "online",
      lastHeartbeat: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
    });
    const dto = populateKernelDTO(model, mockCapabilities, makeCtx());
    expect(dto.isStale).toBe(true);
  });

  it("isStale=false when status=online and heartbeat recent", () => {
    const model = makeRawKernel({
      status: "online",
      lastHeartbeat: new Date().toISOString(),
    });
    const dto = populateKernelDTO(model, [], makeCtx());
    expect(dto.isStale).toBe(false);
  });

  it("reputation from reputationCache when includeReputation=true", () => {
    const model = makeRawKernel({ reputation: 500 });
    const reputationCache = new Map([["kernel-001", 900]]);
    const dto = populateKernelDTO(model, [], makeCtx({ includeReputation: true, reputationCache }));
    expect(dto.reputation).toBe(900);
  });

  it("reputation = model.reputation when includeReputation=false", () => {
    const model = makeRawKernel({ reputation: 750 });
    const dto = populateKernelDTO(model, [], makeCtx({ includeReputation: false }));
    expect(dto.reputation).toBe(750);
  });

  it("activeJobCount from param", () => {
    const model = makeRawKernel();
    const dto = populateKernelDTO(model, [], makeCtx(), 5);
    expect(dto.activeJobCount).toBe(5);
  });

  it("activeJobCount defaults to 0", () => {
    const model = makeRawKernel();
    const dto = populateKernelDTO(model, [], makeCtx());
    expect(dto.activeJobCount).toBe(0);
  });

  it("totalJobsCompleted from model", () => {
    const model = makeRawKernel({ totalJobsCompleted: 42 });
    const dto = populateKernelDTO(model, [], makeCtx());
    expect(dto.totalJobsCompleted).toBe(42);
  });
});

// ── populateKernelHealthSnapshot ───────────────────────────────────────────

describe("populateKernelHealthSnapshot()", () => {
  it("extends KernelDTO with devices and recentJobs", () => {
    const model = makeRawKernel();
    const snapshot = populateKernelHealthSnapshot(model, [], [], [], makeCtx());
    expect(Array.isArray(snapshot.devices)).toBe(true);
    expect(Array.isArray(snapshot.recentJobs)).toBe(true);
    // Has all KernelDTO fields
    expect(typeof snapshot.id).toBe("string");
    expect(typeof snapshot.capabilityCount).toBe("number");
  });

  it("devices are DeviceStatusDTOs", () => {
    const model = makeRawKernel();
    const rawDevices = [
      {
        id: "dev-001",
        type: "printer",
        model: "Prusa MK3S",
        status: "online",
        healthStatus: "good",
        adapterType: "octoprint",
        capabilities: ["fdm"],
      },
    ];
    const snapshot = populateKernelHealthSnapshot(model, [], rawDevices, [], makeCtx());
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0].id).toBe("dev-001");
    expect(snapshot.devices[0].type).toBe("printer");
    expect(snapshot.devices[0].status).toBe("online");
    expect(snapshot.devices[0].healthStatus).toBe("good");
  });

  it("uptimePercent=100 when online", () => {
    const model = makeRawKernel({ status: "online" });
    const snapshot = populateKernelHealthSnapshot(model, [], [], [], makeCtx());
    expect(snapshot.uptimePercent).toBe(100);
  });

  it("uptimePercent=0 when offline", () => {
    const model = makeRawKernel({ status: "offline" });
    const snapshot = populateKernelHealthSnapshot(model, [], [], [], makeCtx());
    expect(snapshot.uptimePercent).toBe(0);
  });

  it("uptimePercent=50 when maintenance", () => {
    const model = makeRawKernel({ status: "maintenance" });
    const snapshot = populateKernelHealthSnapshot(model, [], [], [], makeCtx());
    expect(snapshot.uptimePercent).toBe(50);
  });

  it("device status defaults to offline when null", () => {
    const model = makeRawKernel();
    const rawDevices = [
      { id: "dev-002", type: "sensor", status: null, healthStatus: null },
    ];
    const snapshot = populateKernelHealthSnapshot(model, [], rawDevices, [], makeCtx());
    expect(snapshot.devices[0].status).toBe("offline");
  });

  it("device healthStatus defaults to unknown when null", () => {
    const model = makeRawKernel();
    const rawDevices = [
      { id: "dev-003", type: "sensor", status: null, healthStatus: null },
    ];
    const snapshot = populateKernelHealthSnapshot(model, [], rawDevices, [], makeCtx());
    expect(snapshot.devices[0].healthStatus).toBe("unknown");
  });

  it("recentJobs contains job DTOs with the kernel's id", () => {
    const model = makeRawKernel({ id: "kern-abc" });
    const recentJobs = [
      {
        id: "job-r1",
        capabilityId: "cap-001",
        kernelId: "kern-abc",
        status: "completed",
        progress: 100,
        startedAt: "2026-01-01T10:00:00.000Z",
        completedAt: "2026-01-01T12:00:00.000Z",
      },
    ];
    const snapshot = populateKernelHealthSnapshot(model, [], [], recentJobs, makeCtx());
    expect(snapshot.recentJobs).toHaveLength(1);
    expect(snapshot.recentJobs[0].id).toBe("job-r1");
    expect(snapshot.recentJobs[0].kernelId).toBe("kern-abc");
  });
});

// ── populateKernelList ─────────────────────────────────────────────────────

describe("populateKernelList()", () => {
  it("maps each kernel through populateKernelDTO", () => {
    const models = [
      makeRawKernel({ id: "k1", name: "Kernel 1" }),
      makeRawKernel({ id: "k2", name: "Kernel 2" }),
    ];
    const capMap = new Map<string, any[]>([
      ["k1", [{ id: "cap-1", type: "fdm", kernelId: "k1" }]],
      ["k2", []],
    ]);
    const dtos = populateKernelList(models, capMap, makeCtx());
    expect(dtos).toHaveLength(2);
    expect(dtos[0].name).toBe("Kernel 1");
    expect(dtos[0].capabilityCount).toBe(1);
    expect(dtos[1].capabilityCount).toBe(0);
  });

  it("uses capabilityMap.get(model.id) for capabilities", () => {
    const model = makeRawKernel({ id: "kern-list" });
    const capMap = new Map([["kern-list", [{ id: "c1", type: "cnc", kernelId: "kern-list" }]]]);
    const [dto] = populateKernelList([model], capMap, makeCtx());
    expect(dto.capabilityTypes).toContain("cnc");
  });

  it("handles missing entry in capabilityMap as empty array", () => {
    const model = makeRawKernel({ id: "kern-no-caps" });
    const capMap = new Map<string, any[]>(); // empty map
    const [dto] = populateKernelList([model], capMap, makeCtx());
    expect(dto.capabilityCount).toBe(0);
    expect(dto.capabilityTypes).toEqual([]);
  });

  it("returns empty array when models is empty", () => {
    const dtos = populateKernelList([], new Map(), makeCtx());
    expect(dtos).toEqual([]);
  });
});
