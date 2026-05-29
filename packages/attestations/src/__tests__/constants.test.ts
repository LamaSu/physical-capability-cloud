import { describe, it, expect } from "vitest";
import {
  EAS_DEPLOYMENTS,
  getEASDeployment,
  ZERO_ADDRESS,
  ZERO_BYTES32,
} from "../constants.js";

describe("EAS deployments", () => {
  it("includes Base mainnet (8453)", () => {
    expect(EAS_DEPLOYMENTS[8453]).toBeDefined();
    expect(EAS_DEPLOYMENTS[8453]!.eas).toBe(
      "0x4200000000000000000000000000000000000021",
    );
    expect(EAS_DEPLOYMENTS[8453]!.schemaRegistry).toBe(
      "0x4200000000000000000000000000000000000020",
    );
  });

  it("includes Ethereum mainnet, Optimism, Polygon, Arbitrum, Sepolia, Base Sepolia", () => {
    const chains = [1, 10, 137, 42161, 8453, 11155111, 84532];
    for (const id of chains) {
      expect(EAS_DEPLOYMENTS[id]).toBeDefined();
      expect(EAS_DEPLOYMENTS[id]!.eas).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(EAS_DEPLOYMENTS[id]!.schemaRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("getEASDeployment throws on unknown chain", () => {
    expect(() => getEASDeployment(99999999)).toThrow(/EAS not deployed/);
  });

  it("getEASDeployment returns full deployment record", () => {
    const dep = getEASDeployment(8453);
    expect(dep.chainId).toBe(8453);
    expect(dep.chainName).toBe("base");
  });

  it("ZERO_ADDRESS and ZERO_BYTES32 have correct lengths", () => {
    expect(ZERO_ADDRESS).toBe("0x0000000000000000000000000000000000000000");
    expect(ZERO_BYTES32).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});
