import { afterEach, describe, expect, it, vi } from "vitest";
import { walletLinkConfig } from "./config.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("wallet-link server config", () => {
  it("uses the existing public URL and environment without request headers", () => {
    vi.stubEnv("PCC_PUBLIC_URL", "https://staging.capability.network/");
    vi.stubEnv("NODE_ENV", "staging");
    expect(walletLinkConfig()).toEqual({
      publicOrigin: "https://staging.capability.network",
      domain: "staging.capability.network",
      uri: "https://staging.capability.network/link",
      env: "staging",
      allowedChainIds: [84532],
    });
    vi.stubEnv("NODE_ENV", "production");
    expect(walletLinkConfig().env).toBe("prod");
  });

  it("normalizes an existing gateway URL and rejects credential-bearing origins", () => {
    vi.stubEnv("PCC_PUBLIC_URL", "");
    vi.stubEnv("PCC_GATEWAY_URL", "https://gateway.example:8443/some/path");
    expect(walletLinkConfig().publicOrigin).toBe("https://gateway.example:8443");
    vi.stubEnv("PCC_PUBLIC_URL", "https://user:password@gateway.example");
    expect(() => walletLinkConfig()).toThrow("invalid_wallet_public_origin");
  });
});
