import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymasterClient } from "../paymaster.js";
import type { Address, Hex } from "viem";

describe("PaymasterClient", () => {
  let paymaster: PaymasterClient;

  beforeEach(() => {
    paymaster = new PaymasterClient({
      url: "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=test",
      mode: "full",
    });
  });

  it("returns unsponsored when mode is none", async () => {
    const noPaymaster = new PaymasterClient({ url: "", mode: "none" });
    const result = await noPaymaster.sponsor(
      { sender: "0x1234" },
      "0x1111111111111111111111111111111111111111" as Address,
    );
    expect(result.sponsored).toBe(false);
    expect(result.paymasterAndData).toBe("0x");
  });

  it("enforces rate limits", async () => {
    paymaster.setRateLimit(2);
    const agent = "0x1111111111111111111111111111111111111111" as Address;

    // Mock fetch for sponsorship requests
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        result: {
          paymasterAndData: "0xpaymaster" as Hex,
          verificationGasLimit: "500000",
          maxFeePerGas: "1000000000",
        },
      }),
    });

    try {
      // First two should work
      const r1 = await paymaster.sponsor({}, agent);
      expect(r1.sponsored).toBe(true);

      const r2 = await paymaster.sponsor({}, agent);
      expect(r2.sponsored).toBe(true);

      // Third should be rate-limited
      const r3 = await paymaster.sponsor({}, agent);
      expect(r3.sponsored).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces daily budget", async () => {
    paymaster.setDailyBudget(0n); // exhausted
    const agent = "0x1111111111111111111111111111111111111111" as Address;

    const result = await paymaster.sponsor({}, agent);
    expect(result.sponsored).toBe(false);
  });

  it("resets daily spend and rate limits", async () => {
    paymaster.setDailyBudget(0n);
    const agent = "0x1111111111111111111111111111111111111111" as Address;

    let result = await paymaster.sponsor({}, agent);
    expect(result.sponsored).toBe(false);

    paymaster.resetDaily();
    paymaster.setDailyBudget(1_000_000_000_000_000_000n);

    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        result: {
          paymasterAndData: "0xpaymaster" as Hex,
          verificationGasLimit: "500000",
          maxFeePerGas: "1000000000",
        },
      }),
    });

    try {
      result = await paymaster.sponsor({}, agent);
      expect(result.sponsored).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("tracks stats", () => {
    paymaster.approveContract("0x1111111111111111111111111111111111111111" as Address);
    paymaster.approveContract("0x2222222222222222222222222222222222222222" as Address);

    const stats = paymaster.getStats();
    expect(stats.approvedContracts).toBe(2);
    expect(stats.dailySpend).toBe(0n);
  });

  it("revokes approved contracts", () => {
    paymaster.approveContract("0x1111111111111111111111111111111111111111" as Address);
    expect(paymaster.getStats().approvedContracts).toBe(1);

    paymaster.revokeContract("0x1111111111111111111111111111111111111111" as Address);
    expect(paymaster.getStats().approvedContracts).toBe(0);
  });

  it("gracefully handles fetch errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    try {
      const result = await paymaster.sponsor(
        {},
        "0x1111111111111111111111111111111111111111" as Address,
      );
      expect(result.sponsored).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
