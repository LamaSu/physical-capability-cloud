/**
 * ProductHomeDTO constants (PX-7): the held / not-held milestone words and the chain ids of
 * the network names the gateway can be configured with.
 */
import { describe, it, expect } from "vitest";
import {
  HELD_MILESTONE_STATUSES,
  NETWORK_CHAIN_IDS,
  NOT_HELD_MILESTONE_STATUSES,
  PRODUCT_HOME_SCHEMA_ID,
  RELEASE_DECIDED_MILESTONE_STATUSES,
} from "../readmodels/product-home.js";
import { VNEXT_UNIT_STATES, normalizeMoneyStatus } from "../money/money-status.js";
import type { EscrowStatus } from "../types/common.js";

describe("product home constants", () => {
  it("carries a versioned schema id", () => {
    expect(PRODUCT_HOME_SCHEMA_ID).toBe("pcc.product-home/v1");
  });

  it("held, release-decided and not-held words are disjoint, and each is already in normalized form", () => {
    const sets = [HELD_MILESTONE_STATUSES, RELEASE_DECIDED_MILESTONE_STATUSES, NOT_HELD_MILESTONE_STATUSES];
    const all = sets.flat();
    expect(new Set(all).size).toBe(all.length);
    // The gateway compares normalizeMoneyStatus(row.status) against these sets, so a word
    // that is not in normalized form could never match.
    for (const w of all) expect(normalizeMoneyStatus(w), w).toBe(w);
  });

  it("escrow #3356: every observable V-next state is classified, and legacy V3 EVIDENCED/ATTESTED are held", () => {
    const classified = new Set([...HELD_MILESTONE_STATUSES, ...RELEASE_DECIDED_MILESTONE_STATUSES, ...NOT_HELD_MILESTONE_STATUSES]);
    // AWAITING_FUNDING (0) is never observable.
    for (const w of VNEXT_UNIT_STATES.filter((s) => s !== "AWAITING_FUNDING")) expect(classified.has(w), w).toBe(true);
    for (const w of ["FUNDED_ACTIVE", "PRIMARY_ASSERTED", "CHALLENGED", "BACKUP_PENDING", "BACKUP_ASSERTED", "REFUND_ALLOCATED", "EVIDENCED", "ATTESTED"]) {
      expect(HELD_MILESTONE_STATUSES.includes(w), w).toBe(true);
    }
  });

  it("NEGATIVE (escrow #3356): a decided release is an upper bound, never held", () => {
    expect(RELEASE_DECIDED_MILESTONE_STATUSES).toEqual(["RELEASE_ALLOCATED"]);
    expect(HELD_MILESTONE_STATUSES.includes("RELEASE_ALLOCATED")).toBe(false);
  });

  it("classifies every EscrowStatus word and every milestone word the gateway writes", () => {
    // Compile-time: adding an EscrowStatus word without listing it here fails the build.
    const escrowStatus: { readonly [K in EscrowStatus as Uppercase<K>]: true } = {
      UNFUNDED: true, FUNDED: true, LOCKED: true, RELEASING: true,
      RELEASED: true, DISPUTED: true, REFUNDED: true, SLASHED: true,
    };
    // Written by the gateway's paid-job flow outside that type (insert and evidence paths).
    const written = ["PENDING", "EVIDENCE_SUBMITTED"];
    const classified = new Set([...HELD_MILESTONE_STATUSES, ...RELEASE_DECIDED_MILESTONE_STATUSES, ...NOT_HELD_MILESTONE_STATUSES]);
    for (const w of [...Object.keys(escrowStatus), ...written]) expect(classified.has(w), w).toBe(true);
  });

  it("NEGATIVE: paid-out, returned and never-funded words are not held", () => {
    for (const w of ["RELEASED", "SETTLED_RELEASED", "REFUNDED", "SETTLED_REFUNDED", "SLASHED", "CREATED", "UNFUNDED", "PENDING"]) {
      expect(HELD_MILESTONE_STATUSES.includes(w), w).toBe(false);
    }
  });

  it("maps configured network names to their chain ids", () => {
    expect(NETWORK_CHAIN_IDS).toEqual({ "base-sepolia": 84532, base: 8453, sepolia: 11155111, mainnet: 1 });
    expect(Object.isFrozen(NETWORK_CHAIN_IDS)).toBe(true);
    expect(Object.isFrozen(HELD_MILESTONE_STATUSES)).toBe(true);
    expect(Object.isFrozen(RELEASE_DECIDED_MILESTONE_STATUSES)).toBe(true);
  });
});
