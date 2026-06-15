/**
 * Tests for the FULL V2 (EAS) settlement wiring — the gateway-side additions
 * that complete the MilestoneEscrowV2 path beyond the original EAS bridge.
 *
 * Covers (all pure / mocked — NO live chain, NO live oracle):
 *   1. PCCProtocolV2 ABI exposes createEscrowV2 with the V1-compatible shape
 *      (payer, arbiter, token, cwmId) — calldata round-trips.
 *   2. EscrowCreated event decodes with `escrow` as the first indexed param
 *      (the receipt-parsing contract for per-job escrow creation).
 *   3. V2 escrow-client write fns (submitEvidenceV2/submitAttestationV2/
 *      releaseMilestoneV2) dispatch the correct V2 ABI function + args, proven
 *      by spying on the viem wallet client's writeContract.
 *   4. Oracle client V2 round-trip: a request with mintEasAttestation:true gets a
 *      mock easAttestation.easUid back (the field the gateway previously dropped).
 *
 * These lock in the branch-by-abstraction contract: the V2 helpers are additive
 * and route to the V2 ABI, leaving the V1 helpers untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeFunctionData,
  decodeFunctionData,
  decodeEventLog,
  encodeEventTopics,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { PCCProtocolV2ABI, MilestoneEscrowV2ABI } from "@pcc/contracts/abi";

/**
 * Assert the dispatched ABI is the V2 escrow ABI. We can't use reference
 * equality (toBe) against the imported MilestoneEscrowV2ABI: the escrow-client
 * is dynamically re-imported after vi.resetModules(), so it holds a SEPARATE
 * module instance of the same ABI. Instead we check for a V2-ONLY member
 * (`attestationUsed`, the single-use UID guard) that V1's MilestoneEscrowABI
 * does not have — a stable, semantic discriminator.
 */
function expectV2Abi(abi: unknown): void {
  expect(Array.isArray(abi)).toBe(true);
  const names = (abi as Array<{ name?: string }>).map((e) => e.name);
  expect(names).toContain("attestationUsed");
  // Sanity: the canonical import also has it (guards against the marker moving).
  expect((MilestoneEscrowV2ABI as ReadonlyArray<{ name?: string }>).some((e) => e.name === "attestationUsed")).toBe(true);
}

// ===========================================================================
// 1 & 2 — PCCProtocolV2 ABI: createEscrowV2 + EscrowCreated
// ===========================================================================

describe("PCCProtocolV2 ABI (per-job escrow factory)", () => {
  it("createEscrowV2 has the V1-compatible (payer, arbiter, token, cwmId) signature", () => {
    const payer = ("0x" + "11".repeat(20)) as Hex;
    const arbiter = ("0x" + "22".repeat(20)) as Hex;
    const token = ("0x" + "33".repeat(20)) as Hex;
    const cwmId = ("0x" + "44".repeat(32)) as Hex;

    const data = encodeFunctionData({
      abi: PCCProtocolV2ABI,
      functionName: "createEscrowV2",
      args: [payer, arbiter, token, cwmId],
    });

    const decoded = decodeFunctionData({ abi: PCCProtocolV2ABI, data });
    expect(decoded.functionName).toBe("createEscrowV2");
    expect(decoded.args).toEqual([payer, arbiter, token, cwmId]);
  });

  it("EscrowCreated decodes with `escrow` as the first indexed param (topics[1])", () => {
    const escrow = ("0x" + "ab".repeat(20)) as Hex;
    const payer = ("0x" + "cd".repeat(20)) as Hex;
    const arbiter = ("0x" + "ef".repeat(20)) as Hex;
    const token = ("0x" + "12".repeat(20)) as Hex;
    const cwmId = ("0x" + "34".repeat(32)) as Hex;

    // Build the indexed topics exactly as a node would emit them.
    const topics = encodeEventTopics({
      abi: PCCProtocolV2ABI,
      eventName: "EscrowCreated",
      args: { escrow, payer, arbiter },
    });
    // Non-indexed args (token, cwmId) live in `data`, ABI-encoded in order.
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [token, cwmId],
    );

    const decoded = decodeEventLog({
      abi: PCCProtocolV2ABI,
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    expect(decoded.eventName).toBe("EscrowCreated");
    const args = decoded.args as Record<string, unknown>;
    // The escrow address is recoverable (the receipt-parsing contract).
    expect((args.escrow as string).toLowerCase()).toBe(escrow.toLowerCase());
    expect((args.payer as string).toLowerCase()).toBe(payer.toLowerCase());
  });
});

// ===========================================================================
// 3 — V2 escrow-client write fns dispatch the right V2 ABI function
// ===========================================================================

describe("escrow-client V2 write dispatch (mocked wallet)", () => {
  const ESCROW = ("0x" + "9a".repeat(20)) as `0x${string}`;
  const HASH = ("0x" + "bc".repeat(32)) as `0x${string}`;
  const UID = ("0x" + "de".repeat(32)) as `0x${string}`;
  const ORIG_PK = process.env.PCC_GATEWAY_PRIVATE_KEY;

  // Capture writeContract calls.
  const writeContract = vi.fn().mockResolvedValue("0x" + "f".repeat(64));

  beforeEach(() => {
    vi.resetModules();
    writeContract.mockClear();
    // A real-looking key so isWriteEnabled() is true + getAccount() works.
    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

    // Mock viem so the wallet client's writeContract is our spy, but keep the
    // real encoders (encodeFunctionData etc.) intact.
    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({ readContract: vi.fn() }),
      };
    });
  });

  afterEach(() => {
    if (ORIG_PK === undefined) delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    else process.env.PCC_GATEWAY_PRIVATE_KEY = ORIG_PK;
    vi.doUnmock("viem");
  });

  it("submitEvidenceV2 calls submitEvidence on the V2 ABI", async () => {
    const { submitEvidenceV2 } = await import("../contracts/escrow-client.js");
    await submitEvidenceV2(2, HASH, ESCROW);

    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("submitEvidence");
    expect(call.address).toBe(ESCROW);
    expect(call.args).toEqual([2n, HASH]);
    expectV2Abi(call.abi);
  });

  it("submitAttestationV2 calls submitAttestation(uint256, bytes32 easUid) on the V2 ABI", async () => {
    const { submitAttestationV2 } = await import("../contracts/escrow-client.js");
    await submitAttestationV2(0, UID, ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("submitAttestation");
    expect(call.args).toEqual([0n, UID]);
    expectV2Abi(call.abi);
  });

  it("releaseMilestoneV2 calls release(uint256) with ONLY the index (no struct)", async () => {
    const { releaseMilestoneV2 } = await import("../contracts/escrow-client.js");
    await releaseMilestoneV2(1, ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("release");
    expect(call.args).toEqual([1n]);
    expectV2Abi(call.abi);
  });
});

// ===========================================================================
// 4 — Oracle client V2 round-trip (the previously-dropped easAttestation field)
// ===========================================================================

describe("oracle-client V2 EAS fields", () => {
  const ORIG_KEY = process.env.PCC_ORACLE_KEY;

  beforeEach(() => {
    vi.resetModules();
    // No oracle key -> mockVerification path (deterministic, no network).
    delete process.env.PCC_ORACLE_KEY;
  });

  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.PCC_ORACLE_KEY;
    else process.env.PCC_ORACLE_KEY = ORIG_KEY;
  });

  it("returns a mock easAttestation.easUid when mintEasAttestation is requested", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle({
      escrowAddress: "0x0000000000000000000000000000000000000000",
      jobId: "job-v2",
      kernelId: "kernel-x",
      evidenceHash: "0x" + "ab".repeat(32),
      assuranceTier: 0,
      chainId: 84532,
      mintEasAttestation: true,
      stepId: "0x" + "cc".repeat(32),
      schemaUid: "0x5acb07db80019928f2aa8798cb0bebaee46a863f28d4b5aaf5a9e04902be8b93",
    });

    expect(res.result.verified).toBe(true);
    expect(res.easAttestation).not.toBeNull();
    expect(res.easAttestation?.easUid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.easAttestation?.schemaUid).toBe(
      "0x5acb07db80019928f2aa8798cb0bebaee46a863f28d4b5aaf5a9e04902be8b93",
    );
  });

  it("returns easAttestation:null on the V1 path (no minting requested)", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle({
      escrowAddress: "0x0000000000000000000000000000000000000000",
      jobId: "job-v1",
      kernelId: "kernel-x",
      evidenceHash: "0x" + "ab".repeat(32),
      assuranceTier: 0,
      chainId: 84532,
    });

    expect(res.attestation).not.toBeNull();
    expect(res.easAttestation ?? null).toBeNull();
  });
});
