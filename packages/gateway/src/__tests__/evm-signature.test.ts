import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublicClient, custom, encodeDeployData, erc6492SignatureValidatorAbi,
  erc6492SignatureValidatorByteCode, hashMessage, HttpRequestError,
  isErc6492Signature, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import {
  __resetSignatureVerifierForTests, setSignatureVerifierTransportForTests,
  SIGVERIFY_GAS_CAP, SIGVERIFY_MAX_IN_FLIGHT, verifyEvmMessageSignature,
} from "../auth/evm-signature.js";
import { isOutboundSecretUrl } from "../services/outbound-secrets.js";

const A = "0x1234567890123456789012345678901234567890" as const;
const message = "PCC smart account authentication";
let url: string;
let requests: { method: string; params?: any }[];

async function smartSignature(deployed = false) {
  const owner = privateKeyToAccount(generatePrivateKey());
  // Account preparation must never share the verifier's recording transport.
  const client = createPublicClient({ chain: baseSepolia, transport: custom({
    async request({ method }) {
      if (method === "eth_getCode") return deployed ? "0x6000" : "0x";
      throw new Error("Unexpected account preparation request");
    },
  }) });
  const account = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1", address: A });
  const signature = await account.signMessage({ message });
  expect(isErc6492Signature(signature)).toBe(!deployed);
  return signature;
}
function recording(answer: (request: { method: string; params?: any }) => any = req => req.method === "eth_chainId" ? "0x14a34" : "0x01") {
  setSignatureVerifierTransportForTests(custom({ async request(req) {
    requests.push(req);
    return answer(req);
  } }, { retryCount: 0 }));
}
function check(signature: string, overrides: Record<string, unknown> = {}) {
  return verifyEvmMessageSignature({ address: A, message, signature, chainId: 84532, ...overrides });
}
function exact(signature: Hex, address: Hex = A) {
  const data = encodeDeployData({ abi: erc6492SignatureValidatorAbi, bytecode: erc6492SignatureValidatorByteCode,
    args: [address, hashMessage(message), signature] });
  recording(req => req.method === "eth_chainId" ? "0x14a34" : req.params[0].data === data ? "0x01" : "0x00");
}
function capHarness() {
  const held: { resolve: (data: Hex) => void; reject: (error: Error) => void }[] = [];
  const checks: ReturnType<typeof check>[] = [];
  let draining = false;
  return {
    // Changing transports clears only the chain cache, preserving the counter under test.
    install(mode: "ok" | "mismatch" | "throw" = "ok") {
      recording(req => {
        if (req.method === "eth_chainId") {
          if (mode === "throw") throw new HttpRequestError({ url: "https://sigverify.invalid", details: "offline" });
          return mode === "mismatch" ? "0x2105" : "0x14a34";
        }
        if (draining) return "0x01";
        return new Promise<Hex>((resolve, reject) => { held.push({ resolve, reject }); });
      });
    },
    async burst(signature: string) {
      const start = held.length;
      const before = requests.filter(req => req.method === "eth_call").length;
      const settled: Awaited<ReturnType<typeof check>>[] = [];
      // Start together: a yield between the cap check and increment would wrongly admit 17.
      const calls = Array.from({ length: 17 }, () => check(signature).then(result => {
        settled.push(result);
        return result;
      }));
      checks.push(...calls);
      await vi.waitFor(() => expect(held.length - start + settled.length).toBe(17), { timeout: 1000 });
      expect(held.length - start).toBe(16);
      expect(requests.filter(req => req.method === "eth_call").length - before).toBe(16);
      expect(settled).toEqual([{ ok: false, reason: "unavailable" }]);
      return { calls, held: held.slice(start) };
    },
    async drain() {
      // Also settle calls that reach the transport after a failed assertion, before reset.
      draining = true;
      held.forEach(call => call.resolve("0x01"));
      await Promise.allSettled(checks);
    },
  };
}
beforeEach(() => {
  requests = [];
  url = `https://sigverify.invalid/v2/${randomBytes(16).toString("hex")}`;
  vi.stubEnv("PCC_SIGVERIFY_RPC_URL", url);
  vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
});
afterEach(() => { __resetSignatureVerifierForTests(); vi.unstubAllEnvs(); });

describe("smart-account signature verifier", () => {
  it.each(["unset", "failing"])("verifies EOAs locally with %s RPC, including another chain", async mode => {
    if (mode === "unset") vi.stubEnv("PCC_SIGVERIFY_RPC_URL", "");
    recording(() => { throw new Error("offline"); });
    const owner = privateKeyToAccount(generatePrivateKey());
    const signature = await owner.signMessage({ message });
    expect(await check(signature, { address: owner.address, chainId: 8453 })).toEqual({ ok: true, kind: "eoa" });
    expect(requests).toHaveLength(0);
  });
  it("keeps a wrong EOA signature invalid without RPC", async () => {
    vi.stubEnv("PCC_SIGVERIFY_RPC_URL", ""); recording();
    const owner = privateKeyToAccount(generatePrivateKey());
    expect(await check(await owner.signMessage({ message }))).toEqual({ ok: false, reason: "invalid" });
    expect(requests).toHaveLength(0);
  });
  it("refuses the zero address before any transport requests with configured and unset RPC", async () => {
    const zero = "0".repeat(64);
    const one = `${"0".repeat(63)}1`;
    const order = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";
    const signatures = [
      `0x${zero}${zero}1b`,
      `0x${zero}${one}1c`,
      `0x${order}${one}1b`,
      `0x${one}${zero}1b`,
    ];
    const results = [];
    for (const rpc of [url, ""]) {
      vi.stubEnv("PCC_SIGVERIFY_RPC_URL", rpc);
      for (const signature of signatures) {
        requests = [];
        // The real universal validator can return true for each failed ecrecover.
        recording();
        results.push({
          result: await check(signature, { address: "0x0000000000000000000000000000000000000000" }),
          requests: requests.length,
        });
      }
    }
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ result: { ok: false, reason: "invalid" }, requests: 0 })));
  });
  it.each([false, true])("verifies exact deployless data for a deployed=%s CSW with an explicit gas cap", async deployed => {
    const signature = await smartSignature(deployed); exact(signature);
    expect(await check(signature)).toEqual({ ok: true, kind: "contract" });
    expect(requests.map(r => r.method)).toEqual(["eth_chainId", "eth_call"]);
    expect(requests[1].params[0]).not.toHaveProperty("to");
    expect(SIGVERIFY_GAS_CAP).toBe(3_000_000n);
    expect(requests[1].params[0].gas).toBe("0x2dc6c0");
  });
  it("verifies exact deployless data for a near-zero contract address", async () => {
    const address = "0x00000000000000000000000000000000000000ff";
    const signature = await smartSignature(); exact(signature, address);
    expect(await check(signature, { address })).toEqual({ ok: true, kind: "contract" });
    expect(requests.map(r => r.method)).toEqual(["eth_chainId", "eth_call"]);
    expect(requests[1].params[0]).not.toHaveProperty("to");
  });
  it("caps in-flight RPC work and frees every slot after success and transport failure", async () => {
    const signature = await smartSignature();
    const freshMessage = `${message}: fresh check`;
    const freshData = encodeDeployData({ abi: erc6492SignatureValidatorAbi, bytecode: erc6492SignatureValidatorByteCode,
      args: [A, hashMessage(freshMessage), signature] });
    const held: { resolve: (data: Hex) => void; reject: (error: Error) => void }[] = [];
    const checks: ReturnType<typeof check>[] = [];
    let refilling = false;
    recording(req => {
      if (req.method === "eth_chainId") return "0x14a34";
      if (req.params[0].data === freshData || (!refilling && held.length >= 16)) return "0x01";
      return new Promise<Hex>((resolve, reject) => { held.push({ resolve, reject }); });
    });
    try {
      const first = Array.from({ length: 16 }, () => check(signature));
      checks.push(...first);
      await vi.waitFor(() => expect(held).toHaveLength(16), { timeout: 1000 });
      expect(requests.filter(req => req.method === "eth_call")).toHaveLength(16);
      const before = requests.length;
      const overflowUrl = `https://overflow.invalid/v2/${randomBytes(16).toString("hex")}`;
      vi.stubEnv("PCC_SIGVERIFY_RPC_URL", overflowUrl);
      expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
      expect(requests).toHaveLength(before);
      expect(isOutboundSecretUrl(overflowUrl)).toBe(false);
      vi.stubEnv("PCC_SIGVERIFY_RPC_URL", url);
      expect(SIGVERIFY_MAX_IN_FLIGHT).toBe(16);

      held.forEach((call, index) => {
        if (index < 8) call.resolve("0x01");
        else call.reject(new HttpRequestError({ url: "https://sigverify.invalid", details: "offline" }));
      });
      expect(await Promise.all(first)).toEqual([
        ...Array.from({ length: 8 }, () => ({ ok: true, kind: "contract" })),
        ...Array.from({ length: 8 }, () => ({ ok: false, reason: "unavailable" })),
      ]);

      // Occupy fifteen fresh slots so even one leaked slot refuses the final check.
      refilling = true;
      checks.push(...Array.from({ length: 15 }, () => check(signature)));
      expect(await check(signature, { message: freshMessage })).toEqual({ ok: true, kind: "contract" });
      expect(held).toHaveLength(31);
    } finally {
      held.forEach(call => call.resolve("0x01"));
      await Promise.allSettled(checks);
    }
  });
  it("cap burst admits exactly sixteen simultaneous checks and refuses one immediately", async () => {
    const signature = await smartSignature();
    const cap = capHarness();
    cap.install();
    try {
      expect(SIGVERIFY_MAX_IN_FLIGHT).toBe(16);
      await cap.burst(signature);
    } finally {
      await cap.drain();
    }
  });
  it("cap placement leaves EOA verification and config refusals available when full", async () => {
    const signature = await smartSignature();
    const cap = capHarness();
    cap.install();
    try {
      await cap.burst(signature);
      const before = requests.length;
      const owner = privateKeyToAccount(generatePrivateKey());
      const eoaSignature = await owner.signMessage({ message });
      expect(await check(eoaSignature, { address: owner.address })).toEqual({ ok: true, kind: "eoa" });
      expect(await check(signature, { chainId: 8453 })).toEqual({ ok: false, reason: "wrong_chain" });
      vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "bad");
      expect(await check(signature)).toEqual({ ok: false, reason: "unconfigured" });
      vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
      vi.stubEnv("PCC_SIGVERIFY_RPC_URL", "");
      expect(await check(signature)).toEqual({ ok: false, reason: "unconfigured" });
      expect(await check(`0x${"ab".repeat(65)}`)).toEqual({ ok: false, reason: "invalid" });
      expect(requests).toHaveLength(before);
    } finally {
      await cap.drain();
    }
  });
  it("cap release frees exactly one slot on every RPC exit and enforces sixteen again", async () => {
    const signature = await smartSignature();
    const cap = capHarness();
    cap.install();
    try {
      const first = await cap.burst(signature);
      first.held.forEach((call, index) => {
        if (index < 6) call.resolve("0x01");
        else if (index < 11) call.resolve("0x00");
        else call.reject(new HttpRequestError({ url: "https://sigverify.invalid", details: "offline" }));
      });
      const results = await Promise.all(first.calls);
      expect(results.filter(result => result.ok)).toEqual(Array.from({ length: 6 }, () => ({ ok: true, kind: "contract" })));
      expect(results.filter(result => !result.ok && result.reason === "invalid")).toHaveLength(5);
      expect(results.filter(result => !result.ok && result.reason === "unavailable")).toHaveLength(6);
      for (const mode of ["mismatch", "throw"] as const) {
        cap.install(mode);
        const before = requests.length;
        for (let i = 0; i < 20; i++) {
          expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
        }
        expect(requests.slice(before).map(req => req.method)).toEqual(Array(20).fill("eth_chainId"));
      }
      cap.install();
      const again = await cap.burst(signature);
      again.held.forEach(call => call.resolve("0x01"));
      const finalResults = await Promise.all(again.calls);
      expect(finalResults.filter(result => result.ok)).toEqual(Array.from({ length: 16 }, () => ({ ok: true, kind: "contract" })));
      expect(finalResults.filter(result => !result.ok)).toEqual([{ ok: false, reason: "unavailable" }]);
    } finally {
      await cap.drain();
    }
  });
  it("cap holds on a warm chain cache, and every revert frees exactly one slot", async () => {
    const signature = await smartSignature();
    const cap = capHarness();
    const extra: Promise<unknown>[] = [];
    cap.install();
    try {
      const first = await cap.burst(signature);
      first.held.forEach((call, index) => {
        if (index < 8) call.resolve("0x01");
        else call.reject(Object.assign(new Error("execution reverted"), { code: 3, data: "0x12345678" }));
      });
      const results = await Promise.all(first.calls);
      expect(results.filter(result => result.ok)).toEqual(Array.from({ length: 8 }, () => ({ ok: true, kind: "contract" })));
      expect(results.filter(result => !result.ok && result.reason === "invalid")).toHaveLength(8);

      // Keep the successful chain check cached: install() would clear it.
      const before = requests.length;
      const warm = await cap.burst(signature);
      expect(requests.slice(before).map(req => req.method)).toEqual(Array(16).fill("eth_call"));
      // A check made while sixteen warm eth_calls are held is refused without a request.
      // Not awaited directly: an admitted check would be held until the drain.
      const full = requests.length;
      const late = check(signature);
      extra.push(late);
      let lateResult: unknown = "pending";
      void late.then(result => { lateResult = result; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(lateResult).toEqual({ ok: false, reason: "unavailable" });
      expect(requests).toHaveLength(full);

      // Release the warm calls through every exit.
      warm.held.forEach((call, index) => {
        if (index < 4) call.resolve("0x01");
        else if (index < 8) call.resolve("0x00");
        else if (index < 12) call.reject(Object.assign(new Error("execution reverted"), { code: 3, data: "0x12345678" }));
        else call.reject(new HttpRequestError({ url: "https://sigverify.invalid", details: "offline" }));
      });
      const warmResults = await Promise.all(warm.calls);
      expect(warmResults.filter(result => result.ok)).toEqual(Array.from({ length: 4 }, () => ({ ok: true, kind: "contract" })));
      expect(warmResults.filter(result => !result.ok && result.reason === "invalid")).toHaveLength(8);
      expect(warmResults.filter(result => !result.ok && result.reason === "unavailable")).toHaveLength(5);

      // A third burst, still warm, must hold sixteen again.
      const again = requests.length;
      const third = await cap.burst(signature);
      expect(requests.slice(again).map(req => req.method)).toEqual(Array(16).fill("eth_call"));
      third.held.forEach(call => call.resolve("0x01"));
      const thirdResults = await Promise.all(third.calls);
      expect(thirdResults.filter(result => result.ok)).toEqual(Array.from({ length: 16 }, () => ({ ok: true, kind: "contract" })));
      expect(thirdResults.filter(result => !result.ok)).toEqual([{ ok: false, reason: "unavailable" }]);
    } finally {
      await cap.drain();
      await Promise.allSettled(extra);
    }
  });
  it("rejects a one-byte tamper and a different message using the exact personal-sign hash", async () => {
    const signature = await smartSignature(); exact(signature);
    const tampered = (`0x${signature[2] === "0" ? "1" : "0"}${signature.slice(3)}`) as Hex;
    expect(await check(tampered)).toEqual({ ok: false, reason: "invalid" });
    expect(await check(signature, { message: `${message}!` })).toEqual({ ok: false, reason: "invalid" });
  });
  it.each([
    ["code 3 with revert data", { code: 3, message: "reverted", data: "0x12345678" }],
    ["geth empty revert", { code: -32000, message: "execution reverted" }],
    ["nested plain cause", { cause: { cause: { code: -32000, message: "execution reverted" } } }],
  ])("classifies %s as invalid", async (_name, error) => {
    const signature = await smartSignature();
    recording(req => { if (req.method === "eth_chainId") return "0x14a34"; throw error; });
    expect(await check(signature)).toEqual({ ok: false, reason: "invalid" });
  });
  it.each(["0x", `0x${"0".repeat(63)}1`, "0x00", "0x0100"])("rejects non-single-byte-true result %s", async data => {
    const signature = await smartSignature(); recording(req => req.method === "eth_chainId" ? "0x14a34" : data);
    expect(await check(signature)).toEqual({ ok: false, reason: "invalid" });
  });
  it.each([
    ["HTTP", () => new HttpRequestError({ url: "https://sigverify.invalid", details: "offline" })],
    ["internal RPC", () => ({ code: -32603, message: "internal error" })],
    ["missing header", () => ({ code: -32000, message: "header not found" })],
    ["unknown", () => new Error("unknown")],
  ])("classifies %s failures as unavailable", async (_name, error) => {
    const signature = await smartSignature();
    recording(req => { if (req.method === "eth_chainId") return "0x14a34"; throw error(); });
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
  });
  it("enforces its own deadline when a custom transport never answers", async () => {
    const signature = await smartSignature(); vi.stubEnv("PCC_SIGVERIFY_TIMEOUT_MS", "1000");
    recording(() => new Promise(() => {}));
    const started = Date.now();
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2000);
  }, 2500);
  it("clamps a sub-minimum timeout to at least 1000 ms when transport never answers", async () => {
    const signature = await smartSignature(); vi.stubEnv("PCC_SIGVERIFY_TIMEOUT_MS", "100");
    recording(() => new Promise(() => {}));
    const started = Date.now();
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  }, 2500);
  it("rejects a late answer after eth_call blocks the deadline timer", async () => {
    const signature = await smartSignature(); vi.stubEnv("PCC_SIGVERIFY_TIMEOUT_MS", "1000");
    recording(req => {
      if (req.method === "eth_chainId") return "0x14a34";
      const until = Date.now() + 1200;
      // Block the event loop so only the post-answer deadline check can reject.
      while (Date.now() < until) { /* synchronous transport work */ }
      return "0x01";
    });
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
    expect(requests.map(r => r.method)).toEqual(["eth_chainId", "eth_call"]);
  }, 2500);
  it("uses one deadline across chain check and validator, ignoring a late success", async () => {
    const signature = await smartSignature(); vi.stubEnv("PCC_SIGVERIFY_TIMEOUT_MS", "1000");
    recording(req => new Promise(resolve => setTimeout(() => resolve(req.method === "eth_chainId" ? "0x14a34" : "0x01"), 600)));
    const started = Date.now();
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(1500);
  }, 2500);
  it("treats even a revert during eth_chainId as unavailable", async () => {
    const signature = await smartSignature();
    recording(() => { throw { code: 3, message: "execution reverted" }; });
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
    expect(requests.map(r => r.method)).toEqual(["eth_chainId"]);
  });
  it("rejects a mismatched RPC chain before eth_call", async () => {
    const signature = await smartSignature(); recording(() => "0x2105");
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
    expect(requests.map(r => r.method)).toEqual(["eth_chainId"]);
  });
  it("rejects a contract's claimed wrong chain without RPC", async () => {
    const signature = await smartSignature(); recording();
    expect(await check(signature, { chainId: 8453 })).toEqual({ ok: false, reason: "wrong_chain" });
    expect(requests).toHaveLength(0);
  });
  it.each(["bad", "0", "-1", "1.5", "Infinity"])("refuses malformed configured chain %s without RPC", async chain => {
    const signature = await smartSignature(); recording(); vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", chain);
    expect(await check(signature)).toEqual({ ok: false, reason: "unconfigured" });
    expect(requests).toHaveLength(0);
  });
  it.each(["", "http://sigverify.invalid/v2/token", "https://user:password@sigverify.invalid/v2/token", "https://sigverify.invalid/#token", "not a URL"])("refuses unusable RPC config %s", async value => {
    const signature = await smartSignature(); recording(); vi.stubEnv("PCC_SIGVERIFY_RPC_URL", value);
    expect(await check(signature)).toEqual({ ok: false, reason: "unconfigured" });
    expect(requests).toHaveLength(0);
  });
  it.each(["http://127.0.0.1/", "http://[::1]/", "http://localhost/"])("allows loopback HTTP %s with a stub transport", async value => {
    const signature = await smartSignature(); recording(); vi.stubEnv("PCC_SIGVERIFY_RPC_URL", value);
    expect(await check(signature)).toEqual({ ok: true, kind: "contract" });
  });
  it.each([
    { address: "0x1234" }, { address: null }, { signature: "0x01" },
    { signature: `0x${"ab".repeat(2049)}` }, { signature: `0x${"ab".repeat(64)}a` },
    { message: "" }, { message: "a".repeat(8193) }, { message: 42 },
  ])("rejects malformed input before any RPC: %j", async overrides => {
    recording();
    expect(await check(`0x${"ab".repeat(64)}`, overrides)).toEqual({ ok: false, reason: "malformed" });
    expect(requests).toHaveLength(0);
  });
  it("does not cache a failed eth_chainId", async () => {
    const signature = await smartSignature(); let chains = 0;
    recording(req => { if (req.method === "eth_chainId") { if (++chains === 1) throw new Error("offline"); return "0x14a34"; } return "0x01"; });
    expect(await check(signature)).toEqual({ ok: false, reason: "unavailable" });
    expect(await check(signature)).toEqual({ ok: true, kind: "contract" });
    expect(chains).toBe(2);
  });
  it("caches a successful chain check and registers the secret URL", async () => {
    const signature = await smartSignature(); recording();
    expect(await check(signature)).toEqual({ ok: true, kind: "contract" });
    expect(await check(signature)).toEqual({ ok: true, kind: "contract" });
    expect(requests.map(r => r.method)).toEqual(["eth_chainId", "eth_call", "eth_call"]);
    expect(isOutboundSecretUrl(url)).toBe(true);
  });
});
