import { describe, it, expect } from "vitest";
import { assuranceTierToReputation, PCC_REPUTATION_TAGS } from "@pcc/spec";
import { getRegistryAddresses, REGISTRY_ADDRESSES } from "../constants.js";

describe("assuranceTierToReputation", () => {
  it("maps tier 0 to value 0", () => {
    const r = assuranceTierToReputation(0);
    expect(r.value).toBe(0);
    expect(r.tag1).toBe("assurance");
    expect(r.tag2).toBe("tier-0");
  });

  it("maps tier 1 to value 25", () => {
    const r = assuranceTierToReputation(1);
    expect(r.value).toBe(25);
    expect(r.tag2).toBe("tier-1");
  });

  it("maps tier 2 to value 50", () => {
    const r = assuranceTierToReputation(2);
    expect(r.value).toBe(50);
    expect(r.tag2).toBe("tier-2");
  });

  it("maps tier 3 to value 75", () => {
    const r = assuranceTierToReputation(3);
    expect(r.value).toBe(75);
    expect(r.tag2).toBe("tier-3");
  });
});

describe("PCC_REPUTATION_TAGS", () => {
  it("has all expected tags", () => {
    expect(PCC_REPUTATION_TAGS.ASSURANCE).toBe("assurance");
    expect(PCC_REPUTATION_TAGS.QUALITY).toBe("quality");
    expect(PCC_REPUTATION_TAGS.UPTIME).toBe("uptime");
    expect(PCC_REPUTATION_TAGS.RESPONSE_TIME).toBe("responseTime");
    expect(PCC_REPUTATION_TAGS.EVIDENCE_COMPLETENESS).toBe("evidenceCompleteness");
    expect(PCC_REPUTATION_TAGS.COMPLETION_RATE).toBe("completionRate");
  });
});

describe("getRegistryAddresses", () => {
  it("returns addresses for Ethereum Sepolia", () => {
    const addrs = getRegistryAddresses(11155111);
    expect(addrs.identityRegistry).toMatch(/^0x/);
    expect(addrs.reputationRegistry).toMatch(/^0x/);
  });

  it("returns addresses for Base Sepolia", () => {
    const addrs = getRegistryAddresses(84532);
    expect(addrs.identityRegistry).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(addrs.reputationRegistry).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
  });

  it("throws for unsupported chain", () => {
    expect(() => getRegistryAddresses(999999)).toThrow("No ERC-8004 registry addresses");
  });
});
