import { describe, it, expect } from "vitest";
import { classifyMoneyStatus } from "@pcc/spec";
import { moneyBadgeColor, DASHBOARD_ESCROW_STATUSES } from "../money-badge.js";

describe("moneyBadgeColor (dashboard escrow badge)", () => {
  it("is green ONLY for a documented final release to the operator", () => {
    expect(moneyBadgeColor("released")).toBe("green");
    expect(moneyBadgeColor("completed")).toBe("green");
    expect(moneyBadgeColor("SETTLED_RELEASED")).toBe("green");
  });

  it("never renders a refund, an allocation, a dispute or an unknown state green", () => {
    for (const s of [
      "refunded", "SETTLED_REFUNDED", "REFUND_ALLOCATED", "RELEASE_ALLOCATED", "funded",
      "pending", "expired", "disputed", "underfunded", "settled", "paid", "success", "done",
      "", null, undefined, "zzz",
    ]) {
      expect(moneyBadgeColor(s), JSON.stringify(s)).not.toBe("green");
    }
    expect(moneyBadgeColor("refunded")).toBe("gray");
    expect(moneyBadgeColor("disputed")).toBe("red");
    expect(moneyBadgeColor("active")).toBe("gold");
  });

  it("every dashboard EscrowStatus value is a KNOWN state in the canonical map", () => {
    expect(DASHBOARD_ESCROW_STATUSES.length).toBe(7);
    for (const s of DASHBOARD_ESCROW_STATUSES) {
      expect(classifyMoneyStatus(s).known, s).toBe(true);
    }
  });
});
