/**
 * @pcc/contracts/testing — shared test fixtures.
 *
 * Promoted from duplicated `mkAttestation()` helpers that existed in
 * agent-runtime's settlement-client.test.ts, gateway's settlement-telemetry
 * .test.ts, and gateway's story-pipeline.test.ts after commits d975754 /
 * 6e37811 / 9bbd800 threaded OracleAttestation through every release() path.
 *
 * This file lives under ts/ alongside other @pcc/contracts code and is
 * published via the `./testing` subpath export. It has no production
 * runtime users — only test files import from it.
 *
 * NOTE: The existing settlement.test.ts in packages/gateway is still
 * excluded from vitest.config.ts (facade-rewrite backlog) and keeps its
 * own local mkAttestation copy; when that file rejoins the suite it should
 * swap to this shared helper too.
 */

import type { OracleAttestation } from "./oracle-attestation.js";

/**
 * Default fixture values used when a test doesn't override a field. These
 * match the values the three original test files converged on, so the
 * refactor is value-preserving by default: jobId="job-001", tier=0,
 * verified=true, escrowAddress=0xDeAdBeEf...0001, evidenceHash=0x570b1e...01,
 * timestamp=1_700_000_000n, nonce=0xdd...dd, signature=0x.
 *
 * Intentionally `as const` so TypeScript narrows the 0x-prefixed fields to
 * their `0x${string}` template-literal types.
 */
const DEFAULT_ATTESTATION: OracleAttestation = {
  escrowAddress: "0xDeAdBeEf00000000000000000000000000000001" as `0x${string}`,
  jobId: "job-001",
  evidenceHash:
    "0x570b1e0000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
  tier: 0,
  verified: true,
  timestamp: 1700000000n,
  nonce: ("0x" + "d".repeat(64)) as `0x${string}`,
  signature: "0x" as `0x${string}`,
};

/**
 * Build a deterministic OracleAttestation for tests.
 *
 * All fields default to values that pin the attestation to the test's
 * default escrow (0xDeAdBeEf...0001). Pass `overrides` to change any
 * subset — this preserves each call site's original fixture values when
 * the caller migrates from a local helper.
 *
 * Back-compat shim: the old per-file helpers accepted a positional
 * `escrowAddress` arg. Callers that still pass a single `0x…` string
 * keep working — the overload treats it as `{ escrowAddress }`.
 */
export function mkAttestation(
  overrides?: Partial<OracleAttestation> | `0x${string}`,
): OracleAttestation {
  if (typeof overrides === "string") {
    return { ...DEFAULT_ATTESTATION, escrowAddress: overrides };
  }
  return { ...DEFAULT_ATTESTATION, ...(overrides ?? {}) };
}
