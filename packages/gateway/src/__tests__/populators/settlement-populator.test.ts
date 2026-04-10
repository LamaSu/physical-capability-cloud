import { describe, it, expect } from "vitest";
import {
  populateEscrowDTO,
  populateEscrowList,
  type RawEscrow,
  type RawMilestone,
} from "../../facades/populators/settlement.populator.js";
import type { PopulationContext } from "../../facades/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let idCounter = 0;

function makeRawEscrow(overrides: Partial<RawEscrow> = {}): RawEscrow {
  return {
    id: `escrow-${++idCounter}`,
    jobId: "job-001",
    status: "active",
    totalAmount: "1000000",
    currency: "USDC",
    challengeWindowEnd: null,
    ...overrides,
  };
}

function makeRawMilestone(escrowId: string, overrides: Partial<RawMilestone> = {}): RawMilestone {
  return {
    id: `milestone-${++idCounter}`,
    escrowId,
    status: "pending",
    ...overrides,
  };
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

// ── populateEscrowDTO ──────────────────────────────────────────────────────

describe("populateEscrowDTO()", () => {
  it("maps id, jobId, status, totalAmount, currency", () => {
    const escrow = makeRawEscrow({
      id: "esc-001",
      jobId: "job-xyz",
      status: "active",
      totalAmount: "5000000",
      currency: "USDC",
    });
    const dto = populateEscrowDTO(escrow, [], makeCtx());
    expect(dto.id).toBe("esc-001");
    expect(dto.jobId).toBe("job-xyz");
    expect(dto.status).toBe("active");
    expect(dto.totalAmount).toBe("5000000");
    expect(dto.currency).toBe("USDC");
  });

  it("milestoneCount = milestones.length", () => {
    const escrow = makeRawEscrow();
    const milestones = [
      makeRawMilestone(escrow.id),
      makeRawMilestone(escrow.id),
      makeRawMilestone(escrow.id),
    ];
    const dto = populateEscrowDTO(escrow, milestones, makeCtx());
    expect(dto.milestoneCount).toBe(3);
  });

  it("releasedCount counts milestones with status=released or completed", () => {
    const escrow = makeRawEscrow();
    const milestones = [
      makeRawMilestone(escrow.id, { status: "released" }),
      makeRawMilestone(escrow.id, { status: "completed" }),
      makeRawMilestone(escrow.id, { status: "pending" }),
      makeRawMilestone(escrow.id, { status: "released" }),
    ];
    const dto = populateEscrowDTO(escrow, milestones, makeCtx());
    expect(dto.releasedCount).toBe(3); // 2 released + 1 completed
  });

  it("disputedCount counts milestones with status=disputed", () => {
    const escrow = makeRawEscrow();
    const milestones = [
      makeRawMilestone(escrow.id, { status: "disputed" }),
      makeRawMilestone(escrow.id, { status: "pending" }),
      makeRawMilestone(escrow.id, { status: "disputed" }),
    ];
    const dto = populateEscrowDTO(escrow, milestones, makeCtx());
    expect(dto.disputedCount).toBe(2);
  });

  it("releasedCount=0 and disputedCount=0 when no milestones", () => {
    const escrow = makeRawEscrow();
    const dto = populateEscrowDTO(escrow, [], makeCtx());
    expect(dto.releasedCount).toBe(0);
    expect(dto.disputedCount).toBe(0);
    expect(dto.milestoneCount).toBe(0);
  });

  it("totalAmount coerced to string", () => {
    const escrow = makeRawEscrow({ totalAmount: 9999999 as any });
    const dto = populateEscrowDTO(escrow, [], makeCtx());
    expect(typeof dto.totalAmount).toBe("string");
    expect(dto.totalAmount).toBe("9999999");
  });

  it("totalAmount defaults to '0' when not present", () => {
    const escrow = makeRawEscrow({ totalAmount: undefined });
    const dto = populateEscrowDTO(escrow, [], makeCtx());
    expect(dto.totalAmount).toBe("0");
  });

  it("currency defaults to ctx.currency when not on escrow", () => {
    const escrow = makeRawEscrow({ currency: undefined });
    const dto = populateEscrowDTO(escrow, [], makeCtx({ currency: "ETH" }));
    expect(dto.currency).toBe("ETH");
  });

  it("currency defaults to USDC when not in ctx either", () => {
    const escrow = makeRawEscrow({ currency: undefined });
    const dto = populateEscrowDTO(escrow, [], makeCtx({ currency: undefined }));
    expect(dto.currency).toBe("USDC");
  });

  it("challengeWindowEnd from escrow", () => {
    const escrow = makeRawEscrow({ challengeWindowEnd: "2026-04-10T00:00:00.000Z" });
    const dto = populateEscrowDTO(escrow, [], makeCtx());
    expect(dto.challengeWindowEnd).toBe("2026-04-10T00:00:00.000Z");
  });

  it("challengeWindowEnd is undefined when null", () => {
    const escrow = makeRawEscrow({ challengeWindowEnd: null });
    const dto = populateEscrowDTO(escrow, [], makeCtx());
    expect(dto.challengeWindowEnd).toBeUndefined();
  });
});

// ── populateEscrowList ─────────────────────────────────────────────────────

describe("populateEscrowList()", () => {
  it("maps each escrow through populateEscrowDTO", () => {
    const escrow1 = makeRawEscrow({ id: "e1", status: "active" });
    const escrow2 = makeRawEscrow({ id: "e2", status: "completed" });
    const milestoneMap = new Map<string, RawMilestone[]>([
      ["e1", [makeRawMilestone("e1", { status: "released" })]],
      ["e2", []],
    ]);
    const dtos = populateEscrowList([escrow1, escrow2], milestoneMap, makeCtx());
    expect(dtos).toHaveLength(2);
    expect(dtos[0].id).toBe("e1");
    expect(dtos[0].releasedCount).toBe(1);
    expect(dtos[1].id).toBe("e2");
    expect(dtos[1].releasedCount).toBe(0);
  });

  it("uses milestoneMap.get(escrow.id) for milestones", () => {
    const escrow = makeRawEscrow({ id: "esc-map" });
    const milestones = [
      makeRawMilestone("esc-map"),
      makeRawMilestone("esc-map"),
    ];
    const milestoneMap = new Map([["esc-map", milestones]]);
    const [dto] = populateEscrowList([escrow], milestoneMap, makeCtx());
    expect(dto.milestoneCount).toBe(2);
  });

  it("handles missing entry in milestoneMap as []", () => {
    const escrow = makeRawEscrow({ id: "esc-no-milestones" });
    const milestoneMap = new Map<string, RawMilestone[]>(); // empty
    const [dto] = populateEscrowList([escrow], milestoneMap, makeCtx());
    expect(dto.milestoneCount).toBe(0);
  });

  it("returns empty array when escrows is empty", () => {
    expect(populateEscrowList([], new Map(), makeCtx())).toEqual([]);
  });
});
