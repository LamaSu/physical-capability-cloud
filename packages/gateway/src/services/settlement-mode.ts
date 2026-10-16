/**
 * Whether mock settlement is on: a paid job's escrow is a synthetic "mock-escrow-…" row created
 * "funded", and completion settles it without a chain.
 *
 * Board N133 rule 4 (the steward's DECISIONS 01:01, #6733): OFF unless MOCK_SETTLEMENT is exactly
 * "true". It used to be on unless the variable was "false", so a gateway with the variable unset
 * marked every paid job's escrow funded without anyone paying, and that escrow let the buyer's
 * write scope go live.
 *
 * N133 r1 (astra, HIGH): the flag alone is not enough.
 *   - Mock settlement is refused when NODE_ENV is "production", whatever the flag says.
 *   - A mock escrow FUNDS a write scope (mockFundsWrites) only in a test process (isTestProcess).
 *     Elsewhere, a development gateway with the flag set included, mock settlement still settles
 *     in mock, but a mock escrow never makes a write scope live, and the relay refuses a write
 *     under a scope bound to a job with a mock escrow (device-relay.ts escrowRefusal).
 *
 * routes/paid-job-flow.ts re-exports isMockSettlement, and the negotiation commit makes its "did
 * real settlement wire an escrow?" decision from the same function, so the two never disagree.
 */
export function isMockSettlement(): boolean {
  return process.env.MOCK_SETTLEMENT === "true" && process.env.NODE_ENV !== "production";
}

/** A test process: the vitest runner (it sets VITEST) with NODE_ENV "test". Nothing else counts. */
export function isTestProcess(): boolean {
  return process.env.NODE_ENV === "test" && process.env.VITEST === "true";
}

/** Whether a mock escrow stands in for the buyer's funding of a write scope: only in a test process. */
export function mockFundsWrites(): boolean {
  return isMockSettlement() && isTestProcess();
}
