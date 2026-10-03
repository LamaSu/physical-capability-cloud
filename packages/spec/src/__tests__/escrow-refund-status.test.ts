/**
 * N79: the words an escrow and its milestones carry once a job ended without completing and its escrow is given
 * back. The gateway writes them and the job read (readmodels) reads them, so both import them from here.
 */
import { describe, it, expect } from "vitest";
import { ESCROW_REFUND_STATUS } from "../types/settlement.js";
import { EscrowSchema, EscrowStatusSchema } from "../schemas/index.js";

describe("N79 escrow refund words", () => {
  it("are exactly refund_pending (decided, not yet on-chain) and refunded (done)", () => {
    expect(ESCROW_REFUND_STATUS).toEqual({ PENDING: "refund_pending", DONE: "refunded" });
  });

  it("are valid as a milestone status and as an escrow status", () => {
    for (const word of Object.values(ESCROW_REFUND_STATUS)) {
      expect(EscrowStatusSchema.parse(word)).toBe(word);
      expect(EscrowSchema.shape.status.parse(word)).toBe(word);
    }
  });
});
