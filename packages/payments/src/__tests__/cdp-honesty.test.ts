/**
 * WP-A round 5 (sol #2963 items 5-6; shell #3352, verifier-golf-2): the CDP clients never
 * present a mock as real, and a spend permission is never reported as issued or revoked
 * unless it was.
 *
 * - Real mode needs the COMPLETE credential tuple (it used to go real on apiKeyId alone).
 * - Every mock result says mock: true (a zero balance or a faucet hash used to look real).
 * - revoke() of an id this process does not know revokes nothing and throws 404. It used to
 *   answer revoked: true, which in real mode is every permission issued before a restart.
 * - issue() reads back THIS permission by its salt. It used to take the account's last
 *   permission (possibly an older one, so revoking that id left the new allowance live) or
 *   invent "0x"+UUID.
 *
 * Real-mode paths run against a FAKE @coinbase/cdp-sdk (vi.mock): nothing leaves the box.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => ({
  createSpendPermission: vi.fn(),
  listSpendPermissions: vi.fn(),
  revokeSpendPermission: vi.fn(),
  waitForUserOperation: vi.fn(),
}));

vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: class {
    evm = {
      createSpendPermission: sdk.createSpendPermission,
      listSpendPermissions: sdk.listSpendPermissions,
      revokeSpendPermission: sdk.revokeSpendPermission,
      waitForUserOperation: sdk.waitForUserOperation,
    };
  },
}));

import { CdpWalletClient, CdpOnrampClient, CdpSpendPermissionService } from "../cdp/index.js";

const FULL = { apiKeyId: "key-id", apiKeySecret: "key-secret", walletSecret: "wallet-secret" };
const ACCT = "0x2222222222222222222222222222222222222222" as const;
const SPENDER = "0x3333333333333333333333333333333333333333" as const;
const HASH_NEW = "0x" + "a".repeat(64);
const HASH_OLD = "0x" + "b".repeat(64);

const TX = "0x" + "d".repeat(64);
beforeEach(() => {
  sdk.createSpendPermission.mockReset();
  sdk.listSpendPermissions.mockReset();
  sdk.revokeSpendPermission.mockReset();
  sdk.waitForUserOperation.mockReset();
  // By default a submitted user operation COMPLETES; tests override it.
  sdk.revokeSpendPermission.mockResolvedValue({ userOpHash: "0x" + "e".repeat(64) });
  sdk.waitForUserOperation.mockImplementation(async (o: { userOpHash: string; smartAccountAddress: string }) => ({
    status: "complete",
    transactionHash: TX,
    userOpHash: o.userOpHash,
    smartAccountAddress: o.smartAccountAddress,
  }));
});

describe("real mode needs the full credential tuple", () => {
  it.each<[string, Record<string, string>]>([
    ["no credentials", {}],
    ["only apiKeyId", { apiKeyId: "key-id" }],
    ["no walletSecret", { apiKeyId: "key-id", apiKeySecret: "key-secret" }],
    ["no apiKeySecret", { apiKeyId: "key-id", walletSecret: "wallet-secret" }],
    ["a blank apiKeySecret", { ...FULL, apiKeySecret: "   " }],
  ])("[neg] %s: all three clients stay mock", (_name, cfg) => {
    expect(new CdpWalletClient(cfg).isMock).toBe(true);
    expect(new CdpOnrampClient(cfg).isMock).toBe(true);
    expect(new CdpSpendPermissionService(cfg).isMock).toBe(true);
  });

  it("control: the full tuple is real for all three", () => {
    expect(new CdpWalletClient(FULL).isMock).toBe(false);
    expect(new CdpOnrampClient(FULL).isMock).toBe(false);
    expect(new CdpSpendPermissionService(FULL).isMock).toBe(false);
  });
});

describe("every mock result says mock: true", () => {
  it("[neg] wallet, balance and faucet: no ordinary-looking zero, no fabricated hash", async () => {
    const c = new CdpWalletClient();
    expect(await c.createWallet()).toMatchObject({ mock: true });
    expect(await c.getBalance(ACCT)).toMatchObject({ usdc: 0, mock: true });
    expect(await c.requestFaucet(ACCT)).toEqual({ transactionHash: null, mock: true });
  });

  it("[neg] an onramp session and a spend permission are marked", async () => {
    const s = await new CdpOnrampClient().createSession({ destinationAddress: ACCT });
    expect(s.mock).toBe(true);
    const svc = new CdpSpendPermissionService();
    const perm = await svc.issue({ account: ACCT, spender: SPENDER, allowanceUSDC: 5, periodSec: 3600 });
    expect(perm.mock).toBe(true);
    expect(await svc.revoke(perm.permissionId)).toEqual({ permissionId: perm.permissionId, revoked: true, mock: true });
  });
});

describe("revoke never claims what it did not do", () => {
  it("[neg] mock mode: an unknown id is 404 unknown_permission", async () => {
    await expect(new CdpSpendPermissionService().revoke("cdp_spendperm_never-issued")).rejects.toMatchObject({
      code: "unknown_permission",
      statusCode: 404,
    });
  });

  it("[neg] real mode: an id this process never issued (e.g. before a restart) is 404, and nothing is sent", async () => {
    const svc = new CdpSpendPermissionService(FULL);
    await expect(svc.revoke(HASH_OLD)).rejects.toMatchObject({ code: "unknown_permission", statusCode: 404 });
    expect(sdk.revokeSpendPermission).not.toHaveBeenCalled();
  });
});

/** The fake SDK: record the salt of each created permission, list what the test says. */
function fakeChain(listFor: (createdSalt: bigint | undefined) => unknown[]) {
  let createdSalt: bigint | undefined;
  sdk.createSpendPermission.mockImplementation(async (opts: { spendPermission: { salt?: bigint } }) => {
    createdSalt = opts.spendPermission.salt;
    return { userOpHash: "0x" + "c".repeat(64) };
  });
  sdk.listSpendPermissions.mockImplementation(async () => ({ spendPermissions: listFor(createdSalt) }));
}

describe("issue identifies THIS permission, never an invented or older one", () => {
  it("[neg] the account already has an older permission listed LAST: the id is still the new one", async () => {
    fakeChain((salt) => [
      { permissionHash: HASH_NEW, revoked: false, permission: { spender: SPENDER, allowance: 5_000_000n, period: 3600, salt } },
      { permissionHash: HASH_OLD, revoked: false, permission: { spender: SPENDER, allowance: 5_000_000n, period: 3600, salt: 7n } },
    ]);
    const svc = new CdpSpendPermissionService(FULL);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const perm = await svc.issue({ account: ACCT, spender: SPENDER, allowanceUSDC: 5, periodSec: 3600, expiresAt });
    expect(perm.permissionId).toBe(HASH_NEW);
    expect(perm.mock).toBeUndefined();

    // The on-chain permission carries a fresh salt and the reported expiry as its end.
    const sent = sdk.createSpendPermission.mock.calls[0]![0].spendPermission;
    expect(typeof sent.salt).toBe("bigint");
    expect(sent.end).toBeInstanceOf(Date);
    expect((sent.end as Date).toISOString()).toBe(expiresAt);

    // Revoking that id revokes the NEW permission, on the right account, once confirmed.
    expect(await svc.revoke(perm.permissionId)).toEqual({ permissionId: HASH_NEW, revoked: true, transactionHash: TX });
    expect(sdk.revokeSpendPermission).toHaveBeenCalledWith(
      expect.objectContaining({ address: ACCT, permissionHash: HASH_NEW }),
    );
  });

  it(
    "[neg] when the new permission cannot be read back: 502 spend_permission_unconfirmed, no invented id, nothing cached",
    async () => {
      fakeChain(() => [
        { permissionHash: HASH_OLD, revoked: false, permission: { spender: SPENDER, allowance: 5_000_000n, period: 3600, salt: 7n } },
      ]);
      const svc = new CdpSpendPermissionService(FULL);
      await expect(
        svc.issue({ account: ACCT, spender: SPENDER, allowanceUSDC: 5, periodSec: 3600 }),
      ).rejects.toMatchObject({ code: "spend_permission_unconfirmed", statusCode: 502 });
      // Nothing was cached under the old permission's hash or any invented one.
      await expect(svc.revoke(HASH_OLD)).rejects.toMatchObject({ statusCode: 404 });
      expect(sdk.revokeSpendPermission).not.toHaveBeenCalled();
    },
    15_000,
  );

  it.each<[string, Record<string, unknown>]>([
    ["a zero allowance", { allowanceUSDC: 0 }],
    ["a negative allowance", { allowanceUSDC: -5 }],
    ["a NaN allowance", { allowanceUSDC: Number.NaN }],
    ["a fractional period", { periodSec: 1.5 }],
    ["a zero period", { periodSec: 0 }],
    ["an expiry in the past", { expiresAt: "2001-01-01T00:00:00Z" }],
    ["an unparseable expiry", { expiresAt: "next tuesday" }],
  ])("[neg] %s is 400 invalid_spend_permission and nothing is sent", async (_name, patch) => {
    for (const svc of [new CdpSpendPermissionService(), new CdpSpendPermissionService(FULL)]) {
      await expect(
        svc.issue({ account: ACCT, spender: SPENDER, allowanceUSDC: 5, periodSec: 3600, ...patch } as never),
      ).rejects.toMatchObject({ code: "invalid_spend_permission", statusCode: 400 });
    }
    expect(sdk.createSpendPermission).not.toHaveBeenCalled();
  });
});

describe("list reports the chain's facts", () => {
  it("[neg] skips an entry with no hash and reports revoked and the window from the chain", async () => {
    sdk.listSpendPermissions.mockResolvedValue({
      spendPermissions: [
        { revoked: false, permission: { spender: SPENDER, allowance: 1n, period: 60 } },
        {
          permissionHash: HASH_OLD,
          revoked: true,
          permission: { spender: SPENDER, allowance: 2_000_000n, period: 60, start: 1_700_000_000, end: 1_800_000_000 },
        },
      ],
    });
    const list = await new CdpSpendPermissionService(FULL).list(ACCT);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      permissionId: HASH_OLD,
      revoked: true,
      allowanceUSDC: 2,
      start: new Date(1_700_000_000 * 1000).toISOString(),
      expiresAt: new Date(1_800_000_000 * 1000).toISOString(),
    });
  });

  it("follows pagination", async () => {
    sdk.listSpendPermissions
      .mockResolvedValueOnce({ spendPermissions: [{ permissionHash: HASH_NEW, permission: {} }], nextPageToken: "p2" })
      .mockResolvedValueOnce({ spendPermissions: [{ permissionHash: HASH_OLD, permission: {} }] });
    const list = await new CdpSpendPermissionService(FULL).list(ACCT);
    expect(list.map((p) => p.permissionId)).toEqual([HASH_NEW, HASH_OLD]);
    expect(sdk.listSpendPermissions).toHaveBeenLastCalledWith({ address: ACCT, pageToken: "p2" });
  });
});

describe("round 8 (astra failclosed r2 FC-6 and new defect 4)", () => {
  it("[neg] cfg.mock: false cannot force real mode without the full credential tuple", () => {
    for (const cfg of [{ mock: false }, { mock: false, apiKeyId: "key-id" }, { mock: false, apiKeyId: "key-id", apiKeySecret: "key-secret" }]) {
      expect(new CdpWalletClient(cfg).isMock, JSON.stringify(cfg)).toBe(true);
      expect(new CdpOnrampClient(cfg).isMock).toBe(true);
      expect(new CdpSpendPermissionService(cfg).isMock).toBe(true);
    }
  });

  it("control: cfg.mock: true still forces mock, even with the full tuple", () => {
    expect(new CdpWalletClient({ ...FULL, mock: true }).isMock).toBe(true);
    expect(new CdpWalletClient({ ...FULL, mock: false }).isMock).toBe(false);
  });

  it("[neg] a listing that still has pages after the cap is refused (502), never returned as the whole list", async () => {
    sdk.listSpendPermissions.mockImplementation(async (opts: { pageToken?: string }) => ({
      spendPermissions: [{ permissionHash: "0x" + (opts.pageToken ?? "p0").replace(/\D/g, "").padStart(64, "0"), permission: {} }],
      nextPageToken: `p${Number((opts.pageToken ?? "p0").slice(1)) + 1}`,
    }));
    await expect(new CdpSpendPermissionService(FULL).list(ACCT)).rejects.toMatchObject({
      code: "spend_permission_list_incomplete",
      statusCode: 502,
    });
  });
});

describe("submission is not confirmation (round 8, astra failclosed r2: SDK submission-versus-confirmation)", () => {
  async function issued() {
    fakeChain((salt) => [{ permissionHash: HASH_NEW, revoked: false, permission: { spender: SPENDER, allowance: 5_000_000n, period: 3600, salt } }]);
    const svc = new CdpSpendPermissionService(FULL);
    const perm = await svc.issue({ account: ACCT, spender: SPENDER, allowanceUSDC: 5, periodSec: 3600 });
    return { svc, perm };
  }

  it("[neg] a revoke whose user operation FAILED is an error, and the permission stays unrevoked", async () => {
    const { svc, perm } = await issued();
    sdk.waitForUserOperation.mockResolvedValueOnce({ status: "failed", userOpHash: "0x" + "e".repeat(64) });
    await expect(svc.revoke(perm.permissionId)).rejects.toMatchObject({ code: "user_operation_failed", statusCode: 502 });
    expect((await svc.get(perm.permissionId))?.revoked).toBe(false);
  });

  it("[neg] a revoke that is submitted but never confirmed is NOT reported as revoked", async () => {
    const { svc, perm } = await issued();
    sdk.waitForUserOperation.mockRejectedValueOnce(new Error("timed out"));
    await expect(svc.revoke(perm.permissionId)).rejects.toMatchObject({ code: "revoke_unconfirmed", statusCode: 502 });
    expect((await svc.get(perm.permissionId))?.revoked).toBe(false);
  });

  it("[neg] an issue whose user operation was DROPPED is an error, and nothing is cached", async () => {
    fakeChain(() => []);
    sdk.waitForUserOperation.mockResolvedValueOnce({ status: "dropped", userOpHash: "0x" + "c".repeat(64) });
    const svc = new CdpSpendPermissionService(FULL);
    await expect(svc.issue({ account: ACCT, spender: SPENDER, allowanceUSDC: 5, periodSec: 3600 })).rejects.toMatchObject({
      code: "user_operation_failed",
      statusCode: 502,
    });
    expect(sdk.listSpendPermissions).not.toHaveBeenCalled();
  });

  it("[neg] an issue whose confirmation TIMES OUT is an error, even when a matching permission is listed; nothing cached (astra pack 58)", async () => {
    // The listing is not confirmation: it can show a permission whose user operation
    // never completed. Issue succeeds only on a COMPLETED user operation.
    fakeChain((salt) => [{ permissionHash: HASH_NEW, revoked: false, permission: { spender: SPENDER, allowance: 5_000_000n, period: 3600, salt } }]);
    sdk.waitForUserOperation.mockRejectedValueOnce(new Error("timed out"));
    const svc = new CdpSpendPermissionService(FULL);
    await expect(svc.issue({ account: ACCT, spender: SPENDER, allowanceUSDC: 5, periodSec: 3600 })).rejects.toMatchObject({
      code: "spend_permission_unconfirmed",
      statusCode: 502,
    });
    await expect(svc.revoke(HASH_NEW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("control: a confirmed revoke returns its transaction hash", async () => {
    const { svc, perm } = await issued();
    expect(await svc.revoke(perm.permissionId)).toEqual({ permissionId: HASH_NEW, revoked: true, transactionHash: TX });
    expect(sdk.waitForUserOperation).toHaveBeenLastCalledWith(expect.objectContaining({ smartAccountAddress: ACCT }));
  });
});
