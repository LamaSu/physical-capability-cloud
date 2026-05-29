/**
 * @pcc/contracts/testing — shared test fixtures.
 *
 * Promoted from duplicated `mkAttestation()` helpers in:
 *   - packages/agent-runtime/src/__tests__/settlement-client.test.ts
 *   - packages/bundler/src/__tests__/batch-settler.test.ts
 *   - packages/gateway/src/__tests__/settlement-telemetry.test.ts
 *   - packages/gateway/src/__tests__/story-pipeline.test.ts
 *
 * This file lives under `ts/` alongside other @pcc/contracts code. It has
 * no production runtime users — only test files import from it.
 *
 * The fixture defaults to a canonical v1 attestation
 * (IPCCOracle.Attestation v10 schema: version + extraData added). Call
 * sites that predate the schema bump keep working without changes because
 * the defaults are applied automatically.
 */

import type { Address, Hex } from "viem";
import type { OracleAttestation } from "./oracle-attestation.js";
import {
  ATTESTATION_SCHEMA_VERSION,
  ATTESTATION_V1_EMPTY_EXTRA_DATA,
} from "./abi/PCCProtocol.js";

/**
 * Default fixture values — the union of the values each original test file
 * was using. Note: timestamp is `bigint` because the Solidity struct maps
 * `uint256 timestamp` → `bigint` via viem.
 */
const DEFAULT_ATTESTATION = {
  version: ATTESTATION_SCHEMA_VERSION,
  escrowAddress: "0xDeAdBeEf00000000000000000000000000000001" as Address,
  jobId: "job-001",
  evidenceHash:
    "0x570b1e0000000000000000000000000000000000000000000000000000000001" as Hex,
  tier: 0,
  verified: true,
  timestamp: 1_700_000_000n,
  nonce: ("0x" + "d".repeat(64)) as Hex,
  extraData: ATTESTATION_V1_EMPTY_EXTRA_DATA as Hex,
  signature: "0x" as Hex,
} as const;

/**
 * Build a deterministic OracleAttestation for tests.
 *
 * All fields default to values that pin the attestation to the shared
 * test escrow (0xDeAdBeEf...0001). Pass `overrides` to change any
 * subset — this preserves each call site's original fixture values when
 * the caller migrates from a local helper.
 *
 * Examples:
 *   mkAttestation()
 *     → default v1 attestation for escrow 0xDeAdBeEf...0001
 *   mkAttestation({ escrowAddress: "0x1234..." as Address })
 *     → v1 attestation for a specific escrow
 *   mkAttestation({ version: 2, extraData: "0xcafe" })
 *     → forward-compat v2 attestation (for version-guard tests)
 */
export function mkAttestation(
  overrides: Partial<OracleAttestation> = {},
): OracleAttestation {
  return {
    ...DEFAULT_ATTESTATION,
    ...overrides,
  };
}

/** Constants re-exported for call sites that want named references. */
export { ATTESTATION_SCHEMA_VERSION, ATTESTATION_V1_EMPTY_EXTRA_DATA };
