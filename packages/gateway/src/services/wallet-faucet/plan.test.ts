import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEther, parseUnits } from "viem";
import { TESTNET_FUNDING } from "../wallet-links/consent.js";
import { FAUCET_PLAN } from "./plan.js";

afterEach(() => {
  vi.doUnmock("../wallet-links/consent.js");
  vi.resetModules();
});

describe("consent-derived faucet plan", () => {
  it("pins the promised agent and device grants and claim amounts", () => {
    expect(TESTNET_FUNDING).toEqual({
      agent: { eth: "0.0005", usdc: "1" },
      device: { eth: "0.0005", usdc: null },
    });
    expect(FAUCET_PLAN.agent).toEqual([
      { token: "eth", seq: 1, amount: "0.0001" },
      { token: "eth", seq: 2, amount: "0.0001" },
      { token: "eth", seq: 3, amount: "0.0001" },
      { token: "eth", seq: 4, amount: "0.0001" },
      { token: "eth", seq: 5, amount: "0.0001" },
      { token: "usdc", seq: 1, amount: "1" },
    ]);
    expect(FAUCET_PLAN.device).toEqual(FAUCET_PLAN.agent.slice(0, 5));
    for (const role of ["agent", "device"] as const) {
      const eth = FAUCET_PLAN[role].filter((claim) => claim.token === "eth")
        .reduce((total, claim) => total + parseEther(claim.amount), 0n);
      const usdc = FAUCET_PLAN[role].filter((claim) => claim.token === "usdc")
        .reduce((total, claim) => total + parseUnits(claim.amount, 6), 0n);
      expect(eth).toBe(parseEther(TESTNET_FUNDING[role].eth));
      expect(usdc).toBe(TESTNET_FUNDING[role].usdc === null ? 0n : parseUnits(TESTNET_FUNDING[role].usdc!, 6));
    }
  });

  it("freezes every claim, role plan and the plan itself", () => {
    expect(Object.isFrozen(FAUCET_PLAN)).toBe(true);
    for (const role of ["agent", "device"] as const) {
      expect(Object.isFrozen(FAUCET_PLAN[role])).toBe(true);
      expect(FAUCET_PLAN[role].every(Object.isFrozen)).toBe(true);
    }
  });

  it.each([
    ["eth", "0.00051"],
    ["eth", "0"],
    ["eth", "-0.0001"],
    ["usdc", "1.000001"],
    ["usdc", "0"],
    ["usdc", "-1"],
  ])("rejects an inexact or nonpositive %s promise of %s at load", async (token, amount) => {
    vi.doMock("../wallet-links/consent.js", () => ({
      TESTNET_FUNDING: {
        agent: { eth: "0.0005", usdc: "1", [token]: amount },
        device: { eth: "0.0005", usdc: null },
      },
    }));
    await expect(import("./plan.js")).rejects.toThrow("invalid_faucet_plan");
  });
});
