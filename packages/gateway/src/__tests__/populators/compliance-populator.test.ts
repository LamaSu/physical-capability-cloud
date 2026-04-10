import { describe, it, expect } from "vitest";
import {
  populateEvidenceSummaryDTO,
  populateEvidenceList,
  type RawEvidenceBundle,
} from "../../facades/populators/compliance.populator.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let bundleCounter = 0;

function makeRawBundle(overrides: Partial<RawEvidenceBundle> = {}): RawEvidenceBundle {
  const id = `bundle-${++bundleCounter}`;
  return {
    id,
    jobId: "job-001",
    stepId: "step-001",
    kernelId: "kernel-001",
    assuranceTier: 0,
    bundleHash: "b".repeat(64),
    createdAt: new Date().toISOString(),
    kernelSignature: {
      signer: "0x1111111111111111111111111111111111111111",
      algorithm: "secp256k1",
      value: "mock_sig",
    },
    events: [],
    verified: false,
    ...overrides,
  };
}

// ── populateEvidenceSummaryDTO ─────────────────────────────────────────────

describe("populateEvidenceSummaryDTO()", () => {
  it("maps id, jobId, stepId, assuranceTier, bundleHash, createdAt", () => {
    const createdAt = "2026-01-15T10:00:00.000Z";
    const bundle = makeRawBundle({
      id: "bun-001",
      jobId: "job-001",
      stepId: "step-a",
      assuranceTier: 2,
      bundleHash: "c".repeat(64),
      createdAt,
    });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.id).toBe("bun-001");
    expect(dto.jobId).toBe("job-001");
    expect(dto.stepId).toBe("step-a");
    expect(dto.assuranceTier).toBe(2);
    expect(dto.bundleHash).toBe("c".repeat(64));
    expect(dto.createdAt).toBe(createdAt);
  });

  it("eventCount = bundle.events.length when events is an array", () => {
    const bundle = makeRawBundle({ events: [{}, {}, {}] });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.eventCount).toBe(3);
  });

  it("eventCount = 0 when bundle.events is undefined", () => {
    const bundle = makeRawBundle({ events: undefined });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.eventCount).toBe(0);
  });

  it("eventCount = 0 when bundle.events is empty array", () => {
    const bundle = makeRawBundle({ events: [] });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.eventCount).toBe(0);
  });

  it("verified defaults to false when not on bundle", () => {
    const bundle = makeRawBundle({ verified: undefined });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.verified).toBe(false);
  });

  it("verified is true when bundle.verified=true", () => {
    const bundle = makeRawBundle({ verified: true });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.verified).toBe(true);
  });

  it("storageCid from bundle or undefined", () => {
    const bundleWithCid = makeRawBundle({ storageCid: "bafybeiabc123" });
    expect(populateEvidenceSummaryDTO(bundleWithCid).storageCid).toBe("bafybeiabc123");

    const bundleWithoutCid = makeRawBundle({ storageCid: undefined });
    expect(populateEvidenceSummaryDTO(bundleWithoutCid).storageCid).toBeUndefined();
  });

  it("bundleHash defaults to '' when not on bundle", () => {
    const bundle = makeRawBundle({ bundleHash: undefined });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.bundleHash).toBe("");
  });

  it("createdAt defaults to current ISO string when not on bundle", () => {
    const before = Date.now();
    const bundle = makeRawBundle({ createdAt: undefined });
    const dto = populateEvidenceSummaryDTO(bundle);
    const after = Date.now();
    const ts = new Date(dto.createdAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it("assuranceTier defaults to 0 when not on bundle", () => {
    const bundle = makeRawBundle({ assuranceTier: undefined });
    const dto = populateEvidenceSummaryDTO(bundle);
    expect(dto.assuranceTier).toBe(0);
  });
});

// ── populateEvidenceList ───────────────────────────────────────────────────

describe("populateEvidenceList()", () => {
  it("maps each bundle through populateEvidenceSummaryDTO", () => {
    const bundles = [
      makeRawBundle({ id: "bun-A" }),
      makeRawBundle({ id: "bun-B" }),
    ];
    const dtos = populateEvidenceList(bundles);
    expect(dtos).toHaveLength(2);
    const ids = dtos.map((d) => d.id);
    expect(ids).toContain("bun-A");
    expect(ids).toContain("bun-B");
  });

  it("sorts most recent first by createdAt", () => {
    const older = makeRawBundle({ createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeRawBundle({ createdAt: "2026-03-01T00:00:00.000Z" });
    const dtos = populateEvidenceList([older, newer]);
    expect(dtos[0].createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(dtos[1].createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("handles empty array", () => {
    expect(populateEvidenceList([])).toEqual([]);
  });

  it("single item is returned as-is (no sort error)", () => {
    const bundle = makeRawBundle();
    const dtos = populateEvidenceList([bundle]);
    expect(dtos).toHaveLength(1);
  });
});
