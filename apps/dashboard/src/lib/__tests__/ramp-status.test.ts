/**
 * Product-qa #3 (money harm): a ramp session still in flight must never read
 * "Failed". The old mapping knew only "completed" and "pending", so created,
 * pending_payment and processing all fell through to failed.
 */

import { describe, expect, it } from "vitest";
import type { RampSessionStatus } from "@pcc/spec";
import { rampSessionChip } from "../ramp-status.js";

// Every RampSessionStatus in packages/spec/src/types/fiat-ramp.ts. The
// satisfies clause fails to compile if one is added there and not here.
const ALL = ["created", "pending_payment", "processing", "completed", "failed", "expired"] as const satisfies readonly RampSessionStatus[];
type Missing = Exclude<RampSessionStatus, (typeof ALL)[number]>;
const exhaustive: Missing extends never ? true : false = true;

describe("rampSessionChip", () => {
  it("covers every status the spec defines", () => {
    expect(exhaustive).toBe(true);
  });

  it.each(["created", "pending_payment", "processing"] as const)("%s is in progress, not failed", (s) => {
    const chip = rampSessionChip(s);
    expect(chip.status).toBe("executing");
    expect(chip.label).not.toMatch(/fail/i);
  });

  it("only failed reads as failed", () => {
    expect(ALL.filter((s) => rampSessionChip(s).status === "failed")).toEqual(["failed"]);
  });

  it("completed is completed; expired is expired, not failed", () => {
    expect(rampSessionChip("completed")).toEqual({ status: "completed", label: "Completed" });
    expect(rampSessionChip("expired")).toEqual({ status: "offline", label: "Expired" });
  });

  it("a status it doesn't know reads as unknown, never failed", () => {
    expect(rampSessionChip("refund_pending")).toEqual({ status: "offline", label: "Unknown status (refund_pending)" });
    expect(rampSessionChip("toString").label).toBe("Unknown status (toString)");
  });
});
