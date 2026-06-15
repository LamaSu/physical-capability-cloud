/**
 * Tests for the EAS batch-attestation client (P2-SCALE feature #3).
 *
 * Pure encoders/grouping run against real viem (encode → decode round-trip).
 * The on-chain write (multiAttestEAS) is proven via a mocked viem wallet client —
 * the same pattern the V2 settlement-wiring tests use — so we assert it dispatches
 * `multiAttest` to the EAS address with the right requests, through the nonce queue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeFunctionData, type Hex, type Address } from "viem";
import {
  EAS_MULTIATTEST_ABI,
  encodeMultiAttest,
  buildEvidenceMultiAttestRequest,
  groupEvidenceAttestationsBySchema,
  easMultiAttestEnabled,
  getEasAddress,
  type EvidenceAttestationItem,
} from "../contracts/eas-client.js";

const SCHEMA_A = ("0x" + "a1".repeat(32)) as Hex;
const SCHEMA_B = ("0x" + "b2".repeat(32)) as Hex;
const ESCROW_1 = ("0x" + "11".repeat(20)) as Address;
const ESCROW_2 = ("0x" + "22".repeat(20)) as Address;
const DATA_1 = ("0x" + "de") as Hex;
const DATA_2 = ("0x" + "ad") as Hex;

const EAS_PREDEPLOY = "0x4200000000000000000000000000000000000021";

describe("eas-client pure encoders", () => {
  it("buildEvidenceMultiAttestRequest applies EAS defaults (revocable, zero refUID/expiry/value)", () => {
    const req = buildEvidenceMultiAttestRequest(SCHEMA_A, [
      { recipient: ESCROW_1, data: DATA_1, schemaUid: SCHEMA_A },
    ]);
    expect(req.schema).toBe(SCHEMA_A);
    expect(req.data).toHaveLength(1);
    expect(req.data[0]).toEqual({
      recipient: ESCROW_1,
      expirationTime: 0n,
      revocable: true,
      refUID: ("0x" + "00".repeat(32)) as Hex,
      data: DATA_1,
      value: 0n,
    });
  });

  it("buildEvidenceMultiAttestRequest rejects a mismatched-schema item", () => {
    expect(() =>
      buildEvidenceMultiAttestRequest(SCHEMA_A, [
        { recipient: ESCROW_1, data: DATA_1, schemaUid: SCHEMA_B },
      ]),
    ).toThrow(/schema/i);
  });

  it("groupEvidenceAttestationsBySchema groups by schema, preserving order", () => {
    const items: EvidenceAttestationItem[] = [
      { recipient: ESCROW_1, data: DATA_1, schemaUid: SCHEMA_A },
      { recipient: ESCROW_2, data: DATA_2, schemaUid: SCHEMA_B },
      { recipient: ESCROW_2, data: DATA_1, schemaUid: SCHEMA_A },
    ];
    const groups = groupEvidenceAttestationsBySchema(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].schema).toBe(SCHEMA_A);
    expect(groups[0].data).toHaveLength(2); // both SCHEMA_A items
    expect(groups[1].schema).toBe(SCHEMA_B);
    expect(groups[1].data).toHaveLength(1);
  });

  it("encodeMultiAttest round-trips through viem decodeFunctionData", () => {
    const requests = groupEvidenceAttestationsBySchema([
      { recipient: ESCROW_1, data: DATA_1, schemaUid: SCHEMA_A },
      { recipient: ESCROW_2, data: DATA_2, schemaUid: SCHEMA_A },
    ]);
    const encoded = encodeMultiAttest(requests);
    const decoded = decodeFunctionData({ abi: EAS_MULTIATTEST_ABI, data: encoded });
    expect(decoded.functionName).toBe("multiAttest");
    const multiRequests = decoded.args[0] as ReadonlyArray<{
      schema: Hex;
      data: ReadonlyArray<{ recipient: Address; data: Hex; revocable: boolean }>;
    }>;
    expect(multiRequests).toHaveLength(1);
    expect(multiRequests[0].schema.toLowerCase()).toBe(SCHEMA_A.toLowerCase());
    expect(multiRequests[0].data).toHaveLength(2);
    expect(multiRequests[0].data[0].recipient.toLowerCase()).toBe(ESCROW_1.toLowerCase());
    expect(multiRequests[0].data[1].data).toBe(DATA_2);
    expect(multiRequests[0].data[0].revocable).toBe(true);
  });

  it("getEasAddress defaults to the OP-Stack EAS predeploy", () => {
    expect(getEasAddress().toLowerCase()).toBe(EAS_PREDEPLOY.toLowerCase());
    expect(getEasAddress(ESCROW_1)).toBe(ESCROW_1);
  });
});

describe("easMultiAttestEnabled flag", () => {
  const ORIG = process.env.PCC_EAS_MULTIATTEST;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PCC_EAS_MULTIATTEST;
    else process.env.PCC_EAS_MULTIATTEST = ORIG;
  });
  it("is opt-in (false unless explicitly enabled)", () => {
    delete process.env.PCC_EAS_MULTIATTEST;
    expect(easMultiAttestEnabled()).toBe(false);
    process.env.PCC_EAS_MULTIATTEST = "true";
    expect(easMultiAttestEnabled()).toBe(true);
  });
});

describe("multiAttestEAS on-chain dispatch (mocked wallet)", () => {
  const writeContract = vi.fn().mockResolvedValue("0x" + "f".repeat(64));
  const getTransactionCount = vi.fn().mockResolvedValue(3);
  const ORIG_PK = process.env.PCC_GATEWAY_PRIVATE_KEY;

  beforeEach(() => {
    vi.resetModules();
    writeContract.mockClear();
    getTransactionCount.mockClear();
    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({ getTransactionCount, readContract: vi.fn() }),
      };
    });
  });

  afterEach(() => {
    if (ORIG_PK === undefined) delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    else process.env.PCC_GATEWAY_PRIVATE_KEY = ORIG_PK;
    vi.doUnmock("viem");
  });

  it("dispatches multiAttest to the EAS address with a pinned nonce", async () => {
    const { multiAttestEAS, buildEvidenceMultiAttestRequest: build } = await import(
      "../contracts/eas-client.js"
    );
    const req = build(SCHEMA_A, [
      { recipient: ESCROW_1, data: DATA_1, schemaUid: SCHEMA_A },
      { recipient: ESCROW_2, data: DATA_2, schemaUid: SCHEMA_A },
    ]);
    const res = await multiAttestEAS([req]);

    expect(res.attestationCount).toBe(2);
    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("multiAttest");
    expect((call.address as string).toLowerCase()).toBe(EAS_PREDEPLOY.toLowerCase());
    expect(call.nonce).toBe(3); // pinned by the shared NonceManager
    expect(call.args[0]).toHaveLength(1); // one schema group
  });

  it("throws on an empty batch (no wasted tx/nonce)", async () => {
    const { multiAttestEAS } = await import("../contracts/eas-client.js");
    await expect(multiAttestEAS([])).rejects.toThrow(/no attestation/i);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("submitMilestoneAttestationsBatch skips when disabled, mints when enabled with >=2 items", async () => {
    const { submitMilestoneAttestationsBatch } = await import("../contracts/eas-client.js");
    const items: EvidenceAttestationItem[] = [
      { recipient: ESCROW_1, data: DATA_1, schemaUid: SCHEMA_A },
      { recipient: ESCROW_2, data: DATA_2, schemaUid: SCHEMA_A },
    ];

    delete process.env.PCC_EAS_MULTIATTEST;
    const skipped = await submitMilestoneAttestationsBatch(items);
    expect(skipped.skipped).toBe(true);
    expect(writeContract).not.toHaveBeenCalled();

    process.env.PCC_EAS_MULTIATTEST = "true";
    const minted = await submitMilestoneAttestationsBatch(items);
    expect(minted.skipped).toBe(false);
    expect(writeContract).toHaveBeenCalledTimes(1);
    delete process.env.PCC_EAS_MULTIATTEST;
  });

  it("submitMilestoneAttestationsBatch skips a single-item batch even when enabled", async () => {
    const { submitMilestoneAttestationsBatch } = await import("../contracts/eas-client.js");
    process.env.PCC_EAS_MULTIATTEST = "true";
    const res = await submitMilestoneAttestationsBatch([
      { recipient: ESCROW_1, data: DATA_1, schemaUid: SCHEMA_A },
    ]);
    expect(res.skipped).toBe(true);
    expect(writeContract).not.toHaveBeenCalled();
    delete process.env.PCC_EAS_MULTIATTEST;
  });
});
