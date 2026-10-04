/**
 * Whether mock settlement is on: a paid job's escrow is a synthetic "mock-escrow-…" row created
 * "funded", and completion settles it without a chain.
 *
 * Board N133 rule 4 (the steward's DECISIONS 01:01, #6733): OFF unless MOCK_SETTLEMENT is exactly
 * "true". It used to be on unless the variable was "false", so a gateway with the variable unset
 * marked every paid job's escrow funded without anyone paying, and that escrow let the buyer's
 * write scope go live. Production and staging set MOCK_SETTLEMENT=false explicitly; a dev gateway
 * or a test that wants mock settlement must set it to "true".
 *
 * routes/paid-job-flow.ts re-exports this, and the negotiation commit makes its "did real
 * settlement wire an escrow?" decision from the same function, so the two never disagree.
 */
export function isMockSettlement(): boolean {
  return process.env.MOCK_SETTLEMENT === "true";
}
