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
} from "../readmodels/product-home.js";
import { normalizeMoneyStatus } from "../money/money-status.js";
import type { EscrowStatus } from "../types/common.js";

describe("product home constants", () => {
  it("carries a versioned schema id", () => {
    expect(PRODUCT_HOME_SCHEMA_ID).toBe("pcc.product-home/v1");
  });

  it("held and not-held words are disjoint, and each is already in normalized form", () => {
    const held = new Set(HELD_MILESTONE_STATUSES);
    for (const w of NOT_HELD_MILESTONE_STATUSES) expect(held.has(w), w).toBe(false);
    // The gateway compares normalizeMoneyStatus(row.status) against these sets, so a word
    // that is not in normalized form could never match.
    for (const w of [...HELD_MILESTONE_STATUSES, ...NOT_HELD_MILESTONE_STATUSES]) expect(normalizeMoneyStatus(w), w).toBe(w);
  });

  it("classifies every EscrowStatus word and every milestone word the gateway writes", () => {
    // Compile-time: adding an EscrowStatus word without listing it here fails the build.
    const escrowStatus: { readonly [K in EscrowStatus as Uppercase<K>]: true } = {
      UNFUNDED: true, FUNDED: true, LOCKED: true, RELEASING: true,
      RELEASED: true, DISPUTED: true, REFUNDED: true, SLASHED: true,
    };
    // Written by the gateway's paid-job flow outside that type (insert and evidence paths).
    const written = ["PENDING", "EVIDENCE_SUBMITTED"];
    const classified = new Set([...HELD_MILESTONE_STATUSES, ...NOT_HELD_MILESTONE_STATUSES]);
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
  });
});
