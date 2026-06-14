import { describe, it, expect } from "vitest";
import {
  CdpWalletClient,
  CdpOnrampClient,
  CdpSpendPermissionService,
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
