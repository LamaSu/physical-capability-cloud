import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { custom } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  __resetSignatureVerifierForTests, setSignatureVerifierTransportForTests, verifyEvmMessageSignature,
} from "../auth/evm-signature.js";

const tracing = vi.hoisted(() => ({ active: false, callbacks: 0 }));
vi.mock("../sentry.js", () => ({ Sentry: {
  suppressTracing: async (fn: () => unknown) => {
    const previous = tracing.active;
    tracing.active = true;
    tracing.callbacks++;
    try { return await fn(); } finally { tracing.active = previous; }
  },
} }));

afterEach(() => {
  __resetSignatureVerifierForTests();
  vi.unstubAllEnvs();
  tracing.active = false;
  tracing.callbacks = 0;
});

describe("signature-verifier tracing suppression", () => {
  it("executes both eth_chainId and eth_call inside Sentry.suppressTracing", async () => {
    vi.stubEnv("PCC_SIGVERIFY_RPC_URL", `https://sigverify.invalid/v2/${randomBytes(16).toString("hex")}`);
    vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
    const requests: Array<{ method: string; suppressed: boolean }> = [];
    setSignatureVerifierTransportForTests(custom({ request: async ({ method }) => {
      requests.push({ method, suppressed: tracing.active });
      if (method === "eth_chainId") return "0x14a34";
      if (method === "eth_call") return "0x01";
      throw new Error("unexpected_test_rpc_method");
    } }));
    const address = privateKeyToAccount(generatePrivateKey()).address;
    expect(await verifyEvmMessageSignature({ address, message: "tracing test", signature: `0x${"11".repeat(66)}`, chainId: 84532 }))
      .toEqual({ ok: true, kind: "contract" });
    expect(requests).toEqual([
      { method: "eth_chainId", suppressed: true },
      { method: "eth_call", suppressed: true },
    ]);
    expect(tracing.callbacks).toBeGreaterThan(0);
  });
});
