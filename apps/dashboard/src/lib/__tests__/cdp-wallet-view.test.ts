import { describe, it, expect } from "vitest";
import { canFundByCard, walletLabel, walletRequestRef, type CdpWallet } from "../cdp-wallet-view.js";

const LIVE: CdpWallet = { walletAddress: "0x" + "ab".repeat(20), network: "base", smartAccount: true };
// The gateway's demo answer since #373 round 3: no address, a reference instead.
const DEMO: CdpWallet = {
  walletAddress: null,
  demoWalletRef: "demo-wallet-0123456789abcdef",
  network: "base-sepolia",
  smartAccount: true,
  mock: true,
};

describe("the funded-key onramp names a wallet the way the gateway does", () => {
  it("a live wallet by its address", () => {
    expect(walletRequestRef(LIVE)).toEqual({ walletAddress: LIVE.walletAddress });
    expect(canFundByCard(LIVE)).toBe(true);
    expect(walletLabel(LIVE)).toBe(LIVE.walletAddress);
  });

  it("NEGATIVE: a demo wallet by its reference, never a null address (a null walletAddress is a 400)", () => {
    expect(walletRequestRef(DEMO)).toEqual({ walletRef: "demo-wallet-0123456789abcdef" });
    expect(walletRequestRef(DEMO)).not.toHaveProperty("walletAddress");
  });

  it("NEGATIVE: nothing offers to pay into a demo wallet, and its label says it has no address", () => {
    expect(canFundByCard(DEMO)).toBe(false);
    expect(walletLabel(DEMO)).toBe("demo-wallet-0123456789abcdef (demo: no address)");
  });

  it("a wallet with neither is named by nothing and cannot be funded", () => {
    const none: CdpWallet = { walletAddress: null, network: "base", smartAccount: true };
    expect(walletRequestRef(none)).toBeNull();
    expect(canFundByCard(none)).toBe(false);
    expect(walletRequestRef({ ...none, walletAddress: "  " })).toBeNull();
  });
});
