import { describe, expect, it } from "vitest";
import { configuredNetworkLabel, parseProductHome, readSection, sectionReason } from "../product-home.js";

function dto(over: Record<string, unknown> = {}) {
  return {
    schemaId: "pcc.product-home/v1",
    asOf: "2026-09-24T12:00:00.000Z",
    kernels: { state: "read", total: 3, online: 1, stale: 1, other: 1, rule: "r", source: "gateway_kernel_rows" },
    capabilities: { state: "read", total: 2, onOnlineKernels: 1, byType: [], source: "gateway_capability_rows" },
    jobs: { state: "read", total: 9, active: 4, byPhase: {}, source: "gateway_job_rows" },
    settlementNetwork: { name: "base-sepolia", chainId: 84532, basis: "gateway_config" },
    escrowHeld: {
      state: "read",
      byCurrency: [{ currency: "USDC", decimals: 6, amountBaseUnits: "5000000", milestones: 1 }],
      uncountedMilestones: 0,
      unclassifiedMilestones: 0,
      excludedSimulatedEscrows: 0,
      heldStatuses: [],
      source: "gateway_escrow_record",
      confirmation: "record_only",
    },
    ...over,
  };
}

describe("parseProductHome: anything that isn't a ProductHomeDTO is a failed read", () => {
  it("accepts a well-formed DTO, including unavailable sections and no configured network", () => {
    const home = parseProductHome(
      dto({ jobs: { state: "unavailable", reason: "job rows could not be read" }, settlementNetwork: { name: null, chainId: null, basis: "gateway_config" } }),
    );
    expect(readSection(home.kernels)?.online).toBe(1);
    expect(readSection(home.jobs)).toBeNull();
    expect(sectionReason(home.jobs)).toBe("job rows could not be read");
    expect(configuredNetworkLabel(home)).toBeUndefined();
  });

  it.each([
    ["another schema", { schemaId: "pcc.product-home/v2" }],
    ["a read section missing a count", { jobs: { state: "read", total: 9, byPhase: {}, source: "gateway_job_rows" } }],
    ["a negative count", { kernels: { state: "read", total: 3, online: -1, stale: 1, other: 1, rule: "r", source: "gateway_kernel_rows" } }],
    ["an unavailable section with no reason", { capabilities: { state: "unavailable" } }],
    ["a decimal display string for a held amount", {
      escrowHeld: { ...dto().escrowHeld, byCurrency: [{ currency: "USDC", decimals: 6, amountBaseUnits: "5.00", milestones: 1 }] },
    }],
    ["no settlement network block", { settlementNetwork: undefined }],
  ])("rejects %s", (_label, over) => {
    expect(() => parseProductHome(dto(over as Record<string, unknown>))).toThrow(/Unexpected response/);
  });

  it("labels the network as configuration, not as where escrow lives", () => {
    expect(configuredNetworkLabel(parseProductHome(dto()))).toBe("base-sepolia (configured)");
  });
});
