import { describe, it, expect } from "vitest";
import { ROLE_TAGS, buildPayoutMap, type Payout } from "../index.js";
// Direct import from @pcc/spec to verify @pcc/contracts re-exports the
// SAME map (single-source-of-truth invariant).
import { ROLE_TAGS as SPEC_ROLE_TAGS } from "@pcc/spec";

describe("ROLE_TAGS", () => {
  it("is the same object re-exported from @pcc/spec (single source of truth)", () => {
    // Identity check — re-export must point at the spec map, not a copy.
    expect(ROLE_TAGS).toBe(SPEC_ROLE_TAGS);
  });

  it("exposes all 11 ContributorRole tags", () => {
    const expected = [
      "operator",
      "verifier",
      "insurer",
      "integrator",
      "protocol-author",
      "model-author",
      "dataset-contributor",
      "backend-author",
      "curator",
      "assembler",
      "network-treasury",
    ] as const;
    for (const role of expected) {
      expect(ROLE_TAGS).toHaveProperty(role);
    }
    expect(Object.keys(ROLE_TAGS)).toHaveLength(expected.length);
  });

  it("each tag is a 0x-prefixed 32-byte hex (keccak256 output)", () => {
    for (const tag of Object.values(ROLE_TAGS)) {
      // 0x + 64 hex chars = 66 length
      expect(tag).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
  });

  it("operator tag matches keccak256('operator') reference value", () => {
    // Pinned reference: keccak256(utf8('operator')) computed via cast/foundry.
    // If this assertion ever changes, it's a breaking on-chain compatibility
    // event — every deployed payout map referencing this tag would need
    // re-keying. Pin it tightly.
    expect(ROLE_TAGS.operator).toBe(
      "0x46a52cf33029de9f84853745a87af28464c80bf0346df1b32e205fc73319f622",
    );
  });

  it("integrator tag matches keccak256('integrator') reference value", () => {
    expect(ROLE_TAGS.integrator).toBe(
      "0x7fca04c084f97ed662fee1aeb0c969285c1557298812941e9d0396b1dc9b7b25",
    );
  });

  it("model-author tag matches keccak256('model-author') reference value", () => {
    expect(ROLE_TAGS["model-author"]).toBe(
      "0xa61eb7616be58c63a0e71aba4b17c674cafbfb620390674cee37039ab87937e5",
    );
  });

  it("all tags are unique", () => {
    const tags = Object.values(ROLE_TAGS);
    const unique = new Set(tags);
    expect(unique.size).toBe(tags.length);
  });
});

describe("buildPayoutMap (no manifest)", () => {
  it("returns empty payouts + 10000 bps to operator when no manifest is supplied", () => {
    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 100_000_000n, // 100 USDC
      capabilityIpId:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(result.payouts).toEqual([]);
    expect(result.operatorResidualBps).toBe(10000);
    expect(result.breakdown).toEqual([]);
  });
});

describe("Payout type shape", () => {
  it("accepts a properly-shaped object as a Payout literal", () => {
    // Type-level assertion: this should compile.
    const p: Payout = {
      recipient: "0x0000000000000000000000000000000000000001",
      bps: 2000n,
      roleTag: ROLE_TAGS.integrator,
      ipId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(p.bps).toBe(2000n);
    expect(p.roleTag).toBe(ROLE_TAGS.integrator);
  });
});
