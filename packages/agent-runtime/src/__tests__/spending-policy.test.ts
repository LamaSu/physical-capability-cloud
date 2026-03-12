import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  SpendingTracker,
  type SpendingPolicy,
  createUserAgentPolicy,
  createBrokerAgentPolicy,
  createKernelAgentPolicy,
} from "../spending-policy.js";

// ── Helpers ────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<SpendingPolicy> = {}): SpendingPolicy {
  return {
    maxPerTransaction: 100_000_000n,      // $100
    maxPerWindow: 500_000_000n,           // $500
    windowDuration: 3600,                 // 1 hour
    autoApprove: {
      x402_service: 1_000_000n,           // $1
      payment_request: 10_000_000n,       // $10
    },
    humanApprovalThreshold: 50_000_000n,  // $50
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("SpendingTracker", () => {
  let tracker: SpendingTracker;
  let policy: SpendingPolicy;

  beforeEach(() => {
    policy = makePolicy();
    tracker = new SpendingTracker(policy);
  });

  // ── canSpend ─────────────────────────────────────────────────

  describe("canSpend", () => {
    it("allows a spend within all limits", () => {
      const result = tracker.canSpend("x402_service", 500_000n);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("rejects a spend exceeding per-transaction limit", () => {
      const result = tracker.canSpend("payment_request", 200_000_000n); // $200 > $100 limit
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("per-transaction limit");
    });

    it("rejects a spend exceeding window limit", () => {
      // Fill up the window
      tracker.recordSpend("payment_request", 450_000_000n, "recipient1");

      // This should push over
      const result = tracker.canSpend("payment_request", 60_000_000n); // $60, total would be $510 > $500
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("window limit");
    });

    it("rejects a spend exceeding human approval threshold", () => {
      const result = tracker.canSpend("payment_request", 60_000_000n); // $60 > $50 threshold
      expect(result.allowed).toBe(false);
      expect(result.requiresHumanApproval).toBe(true);
      expect(result.reason).toContain("human approval");
    });

    it("rejects a spend exceeding auto-approve limit for intent", () => {
      const result = tracker.canSpend("x402_service", 2_000_000n); // $2 > $1 auto-approve
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("auto-approve limit");
    });

    it("allows a spend for intent with no auto-approve entry", () => {
      // "discover_capabilities" has no auto-approve entry
      const result = tracker.canSpend("discover_capabilities", 5_000_000n); // $5
      expect(result.allowed).toBe(true);
    });

    it("per-transaction check happens before window check", () => {
      // Even with plenty of window budget, per-tx limit applies
      const result = tracker.canSpend("payment_request", 200_000_000n);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("per-transaction");
    });

    it("human approval threshold of 0 means never require human", () => {
      const noHumanPolicy = makePolicy({
        humanApprovalThreshold: 0n,
        autoApprove: {}, // no auto-approve limits
      });
      const t = new SpendingTracker(noHumanPolicy);
      // $100 is the per-tx limit, so $99 should be fine (no human threshold, no auto-approve)
      const result = t.canSpend("payment_request", 99_000_000n);
      expect(result.allowed).toBe(true);
    });
  });

  // ── recordSpend ──────────────────────────────────────────────

  describe("recordSpend", () => {
    it("increases the window spend", () => {
      expect(tracker.spent).toBe(0n);
      tracker.recordSpend("x402_service", 1_000_000n, "recipient1");
      expect(tracker.spent).toBe(1_000_000n);
    });

    it("accumulates multiple spends", () => {
      tracker.recordSpend("x402_service", 1_000_000n, "recipient1");
      tracker.recordSpend("x402_service", 2_000_000n, "recipient2");
      expect(tracker.spent).toBe(3_000_000n);
    });

    it("records spend in history", () => {
      tracker.recordSpend("x402_service", 1_000_000n, "recipient1", "tx_abc123");
      const history = tracker.spendHistory;
      expect(history).toHaveLength(1);
      expect(history[0].intent).toBe("x402_service");
      expect(history[0].amount).toBe(1_000_000n);
      expect(history[0].recipient).toBe("recipient1");
      expect(history[0].txSignature).toBe("tx_abc123");
      expect(history[0].timestamp).toBeGreaterThan(0);
    });
  });

  // ── remaining ────────────────────────────────────────────────

  describe("remaining", () => {
    it("starts at the full window budget", () => {
      expect(tracker.remaining).toBe(500_000_000n);
    });

    it("decreases as spends are recorded", () => {
      tracker.recordSpend("x402_service", 100_000_000n, "r1");
      expect(tracker.remaining).toBe(400_000_000n);
    });

    it("never goes below zero", () => {
      // Force the tracker to have spent more than the window
      // (should not normally happen, but test the guard)
      tracker.recordSpend("payment_request", 500_000_000n, "r1");
      tracker.recordSpend("payment_request", 100_000_000n, "r2");
      // remaining should be 0, not negative
      expect(tracker.remaining).toBe(0n);
    });
  });

  // ── Window refresh ──────────────────────────────────────────

  describe("window refresh", () => {
    it("resets spend when window expires", () => {
      tracker.recordSpend("x402_service", 100_000_000n, "r1");
      expect(tracker.spent).toBe(100_000_000n);

      // Advance time past the window duration (1 hour = 3600 seconds)
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3601 * 1000);

      expect(tracker.spent).toBe(0n);
      expect(tracker.remaining).toBe(500_000_000n);

      vi.useRealTimers();
    });

    it("does not reset spend within the window", () => {
      vi.useFakeTimers();
      const start = Date.now();
      vi.setSystemTime(start);

      tracker.recordSpend("x402_service", 100_000_000n, "r1");

      // Advance 30 minutes (within 1-hour window)
      vi.setSystemTime(start + 1800 * 1000);
      expect(tracker.spent).toBe(100_000_000n);

      vi.useRealTimers();
    });

    it("allows spending again after window reset", () => {
      // Fill up the window
      tracker.recordSpend("payment_request", 450_000_000n, "r1");
      const check1 = tracker.canSpend("payment_request", 60_000_000n);
      expect(check1.allowed).toBe(false);

      // Advance past window
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3601 * 1000);

      const check2 = tracker.canSpend("payment_request", 10_000_000n);
      expect(check2.allowed).toBe(true);

      vi.useRealTimers();
    });
  });

  // ── updatePolicy ─────────────────────────────────────────────

  describe("updatePolicy", () => {
    it("applies new limits immediately", () => {
      // Current: $100 per-tx limit, $50 human threshold, $10 auto-approve for payment_request
      const check1 = tracker.canSpend("payment_request", 40_000_000n); // $40
      // $40 > $10 auto-approve for payment_request, so rejected
      expect(check1.allowed).toBe(false);
      expect(check1.reason).toContain("auto-approve");

      // Update to higher auto-approve and human thresholds
      tracker.updatePolicy(
        makePolicy({
          humanApprovalThreshold: 100_000_000n, // $100
          autoApprove: {
            x402_service: 1_000_000n,
            payment_request: 50_000_000n, // $50 auto-approve now
          },
        }),
      );

      const check2 = tracker.canSpend("payment_request", 40_000_000n); // $40 < $50 new auto-approve
      expect(check2.allowed).toBe(true);
    });
  });

  // ── reset ────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all spend and history", () => {
      tracker.recordSpend("x402_service", 100_000_000n, "r1");
      tracker.recordSpend("x402_service", 50_000_000n, "r2");

      expect(tracker.spent).toBe(150_000_000n);
      expect(tracker.spendHistory).toHaveLength(2);

      tracker.reset();

      expect(tracker.spent).toBe(0n);
      expect(tracker.remaining).toBe(500_000_000n);
      expect(tracker.spendHistory).toHaveLength(0);
    });
  });

  // ── Factory helpers ──────────────────────────────────────────

  describe("factory policies", () => {
    it("createUserAgentPolicy returns a valid policy", () => {
      const p = createUserAgentPolicy();
      const t = new SpendingTracker(p);
      expect(t.remaining).toBeGreaterThan(0n);
      expect(p.maxPerTransaction).toBeLessThan(p.maxPerWindow);
      expect(p.windowDuration).toBeGreaterThan(0);
    });

    it("createBrokerAgentPolicy has higher limits than user", () => {
      const user = createUserAgentPolicy();
      const broker = createBrokerAgentPolicy();
      expect(broker.maxPerTransaction).toBeGreaterThan(user.maxPerTransaction);
      expect(broker.maxPerWindow).toBeGreaterThan(user.maxPerWindow);
    });

    it("createKernelAgentPolicy has lower limits (kernels mostly receive)", () => {
      const kernel = createKernelAgentPolicy();
      const user = createUserAgentPolicy();
      expect(kernel.maxPerTransaction).toBeLessThanOrEqual(user.maxPerTransaction);
    });

    it("all factory policies produce functional trackers", () => {
      const policies = [
        createUserAgentPolicy(),
        createBrokerAgentPolicy(),
        createKernelAgentPolicy(),
      ];

      for (const p of policies) {
        const t = new SpendingTracker(p);
        const result = t.canSpend("x402_service", 100_000n); // $0.10
        expect(result.allowed).toBe(true);
      }
    });
  });
});
