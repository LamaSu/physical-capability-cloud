import { describe, it, expect } from "vitest";
import { classifyMoneyStatus } from "@pcc/spec";
import { moneyBadgeColor, DASHBOARD_ESCROW_STATUSES } from "../money-badge.js";

describe("moneyBadgeColor (dashboard escrow badge)", () => {
  it("a BARE escrow status is never green: settlement tone needs a settlement read model", () => {
    for (const s of ["released", "completed", "SETTLED_RELEASED", "RELEASED?", "releaſed"]) {
      expect(moneyBadgeColor(s), s).not.toBe("green");
    }
    expect(moneyBadgeColor("released")).toBe("gray");
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
