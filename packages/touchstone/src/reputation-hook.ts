/**
 * Reputation hook — translates touchstone results into ERC-8004
 * ReputationFeedback objects that can be submitted to the on-chain
 * Reputation Registry.
 *
 * This module only *creates* the feedback object.  Submitting it to the
 * chain is the gateway's responsibility.
 */

import type { ReputationFeedback } from "@pcc/spec/identity";
import type { TouchstoneResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base reputation value awarded on a touchstone pass (positive). */
const PASS_VALUE = 100n;

/**
 * Base reputation value deducted on a touchstone failure (negative).
 * This is intentionally 10x the pass value — the game-theoretic penalty
 * must make skipping strictly negative-EV.
 */
const FAIL_VALUE = -1000n;

/** Tag1 identifies feedback as originating from the touchstone module. */
const TAG1 = "touchstone";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an ERC-8004 `ReputationFeedback` object from a touchstone result.
 *
 * - **Pass**: `{value: +100, tag1: "touchstone", tag2: "pass"}`
 * - **Fail**: `{value: -1000, tag1: "touchstone", tag2: "fail"}`
 *
 * The returned object is ready to be submitted to the Reputation Registry
 * by the gateway.  This function does NOT perform on-chain submission.
 *
 * @param result  The touchstone verification result.
 * @param agentId The ERC-8004 agent ID (bigint token ID).
 * @returns A `ReputationFeedback` object.
 */
export function emitTouchstoneFeedback(
  result: TouchstoneResult,
  agentId: bigint,
): ReputationFeedback {
  return {
    agentId,
    value: result.passed ? PASS_VALUE : FAIL_VALUE,
    valueDecimals: 0,
    tag1: TAG1,
    tag2: result.passed ? "pass" : "fail",
  };
}
