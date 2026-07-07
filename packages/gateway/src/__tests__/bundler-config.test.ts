import { describe, it, expect } from "vitest";
import {
  resolveBundlerConfig,
  redactBundlerUrl,
  zeroDevUrl,
  coinbaseUrl,
  normalizeChain,
} from "../config/bundler-config.js";

describe("resolveBundlerConfig", () => {
  it("returns provider 'none' for empty env", () => {
    const c = resolveBundlerConfig({});
    expect(c.provider).toBe("none");
    expect(c.bundlerUrl).toBeUndefined();
    expect(c.paymasterUrl).toBeUndefined();
    expect(c.sponsored).toBe(false);
    expect(c.chain).toBe("base-sepolia");
    expect(c.chainId).toBe(84532);
  });

  it("resolves explicit ZeroDev URLs → zerodev + sponsored", () => {
    const c = resolveBundlerConfig({
      ZERODEV_BUNDLER_URL: "https://rpc.zerodev.app/api/v3/proj/chain/84532",
      ZERODEV_PAYMASTER_URL: "https://rpc.zerodev.app/api/v3/proj/chain/84532",
    });
    expect(c.provider).toBe("zerodev");
    expect(c.sponsored).toBe(true);
    expect(c.bundlerUrl).toContain("zerodev");
    expect(c.paymasterUrl).toContain("zerodev");
  });

  it("constructs the ZeroDev v3 URL from a project id + chain id", () => {
    const c = resolveBundlerConfig({ ZERODEV_PROJECT_ID: "abc123" });
    expect(c.provider).toBe("zerodev");
    expect(c.bundlerUrl).toBe("https://rpc.zerodev.app/api/v3/abc123/chain/84532");
    expect(c.paymasterUrl).toBe("https://rpc.zerodev.app/api/v3/abc123/chain/84532");
    expect(c.sponsored).toBe(true);
  });

  it("uses base-mainnet chain id when chain = base", () => {
    const c = resolveBundlerConfig({ ZERODEV_PROJECT_ID: "abc", BUNDLER_CHAIN: "base" });
    expect(c.chain).toBe("base");
    expect(c.chainId).toBe(8453);
    expect(c.bundlerUrl).toContain("/chain/8453");
  });

  it("resolves generic Pimlico via PCC_BUNDLER_URL/PCC_PAYMASTER_URL", () => {
    const c = resolveBundlerConfig({
      PCC_BUNDLER_URL: "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=k",
      PCC_PAYMASTER_URL: "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=k",
    });
    expect(c.provider).toBe("pimlico");
    expect(c.sponsored).toBe(true);
    expect(c.bundlerUrl).toContain("pimlico");
  });

  it("treats a non-pimlico custom bundler URL (no paymaster) as 'custom', unsponsored", () => {
    const c = resolveBundlerConfig({ BUNDLER_URL: "https://my-bundler.example/rpc" });
    expect(c.provider).toBe("custom");
    expect(c.bundlerUrl).toBe("https://my-bundler.example/rpc");
    expect(c.sponsored).toBe(false);
  });

  it("constructs the Coinbase CDP URL from CDP_API_KEY", () => {
    const c = resolveBundlerConfig({ CDP_API_KEY: "cdpkey" });
    expect(c.provider).toBe("coinbase-cdp");
    expect(c.bundlerUrl).toBe(
      "https://api.developer.coinbase.com/rpc/v1/base-sepolia/cdpkey",
    );
    expect(c.sponsored).toBe(true);
  });

  it("honors an explicit COINBASE_PAYMASTER_URL", () => {
    const c = resolveBundlerConfig({
      COINBASE_PAYMASTER_URL:
        "https://api.developer.coinbase.com/rpc/v1/base-sepolia/x",
    });
    expect(c.provider).toBe("coinbase-cdp");
    expect(c.sponsored).toBe(true);
  });

  it("precedence: ZeroDev beats PCC_ beats legacy beats Coinbase", () => {
    const c = resolveBundlerConfig({
      ZERODEV_BUNDLER_URL: "https://zd.example/bundler",
      PCC_BUNDLER_URL: "https://pcc.example/bundler",
      BUNDLER_URL: "https://legacy.example/bundler",
      CDP_API_KEY: "k",
    });
    expect(c.bundlerUrl).toBe("https://zd.example/bundler");
    expect(c.provider).toBe("zerodev");
  });

  it("PCC_BUNDLER_URL wins over legacy BUNDLER_URL", () => {
    const c = resolveBundlerConfig({
      PCC_BUNDLER_URL: "https://pcc.example/bundler",
      BUNDLER_URL: "https://legacy.example/bundler",
    });
    expect(c.bundlerUrl).toBe("https://pcc.example/bundler");
  });

  it("ignores blank/whitespace env values", () => {
    const c = resolveBundlerConfig({ ZERODEV_BUNDLER_URL: "   ", BUNDLER_URL: "" });
    expect(c.provider).toBe("none");
    expect(c.bundlerUrl).toBeUndefined();
  });
});

describe("redactBundlerUrl", () => {
  it("masks the ZeroDev project id (mid-path), keeps the chain id", () => {
    expect(
      redactBundlerUrl("https://rpc.zerodev.app/api/v3/SECRETPROJECT123/chain/84532"),
    ).toBe("https://rpc.zerodev.app/api/v3/***/chain/84532");
  });

  it("drops the query string (Pimlico ?apikey=)", () => {
    expect(
      redactBundlerUrl("https://api.pimlico.io/v2/base-sepolia/rpc?apikey=SECRETKEY"),
    ).toBe("https://api.pimlico.io/v2/base-sepolia/rpc");
  });

  it("masks the Coinbase CDP key (tail segment)", () => {
    expect(
      redactBundlerUrl(
        "https://api.developer.coinbase.com/rpc/v1/base-sepolia/CDPKEY1234567",
      ),
    ).toBe("https://api.developer.coinbase.com/rpc/v1/base-sepolia/***");
  });

  it("returns undefined for undefined", () => {
    expect(redactBundlerUrl(undefined)).toBeUndefined();
  });

  it("returns 'configured' for an unparseable url", () => {
    expect(redactBundlerUrl("not a url")).toBe("configured");
  });
});

describe("helpers", () => {
  it("normalizeChain maps base/mainnet → base, else base-sepolia", () => {
    expect(normalizeChain("base")).toBe("base");
    expect(normalizeChain("mainnet")).toBe("base");
    expect(normalizeChain("base-sepolia")).toBe("base-sepolia");
    expect(normalizeChain(undefined)).toBe("base-sepolia");
  });

  it("zeroDevUrl builds the v3 path", () => {
    expect(zeroDevUrl("p", 84532)).toBe("https://rpc.zerodev.app/api/v3/p/chain/84532");
  });

  it("coinbaseUrl builds the CDP path", () => {
    expect(coinbaseUrl("k", "base-sepolia")).toBe(
      "https://api.developer.coinbase.com/rpc/v1/base-sepolia/k",
    );
  });
});
