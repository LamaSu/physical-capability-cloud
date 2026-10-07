/**
 * R12 (operator 10/06, spec R12 rule 4): anything money-shaped that is not a pinned chain read is
 * attributed. In the closed-IR kit the only money surface is a capability card's price, which is the
 * operator's listed term, never a PCC-confirmed fact.
 */
import { describe, expect, it } from "vitest";
import { SCHEMA_FIELDS } from "./dashboard-ir-renderer.js";

describe("R12: the IR capability card attributes its price to the operator's listing", () => {
  it("labels the price field as the operator's listing, and keeps the currency a separate closed field", () => {
    const fields = SCHEMA_FIELDS["capability-summary-v1"].fields;
    expect(fields.find((f) => f.key === "pricing.baseCost")?.label).toBe("Listed price (operator's listing)");
    expect(fields.find((f) => f.key === "pricing.currency")?.label).toBe("Currency");
    expect(fields.some((f) => f.label === "Base cost")).toBe(false);
  });
});
