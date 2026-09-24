/**
 * GlowBadge color for an escrow / settlement status.
 *
 * Semantics come from the ONE canonical map in @pcc/spec (classifyMoneyStatus):
 * exact keys, no substring inference, unknown fails closed. This module only
 * maps a semantic tone to a presentation color. Green is reserved for a
 * documented FINAL release to the operator; a refund, an allocated-not-final
 * state, or anything unknown is never green. (GlowBadge itself defaults to
 * green, so a money badge must always pass an explicit color from here.)
 */
import { classifyMoneyStatus, type MoneyTone } from "@pcc/spec";
import type { EscrowStatus } from "../types/dto.js";

export type MoneyBadgeColor = "green" | "gold" | "red" | "gray";

const TONE_COLOR: Readonly<Record<MoneyTone, MoneyBadgeColor>> = Object.freeze({
  settled: "green", // ONLY a documented final release to the operator
  running: "gold",
  failed: "red",
  refunded: "gray", // final, operator NOT paid: never green
  waiting: "gray",
  unknown: "gray", // fail closed
});

export function moneyBadgeColor(status: unknown): MoneyBadgeColor {
  return TONE_COLOR[classifyMoneyStatus(status).tone];
}

// Compile-time: every value of the dashboard's EscrowStatus type is listed here
// (tsc fails if the type gains one), and the test asserts each is a KNOWN money
// state in the canonical map, so no real escrow status ever renders "unknown".
const DTO_ESCROW_STATUS: Readonly<Record<EscrowStatus, true>> = {
  pending: true,
  funded: true,
  active: true,
  released: true,
  disputed: true,
  refunded: true,
  expired: true,
};
export const DASHBOARD_ESCROW_STATUSES: readonly EscrowStatus[] = Object.freeze(
  Object.keys(DTO_ESCROW_STATUS) as EscrowStatus[],
);
