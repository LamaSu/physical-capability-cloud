import { afterEach, describe, expect, it, vi } from "vitest";
import { custom } from "viem";
import { vnextRpcUrl, createVNextChainReads, __setVNextTransportForTest } from "../services/vnext-rpc-client.js";
import { isOutboundSecretUrl } from "../services/outbound-secrets.js";
import { verifyBuyerFunding } from "../services/buyer-funding-verifier.js";
import { setUpFixture, tearDownFixture } from "./helpers/paid-scope-fixture.js";
import { buyerFundingJob, installBuyerFunding, B } from "./helpers/buyer-funding-fixture.js";

afterEach(() => { vi.stubEnv("NODE_ENV", "test"); __setVNextTransportForTest(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("V-next read-only RPC", () => {
  it("R1: rejects missing, insecure and credential-bearing URLs", () => {
    for (const url of [undefined, "", "not a url", "http://remote.invalid", "https://user@rpc.invalid", "https://user:pass@rpc.invalid", "https://rpc.invalid/#", "https://rpc.invalid/#fragment", "ftp://rpc.invalid"]) expect(vnextRpcUrl({ PCC_VNEXT_RPC_URL: url })).toBeNull();
    for (const url of ["https://rpc.invalid/path?token=secret", "http://localhost:8545", "http://127.0.0.1:8545", "http://[::1]:8545"]) expect(vnextRpcUrl({ PCC_VNEXT_RPC_URL: url })).toBe(url);
    vi.stubEnv("PCC_VNEXT_RPC_URL", "https://literal.invalid"); expect(vnextRpcUrl()).toBe("https://literal.invalid");
  });
  it("R2: construction registers the RPC secret URL", () => { const url = "https://registered.invalid/long-secret-credential"; createVNextChainReads(url); expect(isOutboundSecretUrl(url)).toBe(true); });
  it("R3: transport override refuses production", () => { vi.stubEnv("NODE_ENV", "production"); expect(() => __setVNextTransportForTest(null)).toThrow("test processes only"); });
  it("R4: transport error is a closed code with no error text in output or logs", async () => {
    const f = await setUpFixture(); installBuyerFunding();
    try {
      const j = await buyerFundingJob(f); const secret = "sensitive-rpc-error-contents";
      const logs = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
      __setVNextTransportForTest(custom({ request: async () => { throw new Error(secret); } }, { retryCount: 0 }));
      const production = createVNextChainReads("https://error.invalid/private");
      await expect(production.chainId()).rejects.toThrow(/^chain_read_failed$/);
      const out = await verifyBuyerFunding(j.target, { ...j.deps, reads: { ...j.reads, call: production.call } });
      expect(out).toEqual({ kind: "refused", code: "chain_read_failed" });
      expect(JSON.stringify([out, logs.map(s => s.mock.calls)])).not.toContain(secret);
    } finally { await tearDownFixture(f); }
  });
});
