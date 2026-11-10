import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { deployments, storyMainnet, storyAeneid } from "../chain-config.js";

describe("DATA Network chain configuration", () => {
  it("uses the mainnet and Aeneid chain IDs", () => {
    expect(storyMainnet.id).toBe(1514);
    expect(storyAeneid.id).toBe(1315);
    expect(storyAeneid.testnet).toBe(true);
  });

  it("uses DATA as the native currency on both chains", () => {
    for (const chain of [storyMainnet, storyAeneid]) {
      expect(chain.nativeCurrency).toEqual({ name: "DATA", symbol: "DATA", decimals: 18 });
    }
  });

  it("uses the official default and public RPC URLs", () => {
    expect(storyMainnet.rpcUrls.default.http).toEqual(["https://mainnet.datarpc.io"]);
    expect(storyMainnet.rpcUrls.public.http).toEqual(["https://mainnet.datarpc.io"]);
    expect(storyAeneid.rpcUrls.default.http).toEqual(["https://aeneid.datarpc.io"]);
    expect(storyAeneid.rpcUrls.public.http).toEqual(["https://aeneid.datarpc.io"]);
  });

  it("uses the official explorer URLs", () => {
    expect(storyMainnet.blockExplorers.default.url).toBe("https://datanetscan.io");
    expect(storyAeneid.blockExplorers.default.url).toBe("https://aeneid.datanetscan.io");
  });

  it.each([
    ["story", storyMainnet, "https://mainnet.datarpc.io", "https://datanetscan.io"],
    ["story-aeneid", storyAeneid, "https://aeneid.datarpc.io", "https://aeneid.datanetscan.io"],
  ] as const)("keeps %s deployment metadata aligned and contract addresses unchanged", (network, chain, rpcUrl, blockExplorer) => {
    const deployment = deployments[network];
    expect(deployment.chain).toBe(chain);
    expect(deployment.rpcUrl).toBe(rpcUrl);
    expect(deployment.blockExplorer).toBe(blockExplorer);
    expect(deployment.contracts).toEqual({
      ipAssetRegistry: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      licenseRegistry: "0x529a750E02d8E2f15649c13D69a465286a780e24",
      royaltyModule: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
      disputeModule: "0x9b7A9c70AFF961C799110954fc06F3093aeb94C5",
      pilLicenseTemplate: "0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316",
    });
  });

  it.each(["story.foundation", "storyrpc.io"])("contains no retired %s host in the source", (host) => {
    const source = readFileSync(new URL("../chain-config.ts", import.meta.url), "utf8");
    expect(source.includes(host)).toBe(false);
  });
});
