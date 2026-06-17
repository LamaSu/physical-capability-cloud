import { describe, it, expect } from "vitest";
import {
  populateCapabilityDTO,
  populateCapabilityList,
} from "../../facades/populators/capability.populator.js";
import type { Capability, ShopKernel } from "@pcc/spec";
import type { PopulationContext } from "../../facades/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let idCounter = 0;

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  const id = `cap-${++idCounter}`;
  return {
    id,
    kernelId: "kernel-001",
    type: "fdm",
    name: "FDM 3D Printing",
    description: "Fused Deposition Modeling",
    materials: ["pla", "abs"],
    assuranceTiers: [0, 1],
    queueDepth: 0,
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    location: { lat: 40.71, lng: -74.0 },
    availability: {},
    tags: [],
    ...overrides,
  } as unknown as Capability;
}

function makeKernel(overrides: Partial<ShopKernel> = {}): ShopKernel {
  return {
    id: "kernel-001",
    name: "Test Kernel",
    operatorAddress: "0x1234567890123456789012345678901234567890",
    location: { lat: 40.71, lng: -74.0 },
    physicalAddress: "123 Test St",
    maxAssuranceTier: 2,
    publicKey: "0x" + "a".repeat(64),
    reputation: 700,
    totalJobsCompleted: 10,
    status: "online",
    registeredAt: new Date(Date.now() - 86400000).toISOString(),
    lastHeartbeat: new Date().toISOString(), // fresh
    version: "0.1.0",
    capabilities: [],
    ...overrides,
  } as unknown as ShopKernel;
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

// ── populateCapabilityDTO ──────────────────────────────────────────────────

describe("populateCapabilityDTO()", () => {
  it("maps all core fields from the model", () => {
    const model = makeCapability({ id: "cap-core", type: "cnc", name: "CNC Mill" });
    const dto = populateCapabilityDTO(model, undefined, makeCtx());
    expect(dto.id).toBe("cap-core");
    expect(dto.type).toBe("cnc");
    expect(dto.name).toBe("CNC Mill");
    expect(dto.kernelId).toBe("kernel-001");
    expect(dto.materials).toEqual(["pla", "abs"]);
    expect(dto.assuranceTiers).toEqual([0, 1]);
  });

  it("available=true when kernel.status=online and queueDepth < 10", () => {
    const kernel = makeKernel({ status: "online" });
    const model = makeCapability({ queueDepth: 3 });
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.available).toBe(true);
  });

  it("available=false when kernel.status=offline", () => {
    const kernel = makeKernel({ status: "offline" });
    const model = makeCapability({ queueDepth: 0 });
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.available).toBe(false);
  });

  it("available=false when queueDepth >= 10", () => {
    const kernel = makeKernel({ status: "online" });
    const model = makeCapability({ queueDepth: 10 });
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.available).toBe(false);
  });

  it("active listing stays available past the 5-minute threshold (keepalive grace)", () => {
    // Bug fix: a kernel with an active listing must NOT silently drop to
    // unavailable just because it has not sent a heartbeat in the last 5 min.
    // The capability being populated is itself an active listing.
    const kernel = makeKernel({
      status: "online",
      lastHeartbeat: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    });
    const model = makeCapability({ queueDepth: 0 });
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.kernelStatus).toBe("online");
    expect(dto.available).toBe(true);
  });

  it("kernelStatus='stale' once the heartbeat exceeds the 24h keepalive grace", () => {
    // The grace is generous but finite — a long-dead listed kernel is still flagged.
    const kernel = makeKernel({
      status: "online",
      lastHeartbeat: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
    });
    const model = makeCapability();
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.kernelStatus).toBe("stale");
    expect(dto.available).toBe(false); // stale ≠ online
  });

  it("kernelStatus=kernel.status when not stale", () => {
    const kernel = makeKernel({ status: "maintenance" });
    const model = makeCapability();
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.kernelStatus).toBe("maintenance");
  });

  it("kernelStatus='online' for fresh online kernel", () => {
    const kernel = makeKernel({ status: "online" });
    const model = makeCapability();
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.kernelStatus).toBe("online");
  });

  it("reputation populated from reputationCache when includeReputation=true", () => {
    const kernel = makeKernel({ reputation: 700 });
    const model = makeCapability({ kernelId: "kernel-001" });
    const reputationCache = new Map([["kernel-001", 900]]);
    const dto = populateCapabilityDTO(model, kernel, makeCtx({ includeReputation: true, reputationCache }));
    expect(dto.reputation).toBe(900);
  });

  it("reputation falls back to kernel.reputation when not in cache", () => {
    const kernel = makeKernel({ reputation: 600 });
    const model = makeCapability({ kernelId: "kernel-001" });
    const dto = populateCapabilityDTO(model, kernel, makeCtx({ includeReputation: true, reputationCache: new Map() }));
    expect(dto.reputation).toBe(600);
  });

  it("reputation=undefined when includeReputation=false", () => {
    const kernel = makeKernel({ reputation: 800 });
    const model = makeCapability();
    const dto = populateCapabilityDTO(model, kernel, makeCtx({ includeReputation: false }));
    expect(dto.reputation).toBeUndefined();
  });

  it("estimatedWaitMinutes = queueDepth * 15", () => {
    const kernel = makeKernel();
    const model = makeCapability({ queueDepth: 4 });
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.estimatedWaitMinutes).toBe(60);
  });

  it("estimatedWaitMinutes = 0 when queueDepth = 0", () => {
    const kernel = makeKernel();
    const model = makeCapability({ queueDepth: 0 });
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.estimatedWaitMinutes).toBe(0);
  });

  it("kernelName from kernel.name", () => {
    const kernel = makeKernel({ name: "Brooklyn Lab" });
    const model = makeCapability();
    const dto = populateCapabilityDTO(model, kernel, makeCtx());
    expect(dto.kernelName).toBe("Brooklyn Lab");
  });

  it("kernelName=undefined when kernel=undefined", () => {
    const model = makeCapability();
    const dto = populateCapabilityDTO(model, undefined, makeCtx());
    expect(dto.kernelName).toBeUndefined();
  });

  it("kernelStatus=undefined when kernel=undefined", () => {
    const model = makeCapability();
    const dto = populateCapabilityDTO(model, undefined, makeCtx());
    expect(dto.kernelStatus).toBeUndefined();
  });

  it("available=false when kernel=undefined", () => {
    // No kernel → kernelStatus=undefined → not 'online'
    const model = makeCapability({ queueDepth: 0 });
    const dto = populateCapabilityDTO(model, undefined, makeCtx());
    expect(dto.available).toBe(false);
  });
});

// ── populateCapabilityList ─────────────────────────────────────────────────

describe("populateCapabilityList()", () => {
  it("maps each model through populateCapabilityDTO", () => {
    const models = [
      makeCapability({ kernelId: "kernel-A", type: "fdm" }),
      makeCapability({ kernelId: "kernel-B", type: "cnc" }),
    ];
    const kernelA = makeKernel({ id: "kernel-A", name: "Lab A" });
    const kernelB = makeKernel({ id: "kernel-B", name: "Lab B" });
    const kernelMap = new Map([
      ["kernel-A", kernelA],
      ["kernel-B", kernelB],
    ]);
    const dtos = populateCapabilityList(models, kernelMap, makeCtx());
    expect(dtos).toHaveLength(2);
    expect(dtos[0].kernelName).toBe("Lab A");
    expect(dtos[1].kernelName).toBe("Lab B");
  });

  it("picks kernel from kernelMap by model.kernelId", () => {
    const model = makeCapability({ kernelId: "kernel-X" });
    const kernel = makeKernel({ id: "kernel-X", name: "X Lab" });
    const kernelMap = new Map([["kernel-X", kernel]]);
    const [dto] = populateCapabilityList([model], kernelMap, makeCtx());
    expect(dto.kernelName).toBe("X Lab");
  });

  it("handles missing kernel gracefully (undefined)", () => {
    const model = makeCapability({ kernelId: "kernel-MISSING" });
    const kernelMap = new Map<string, ShopKernel>(); // no kernel for this id
    const [dto] = populateCapabilityList([model], kernelMap, makeCtx());
    expect(dto.kernelName).toBeUndefined();
    expect(dto.kernelStatus).toBeUndefined();
    expect(dto.available).toBe(false);
  });

  it("returns empty array when models is empty", () => {
    const dtos = populateCapabilityList([], new Map(), makeCtx());
    expect(dtos).toEqual([]);
  });
});
