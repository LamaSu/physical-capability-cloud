/**
 * Unit tests for attestEvidenceOnChain (oracle-client.ts).
 *
 * Mocks ONLY:
 *   - @ethereum-attestation-service/eas-sdk  (EAS class, SchemaEncoder, NO_EXPIRATION)
 *   - ethers  (JsonRpcProvider, Wallet)
 *
 * The REAL oracle-client source is under test. escrow-client is NOT mocked
 * here — oracle-client does not import it.
 *
 * Asserts:
 *   C2b — SchemaEncoder.encodeData is called with all 7 fields including stepId
 *   C2a — eas.attest receives data.recipient === input.recipient (escrow addr)
 *         not the gateway signer address
 *        — oracleVerified field is true
 *   uid  — returned uid comes from the resolved value of tx.wait()
 *
 * Authored by: test-writer-hotel (split from eas-attestation-bridge.test.ts)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Spy references — these are the actual mock function objects that the
// vi.mock factory will wire into the EAS/SchemaEncoder class instances.
// Because vi.mock is hoisted, these must be declared at module scope.
// ---------------------------------------------------------------------------

const mockWait = vi.fn().mockResolvedValue("0xmock_eas_uid");
const mockAttest = vi.fn().mockResolvedValue({ wait: mockWait });
const mockConnect = vi.fn();
const mockEncodeData = vi.fn().mockReturnValue("0xencoded_data");

// ---------------------------------------------------------------------------
// Module mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

vi.mock("@ethereum-attestation-service/eas-sdk", () => ({
  EAS: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    attest: mockAttest,
  })),
  SchemaEncoder: vi.fn().mockImplementation(() => ({
    encodeData: mockEncodeData,
  })),
  NO_EXPIRATION: 0n,
}));

vi.mock("ethers", () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Wallet: vi.fn().mockImplementation(() => ({ address: "0xSIGNER" })),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attestEvidenceOnChain — oracle-client", () => {
  beforeEach(() => {
    // vi.clearAllMocks resets call history on ALL mocks registered via vi.mock
    // as well as the module-scope spies (mockAttest, mockEncodeData, etc.)
    vi.clearAllMocks();

    // Re-apply return values that clearAllMocks removed
    mockEncodeData.mockReturnValue("0xencoded_data");
    mockWait.mockResolvedValue("0xmock_eas_uid");
    mockAttest.mockResolvedValue({ wait: mockWait });

    process.env.PCC_RPC_URL = "https://sepolia.base.org";
    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    process.env.PCC_EVIDENCE_SCHEMA_UID = "0xschemauid";
  });

  it("encodes all 7 schema fields including stepId (C2b)", { timeout: 15000 }, async () => {
    const { attestEvidenceOnChain } = await import("../services/oracle-client.js");

    const input = {
      jobId: "job-eas-001",
      kernelId: "0xkernelid" as `0x${string}`,
      evidenceBundleHash: "0xbundlehash" as `0x${string}`,
      ipfsCid: "bafytest",
      assuranceTier: 1,
      stepId: "0xstepid" as `0x${string}`,
      recipient: "0xEscrowAddress" as `0x${string}`,
    };

    await attestEvidenceOnChain(input);

    expect(mockEncodeData).toHaveBeenCalledOnce();
    const fieldsArg: Array<{ name: string; value: unknown; type: string }> =
      mockEncodeData.mock.calls[0][0];

    const fieldNames = fieldsArg.map((f) => f.name);
    expect(fieldNames).toContain("jobId");
    expect(fieldNames).toContain("kernelId");
    expect(fieldNames).toContain("evidenceBundleHash");
    expect(fieldNames).toContain("ipfsCid");
    expect(fieldNames).toContain("assuranceTier");
    expect(fieldNames).toContain("oracleVerified");
    expect(fieldNames).toContain("stepId"); // C2b — must be present

    const jobIdField = fieldsArg.find((f) => f.name === "jobId");
    expect(jobIdField?.value).toBe(input.jobId);

    const oracleVerifiedField = fieldsArg.find((f) => f.name === "oracleVerified");
    expect(oracleVerifiedField?.value).toBe(true); // always true for on-chain path
  });

  it("passes recipient = escrowAddress (C2a), not gateway signer address", { timeout: 15000 }, async () => {
    const { attestEvidenceOnChain } = await import("../services/oracle-client.js");

    const escrowAddress = "0xEscrowV2ForThisJob" as `0x${string}`;
    await attestEvidenceOnChain({
      jobId: "job-eas-002",
      kernelId: "0xkernelid" as `0x${string}`,
      evidenceBundleHash: "0xbundlehash" as `0x${string}`,
      ipfsCid: "",
      assuranceTier: 2,
      stepId: "0xstepid" as `0x${string}`,
      recipient: escrowAddress,
    });

    // The EAS instance is created fresh in each attestEvidenceOnChain call
    // (not a module singleton), so mockAttest accumulates per-test.
    // After clearAllMocks in beforeEach, only 1 call should be present.
    expect(mockAttest).toHaveBeenCalledOnce();
    const attestCall = mockAttest.mock.calls[0][0];
    // data.recipient MUST be the ESCROW address, not the gateway signer
    expect(attestCall.data.recipient).toBe(escrowAddress);
  });

  it("returns the uid from tx.wait()", { timeout: 15000 }, async () => {
    const { attestEvidenceOnChain } = await import("../services/oracle-client.js");

    const { uid } = await attestEvidenceOnChain({
      jobId: "job-eas-003",
      kernelId: "0xkernelid" as `0x${string}`,
      evidenceBundleHash: "0xbundlehash" as `0x${string}`,
      ipfsCid: "",
      assuranceTier: 1,
      stepId: "0xstepid" as `0x${string}`,
      recipient: "0xEscrow" as `0x${string}`,
    });

    expect(uid).toBe("0xmock_eas_uid");
  });
});
