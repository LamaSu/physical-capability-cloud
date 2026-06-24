/**
 * Tests for the Mode-A approve-release HTTP route on the gateway.
 *
 * POST /api/escrow/chain/:address/approve-release/:milestoneIndex
 *
 * Covers:
 *   1. Flag OFF (default) → 503 mode_a_disabled
 *   2. Flag ON + invalid address → 400 Invalid address
 *   3. Flag ON + invalid milestone index → 400 Invalid milestone index
 *   4. Flag ON + valid args → 200 with V3 calldata + target
 *   5. The returned calldata decodes as MilestoneEscrowV3.approveAndRelease(idx)
 *
 * NO chain calls. NO oracle calls. NO wallet. Pure HTTP + viem decode.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { decodeFunctionData } from "viem";

import { escrowRoutes } from "../routes/escrow.js";
import { initStore, closeStore } from "../db.js";
import { MilestoneEscrowV3ABI } from "@pcc/contracts/abi";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ESCROW = "0xDeAdBeEf00000000000000000000000000000010";
const TEST_MILESTONE = 3;

const ORIG_FLAG = process.env.VERIFICATION_MODE_A_ENABLED;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });

  const app = Fastify({ logger: false });
  await app.register(escrowRoutes);
  await app.ready();
  return app;
}

// ===========================================================================
// Suite
// ===========================================================================

describe("POST /api/escrow/chain/:address/approve-release/:milestoneIndex (Mode A)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  beforeEach(() => {
    // Each test sets its own flag value; clear stale state from previous test.
    delete process.env.VERIFICATION_MODE_A_ENABLED;
  });

  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.VERIFICATION_MODE_A_ENABLED;
    else process.env.VERIFICATION_MODE_A_ENABLED = ORIG_FLAG;
  });

  // -------------------------------------------------------------------------
  // 1 — Flag OFF (default) → 503 mode_a_disabled
  // -------------------------------------------------------------------------

  it("returns 503 when VERIFICATION_MODE_A_ENABLED is unset (default OFF)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/${TEST_MILESTONE}`,
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("mode_a_disabled");
    expect(body.message).toMatch(/VERIFICATION_MODE_A_ENABLED/);
  });

  it("returns 503 when VERIFICATION_MODE_A_ENABLED is explicitly 'false'", async () => {
    process.env.VERIFICATION_MODE_A_ENABLED = "false";
    const res = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/${TEST_MILESTONE}`,
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("mode_a_disabled");
  });

  // -------------------------------------------------------------------------
  // 2 — Flag ON + invalid address → 400
  // -------------------------------------------------------------------------

  it("returns 400 when the escrow address is not a valid 0x address", async () => {
    process.env.VERIFICATION_MODE_A_ENABLED = "true";

    const res = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/not-an-address/approve-release/0`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid address/i);
  });

  // -------------------------------------------------------------------------
  // 3 — Flag ON + invalid milestone index → 400
  // -------------------------------------------------------------------------

  it("returns 400 when milestoneIndex is not a non-negative integer", async () => {
    process.env.VERIFICATION_MODE_A_ENABLED = "true";

    const resNegative = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/-1`,
      payload: {},
    });
    expect(resNegative.statusCode).toBe(400);
    expect(resNegative.json().error).toMatch(/Invalid milestone index/i);

    const resNonNumeric = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/notanumber`,
      payload: {},
    });
    expect(resNonNumeric.statusCode).toBe(400);
    expect(resNonNumeric.json().error).toMatch(/Invalid milestone index/i);
  });

  // -------------------------------------------------------------------------
  // 4 — Flag ON + valid args → 200 with V3 calldata + target
  // -------------------------------------------------------------------------

  it("returns 200 with calldata + target when the flag is on and args are valid", async () => {
    process.env.VERIFICATION_MODE_A_ENABLED = "true";

    const res = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/${TEST_MILESTONE}`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Wire-shape contract: action / escrow / milestoneIndex / calldata / target / path
    expect(body.action).toBe("approveAndRelease");
    expect(body.escrow.toLowerCase()).toBe(TEST_ESCROW.toLowerCase());
    expect(body.milestoneIndex).toBe(TEST_MILESTONE);
    expect(body.target.toLowerCase()).toBe(TEST_ESCROW.toLowerCase());
    expect(body.valueWei).toBe("0");
    expect(typeof body.calldata).toBe("string");
    expect(body.calldata.startsWith("0x")).toBe(true);
    expect(body.instruction).toMatch(/payer/i);
    expect(body.path).toBe("v3-mode-a");
  });

  it("treats '1' as truthy for VERIFICATION_MODE_A_ENABLED (same as 'true')", async () => {
    process.env.VERIFICATION_MODE_A_ENABLED = "1";
    const res = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/${TEST_MILESTONE}`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 5 — Calldata decodes as MilestoneEscrowV3.approveAndRelease(idx)
  // -------------------------------------------------------------------------

  it("returned calldata decodes against the real published V3 ABI as approveAndRelease(idx)", async () => {
    process.env.VERIFICATION_MODE_A_ENABLED = "true";

    const res = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/${TEST_MILESTONE}`,
      payload: {},
    });

    const body = res.json();
    const decoded = decodeFunctionData({
      abi: MilestoneEscrowV3ABI,
      data: body.calldata as `0x${string}`,
    });

    expect(decoded.functionName).toBe("approveAndRelease");
    // bigint args[0] is the milestoneIndex.
    expect(decoded.args?.[0]).toBe(BigInt(TEST_MILESTONE));
  });

  it("calldata round-trips a different milestone index (no off-by-one / hardcode regression)", async () => {
    process.env.VERIFICATION_MODE_A_ENABLED = "true";
    const ANOTHER_IDX = 42;

    const res = await app.inject({
      method: "POST",
      url: `/api/escrow/chain/${TEST_ESCROW}/approve-release/${ANOTHER_IDX}`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const decoded = decodeFunctionData({
      abi: MilestoneEscrowV3ABI,
      data: res.json().calldata as `0x${string}`,
    });
    expect(decoded.args?.[0]).toBe(BigInt(ANOTHER_IDX));
  });
});
