/**
 * R13, gateway side: the seam's `loadReservation` and the accept route's `consumeReservation`, over the
 * durable `BudgetReservationStore` (operator decision #2240, amended by #2301/#2302).
 *
 * The consume PROTOCOL is the one the end-to-end trace's stand-in specified, made durable. It runs
 * on the plan the server ITSELF just compiled, never a plan a caller presents:
 *   1. The plan must be the one for this reservation (plan id and reservation id).
 *   2. `acceptedDealDigest` is RECOMPUTED from the plan's content, as sha256 of its canonical preimage,
 *      and must equal the carried digest (the #351 consumer contract). A carried digest proves nothing on
 *      its own. The preimage bytes are what the store keeps as the sealed deal (amendment #3231), and it
 *      re-checks that they hash to the digest.
 *   3. The obligation is DERIVED from the units (Σ g) and must equal the carried total.
 *   4. Then ONE atomic store consume, in an immediate transaction. The store parses the preimage
 *      strictly and takes every term FROM THE SEALED DEAL (R13 round 2, M6), checking against the row:
 *      - principal, and the deal's reservation, request, currency and every job's payer;
 *      - issued and unexpired, by the store's OWN clock (round 2, H2): the route's `now` is not
 *        authority for expiry, so this adapter does not pass it;
 *      - the deal's obligation within the maximum;
 *      - no unit below the payer's assurance floor.
 * A recomputed digest proves integrity, not authority: a resealed plan with another payer still fails at 4.
 * If the store refuses the server's OWN compiled deal as malformed, that is a server fault, thrown so the
 * route answers a generic 500, never a client-facing conflict.
 */
import { createHash } from "node:crypto";
import { acceptedDealPreimage, type Address } from "@pcc/spec";
import type { BudgetReservationStore, ConsumeRefusal } from "@pcc/store";
import { planIdForReservation, type ReservationRecord } from "./external-plan-seam.js";
import type { ConsumeReservation } from "../routes/agent-plans.js";

/** Refusals that mean the server's own deal is malformed: never the caller's fault, never a 409. */
const SERVER_FAULTS: ReadonlySet<ConsumeRefusal> = new Set(["invalid-input", "deal-preimage-mismatch", "invalid-deal", "wrong-reservation"]);

export interface ReservationWiring {
  loadReservation(reservationId: string): ReservationRecord | null;
  consumeReservation: ConsumeReservation;
}

export function reservationWiring(store: BudgetReservationStore): ReservationWiring {
  return {
    loadReservation(reservationId) {
      const r = store.findById(reservationId);
      if (!r) return null;
      return {
        reservationId: r.reservationId,
        principal: r.principal,
        requestId: r.requestId,
        currency: r.currency,
        maxAmountBaseUnits: r.maxAmountBaseUnits,
        expiresAt: r.expiresAt,
        state: r.state,
        payer: r.payerAddress as Address,
        ...(r.minTier !== null ? { minTier: r.minTier } : {}),
      };
    },

    consumeReservation(reservationId, principal, plan) {
      if (plan.planId !== planIdForReservation(reservationId) || plan.reservationId !== reservationId) {
        return { ok: false, reason: "wrong-binding" };
      }
      const { acceptedDealDigest: carried, ...rest } = plan;
      const preimage = acceptedDealPreimage(rest);
      const recomputed = `0x${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
      if (recomputed !== carried.toLowerCase()) return { ok: false, reason: "digest-mismatch" };
      const units = plan.jobs.flatMap((j) => j.units);
      const derived = units.reduce((acc, u) => acc + u.g, 0n);
      if (units.length === 0 || derived !== plan.totalObligationBaseUnits) return { ok: false, reason: "obligation-mismatch" };
      const r = store.consume({ reservationId, principal, dealDigest: recomputed, dealPreimage: preimage });
      if (r.ok) return { ok: true };
      if (SERVER_FAULTS.has(r.reason)) throw new Error(`R13 consume: the store refused the server's own compiled deal (${r.reason})`);
      return { ok: false, reason: r.reason };
    },
  };
}
