import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, schema } from "@pcc/store";
import { getAddress } from "viem";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { BUYER_FUNDED_ESCROW_VERSION } from "../services/buyer-funded-escrow.js";
import { escrowDriveReads, resolveEscrowDrive } from "../services/escrow-drive-gate.js";

const A = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const A_SUM = getAddress(A);
const A_MIX = "0xaBcdefabcdefabcdefabcdefabcdefabcdefabcd";
const B = "0x1234567890abcdef1234567890abcdef12345678";
const CWM = "cwm-gate";
const refused = (reason: string) => ({ drive: false, reason });

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  initStore({ seed: false });
  expect(new Set([A, A_SUM, A_MIX]).size).toBe(3);
});
afterEach(() => {
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function seed(id: string, address = A, version?: string | null, cwmId = CWM) {
  getRepos().escrows.insert({
    id, cwmId, contractAddress: address, ...(version !== undefined ? { version } : {}),
    payer: B, totalAmount: "10", currency: "USDC", status: "funded",
    createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

it.each(["v3", "v2", null, undefined])('EG1 one row at the address drives v3 for "v3" and v2 for "v2" or null: %s', version => {
  seed("one", A, version);
  expect(getRepos().escrows.findById("one")!.version).toBe(version === undefined ? "v2" : version);
  for (const cwmId of [CWM, null]) {
    expect(resolveEscrowDrive({ cwmId, address: A })).toStrictEqual({ drive: true, version: version === "v3" ? "v3" : "v2" });
  }
});

it('EG1 one row at the address drives v3 for "v3" and v2 for "v2" or null: undefined read version', () => {
  seed("one");
  const row = escrowDriveReads.rowsAtAddress(A)[0];
  vi.spyOn(escrowDriveReads, "rowsAtAddress").mockReturnValue([{ ...row, version: undefined } as any]);
  expect(resolveEscrowDrive({ cwmId: CWM, address: A })).toStrictEqual({ drive: true, version: "v2" });
});

it("EG2 a buyer-funded row is refused as escrow_buyer_funded", () => {
  seed("buyer", A, BUYER_FUNDED_ESCROW_VERSION);
  expect(resolveEscrowDrive({ cwmId: CWM, address: A })).toStrictEqual(refused("escrow_buyer_funded"));
});

it.each(["v9", "", "V2", "V3", "v4"])("EG3 any other version is refused as escrow_version_unknown: %s", version => {
  seed("unknown", A, version);
  expect(resolveEscrowDrive({ cwmId: CWM, address: A })).toStrictEqual(refused("escrow_version_unknown"));
});

it.each(["empty table", "another address", "empty address", "null address", "undefined address", "non-string address"])(
  "EG4 no row at the address is refused as escrow_row_missing: %s", name => {
    if (name === "another address") seed("other", B, "v2");
    const address = name === "empty address" ? "" : name === "null address" ? null
      : name === "undefined address" ? undefined : name === "non-string address" ? 123 : A;
    const read = vi.spyOn(escrowDriveReads, "rowsAtAddress");
    expect(resolveEscrowDrive({ cwmId: CWM, address: address as string })).toStrictEqual(refused("escrow_row_missing"));
    expect(read).toHaveBeenCalledTimes(address === A ? 1 : 0);
  },
);

it.each(["v2", "v3"])("EG5 two rows on the cwm are refused as escrow_rows_ambiguous, whatever the address finds: %s", version => {
  seed("first", A, version);
  seed("second", B, "v2");
  const read = vi.spyOn(escrowDriveReads, "rowsAtAddress");
  expect(escrowDriveReads.rowsOnCwm(CWM)).toHaveLength(2);
  for (const address of [A, "0x" + "00".repeat(20), ""]) {
    expect(resolveEscrowDrive({ cwmId: CWM, address })).toStrictEqual(refused("escrow_rows_ambiguous"));
  }
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([A_SUM, A_MIX, A])("EG6 two rows at the address in any spelling are refused as escrow_rows_ambiguous: %s", second => {
  seed("first", A, "v2", "cwm-first");
  seed("second", second, "v3", "cwm-second");
  for (const address of [A, A_SUM, A_MIX]) {
    expect(escrowDriveReads.rowsAtAddress(address)).toHaveLength(2);
    expect(resolveEscrowDrive({ cwmId: "cwm-first", address })).toStrictEqual(refused("escrow_rows_ambiguous"));
  }
});

it.each(["v3", "v2"])("EG7 the address matches its row in every letter case: %s", version => {
  seed("case", version === "v3" ? A_SUM : A, version);
  for (const address of [A, A_SUM, A_MIX]) {
    expect(resolveEscrowDrive({ cwmId: CWM, address })).toStrictEqual({ drive: true, version });
  }
});

it.each(["v2", "v3"])("EG8 a read that throws is refused as escrow_lookup_unavailable: %s", version => {
  seed("good", A, version);
  const cwmRead = vi.spyOn(escrowDriveReads, "rowsOnCwm");
  const addressRead = vi.spyOn(escrowDriveReads, "rowsAtAddress");
  try {
    cwmRead.mockImplementationOnce(() => { throw new Error("cwm read unavailable"); });
    expect(resolveEscrowDrive({ cwmId: CWM, address: A })).toStrictEqual(refused("escrow_lookup_unavailable"));
    addressRead.mockImplementationOnce(() => { throw new Error("address read unavailable"); });
    expect(resolveEscrowDrive({ cwmId: CWM, address: A })).toStrictEqual(refused("escrow_lookup_unavailable"));
    expect(cwmRead.mock.invocationCallOrder[1]).toBeLessThan(addressRead.mock.invocationCallOrder[0]);
    // Lookup failure takes precedence over an ambiguous cwm or a missing address row.
    seed("second", B, "v2");
    addressRead.mockImplementationOnce(() => { throw new Error("ambiguous cwm read unavailable"); });
    expect(resolveEscrowDrive({ cwmId: CWM, address: A })).toStrictEqual(refused("escrow_lookup_unavailable"));
    cwmRead.mockImplementationOnce(() => { throw new Error("missing address read unavailable"); });
    expect(resolveEscrowDrive({ cwmId: CWM, address: "" })).toStrictEqual(refused("escrow_lookup_unavailable"));
  } finally {
    cwmRead.mockRestore();
    addressRead.mockRestore();
  }
});

it.each(["v2", "v3"])("EG7 the address matches its row in every letter case: address row version with a different cwm row, %s", version => {
  seed("cwm-row", B, version === "v3" ? "v2" : "v3");
  seed("address-row", A_SUM, version, "cwm-other");
  expect(resolveEscrowDrive({ cwmId: CWM, address: A_MIX })).toStrictEqual({ drive: true, version });
});

it.each([null, undefined, ""])("EG9 a null, undefined or empty cwm id skips the cwm read and still resolves by the address: %s", cwmId => {
  seed("good", A, "v3");
  const read = vi.spyOn(escrowDriveReads, "rowsOnCwm");
  expect(resolveEscrowDrive({ cwmId, address: A })).toStrictEqual({ drive: true, version: "v3" });
  expect(read).not.toHaveBeenCalled();
});

it("EG9 a null, undefined or empty cwm id skips the cwm read and still resolves by the address: cwm equality is exact", () => {
  seed("first", A, "v3");
  seed("second", B, "v2", CWM.toUpperCase());
  expect(escrowDriveReads.rowsOnCwm(CWM).map(row => row.id)).toStrictEqual(["first"]);
  expect(escrowDriveReads.rowsOnCwm(CWM.toUpperCase()).map(row => row.id)).toStrictEqual(["second"]);
  expect(resolveEscrowDrive({ cwmId: CWM, address: A })).toStrictEqual({ drive: true, version: "v3" });
  getStore().db.update(schema.escrows).set({ version: "v2" }).where(eq(schema.escrows.id, "first")).run();
  expect(resolveEscrowDrive({ cwmId: "missing-cwm", address: A })).toStrictEqual({ drive: true, version: "v2" });
});
