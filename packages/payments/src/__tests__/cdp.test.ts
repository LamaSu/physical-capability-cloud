import { describe, it, expect } from "vitest";
import {
  CdpWalletClient,
  CdpOnrampClient,
  CdpSpendPermissionService,
  CustodyViolationError,
  UserOwnedWalletRegistry,
  assertServerManaged,
} from "../cdp/index.js";

describe("CDP funded-key on-ramp (mock mode)", () => {
  it("createWallet returns a smart-wallet address on base-sepolia", async () => {
    const c = new CdpWalletClient();
    expect(c.isMock).toBe(true);
    const w = await c.createWallet();
    expect(w.address).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(w.smartAccount).toBe(true);
    expect(w.network).toBe("base-sepolia");
  });

  it("createWallet defaults to custodyMode 'server-test-only' (never mislabels a server wallet)", async () => {
    const w = await new CdpWalletClient().createWallet();
    expect(w.custodyMode).toBe("server-test-only");
  });

  it("REFUSES a server-test-only wallet on mainnet (server-managed wallets are Base Sepolia only)", async () => {
    const c = new CdpWalletClient({ network: "base" });
    await expect(c.createWallet({ custodyMode: "server-test-only" })).rejects.toThrow(/Base Sepolia only/);
    await expect(c.createWallet()).rejects.toThrow(/Base Sepolia only/); // default is server-test-only
  });

  it("ALLOWS a deliberately PCC-controlled 'treasury' wallet on mainnet", async () => {
    const w = await new CdpWalletClient({ network: "base" }).createWallet({ custodyMode: "treasury" });
    expect(w.custodyMode).toBe("treasury");
    expect(w.network).toBe("base");
  });

  it("createSession returns a fundable onramp URL for the destination address", async () => {
    const c = new CdpOnrampClient();
    const dest = "0x1111111111111111111111111111111111111111" as const;
    const s = await c.createSession({ destinationAddress: dest, presetAmountUSD: 25 });
    expect(s.onrampUrl).toContain(dest);
    expect(s.onrampUrl).toContain("USDC");
    expect(s.asset).toBe("USDC");
    expect(s.status).toBe("created");
  });

  it("issues a scoped, revocable spend-permission and never leaks a raw key", async () => {
    const svc = new CdpSpendPermissionService();
    const perm = await svc.issue({
      account: "0x2222222222222222222222222222222222222222",
      spender: "0x3333333333333333333333333333333333333333",
      allowanceUSDC: 50,
      periodSec: 86_400,
    });
    expect(perm.permissionId).toMatch(/^cdp_spendperm_/);
    expect(perm.allowance).toBe("50000000"); // 50 USDC * 1e6
    expect(perm.token).toBe("USDC");
    expect(perm.revoked).toBe(false);
    // Custody invariant: the issued object carries NO private key / seed / secret.
    expect(JSON.stringify(perm)).not.toMatch(/private|secret|mnemonic|seed/i);

    const got = await svc.get(perm.permissionId);
    expect(got?.permissionId).toBe(perm.permissionId);

    const rev = await svc.revoke(perm.permissionId);
    expect(rev.revoked).toBe(true);
    expect((await svc.get(perm.permissionId))?.revoked).toBe(true);
  });

  it("lists permissions scoped to the funding account", async () => {
    const svc = new CdpSpendPermissionService();
    const acct = "0x4444444444444444444444444444444444444444" as const;
    await svc.issue({
      account: acct,
      spender: "0x5555555555555555555555555555555555555555",
      allowanceUSDC: 10,
      periodSec: 3_600,
    });
    const list = await svc.list(acct);
    expect(list.length).toBe(1);
    expect(list[0]!.account.toLowerCase()).toBe(acct.toLowerCase());
    // a different account sees nothing
    expect((await svc.list("0x6666666666666666666666666666666666666666")).length).toBe(0);
  });
});

describe("user-owned wallet foundation (noncustodial human onramp — audit F1 / H-12)", () => {
  const SPENDER = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1" as const;

  it("registers a user-owned wallet by address only: custodyMode 'user-owned', smart account, NO secret", async () => {
    const c = new CdpWalletClient();
    const addr = "0x1234567890abcdef1234567890abcdef12345678" as const;
    const w = await c.registerUserOwnedWallet({ address: addr });
    expect(w.custodyMode).toBe("user-owned");
    expect(w.address).toBe(addr);
    expect(w.smartAccount).toBe(true);
    expect(w.network).toBe("base-sepolia");
    // structural custody guarantee: no signing material anywhere on the returned wallet
    expect(JSON.stringify(w)).not.toMatch(/private|secret|mnemonic|seed/i);
    expect(w).not.toHaveProperty("privateKey");
    expect(w).not.toHaveProperty("walletSecret");
    expect(w).not.toHaveProperty("owner");
  });

  it("stores a non-secret authProviderRef when given, and still holds no key", async () => {
    const w = await new CdpWalletClient().registerUserOwnedWallet({
      address: "0x2222222222222222222222222222222222222222",
      authProviderRef: "cdp-embedded-user-abc123",
    });
    expect(w.authProviderRef).toBe("cdp-embedded-user-abc123");
    expect(JSON.stringify(w)).not.toMatch(/private|secret|mnemonic|seed/i);
  });

  it("rejects a malformed address (validates shape)", async () => {
    const c = new CdpWalletClient();
    await expect(c.registerUserOwnedWallet({ address: "0xnothexnothexnothexnothexnothexnothexnope" })).rejects.toThrow(
      CustodyViolationError,
    );
    await expect(
      c.registerUserOwnedWallet({ address: "1234567890abcdef1234567890abcdef12345678" }),
    ).rejects.toThrow(/address shape/i); // missing 0x
    await expect(c.registerUserOwnedWallet({ address: "0x1234" })).rejects.toThrow(/address shape/i); // too short
  });

  it("registration is idempotent for the same (address, ref); a conflicting ref is refused", async () => {
    const c = new CdpWalletClient();
    const addr = "0x3333333333333333333333333333333333333333" as const;
    await c.registerUserOwnedWallet({ address: addr, authProviderRef: "ref-1" });
    await expect(c.registerUserOwnedWallet({ address: addr, authProviderRef: "ref-1" })).resolves.toBeDefined();
    await expect(c.registerUserOwnedWallet({ address: addr, authProviderRef: "ref-2" })).rejects.toThrow(
      /already registered/i,
    );
  });

  it("lookup helpers reflect registration and are case-insensitive; records carry no key", async () => {
    const c = new CdpWalletClient();
    const addr = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
    expect(c.isUserOwned(addr)).toBe(false);
    await c.registerUserOwnedWallet({ address: addr, authProviderRef: "u-4" });
    expect(c.isUserOwned(addr)).toBe(true);
    expect(c.isUserOwned("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD")).toBe(true); // case-insensitive
    expect(c.getUserOwnedWallet(addr)?.authProviderRef).toBe("u-4");
    expect(c.getUserOwnedWallet(addr)).not.toHaveProperty("privateKey");
    expect(c.listUserOwnedWallets().length).toBe(1);
  });

  it("SIGN GUARD: refuses to sign as a user-owned wallet — by object type and by registered address", async () => {
    const c = new CdpWalletClient();
    const uo = await c.registerUserOwnedWallet({ address: "0x5555555555555555555555555555555555555555" });
    expect(() => c.assertCanSign(uo)).toThrow(CustodyViolationError); // typed guard
    expect(() => c.assertCanSign(uo, "sign transaction")).toThrow(/user-owned/i);
    expect(() => c.assertCanSign(uo.address)).toThrow(CustodyViolationError); // address-lookup guard
  });

  it("SIGN GUARD: permits signing for a server-managed wallet and an unregistered address", async () => {
    const c = new CdpWalletClient();
    const server = await c.createWallet(); // server-test-only on base-sepolia
    expect(() => c.assertCanSign(server)).not.toThrow();
    expect(() => c.assertCanSign("0x7777777777777777777777777777777777777777")).not.toThrow();
  });

  it("ROTATION GUARD: no owner-rotation path exists for a user-owned wallet", async () => {
    const c = new CdpWalletClient();
    const uo = await c.registerUserOwnedWallet({ address: "0x8888888888888888888888888888888888888888" });
    expect(() => c.assertNoOwnerRotation(uo)).toThrow(/rotat/i);
    expect(() => c.assertNoOwnerRotation(uo.address)).toThrow(CustodyViolationError);
    const server = await c.createWallet();
    expect(() => c.assertNoOwnerRotation(server)).not.toThrow();
    // there is literally no rotate-owner method to call
    expect((c as unknown as Record<string, unknown>).rotateOwner).toBeUndefined();
  });

  it("createWallet CANNOT mint a user-owned wallet (runtime guard for untyped callers)", async () => {
    const c = new CdpWalletClient();
    await expect(
      (c.createWallet as unknown as (o: unknown) => Promise<unknown>)({ custodyMode: "user-owned" }),
    ).rejects.toThrow(/cannot mint a user-owned/i);
    expect(() => assertServerManaged("user-owned")).toThrow(CustodyViolationError);
    expect(() => assertServerManaged("treasury")).not.toThrow();
    expect(() => assertServerManaged("server-test-only")).not.toThrow();
  });

  it("SUBSTITUTION GUARD: a shared registry stops a server signer standing in for a user-owned wallet", async () => {
    const registry = new UserOwnedWalletRegistry();
    const wallets = new CdpWalletClient({}, { userOwnedRegistry: registry });
    const spend = new CdpSpendPermissionService({}, { userOwnedRegistry: registry });
    const userAddr = "0x9999999999999999999999999999999999999999" as const;
    await wallets.registerUserOwnedWallet({ address: userAddr });

    // PCC cannot issue a spend permission FROM a user-owned account (it can't sign for it)
    await expect(
      spend.issue({ account: userAddr, spender: SPENDER, allowanceUSDC: 25, periodSec: 3600 }),
    ).rejects.toThrow(CustodyViolationError);
    await expect(
      spend.issue({ account: userAddr, spender: SPENDER, allowanceUSDC: 25, periodSec: 3600 }),
    ).rejects.toThrow(/user-owned/i);

    // a normal (non-user-owned) account still issues fine — nothing else changes
    const perm = await spend.issue({
      account: "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
      spender: SPENDER,
      allowanceUSDC: 10,
      periodSec: 3600,
    });
    expect(perm.revoked).toBe(false);
    expect(perm.allowance).toBe("10000000");
  });

  it("server-managed wallets are unchanged when a shared registry is wired", async () => {
    const registry = new UserOwnedWalletRegistry();
    const c = new CdpWalletClient({}, { userOwnedRegistry: registry });
    const w = await c.createWallet();
    expect(w.custodyMode).toBe("server-test-only");
    expect(w.network).toBe("base-sepolia");
    expect(() => c.assertCanSign(w)).not.toThrow();
    // spend-permission service with no registry behaves exactly as before (no guard)
    const perm = await new CdpSpendPermissionService().issue({
      account: "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
      spender: SPENDER,
      allowanceUSDC: 5,
      periodSec: 3600,
    });
    expect(perm.revoked).toBe(false);
  });
});
