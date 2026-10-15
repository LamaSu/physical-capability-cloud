import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type WalletRuntime } from "../wallet/cli.js";
import { requestFunding, waitForFundingReceipt } from "../wallet/http.js";
import { createWallet, updateLink, type Role } from "../wallet/keystore.js";

import { realFundingClaims } from "./wallet-funding-fixtures.js";

const ORIGIN = "https://wallets.invalid";
const REQUEST_ID = "lr_0123456789ABCDEFGHJKLMNPQR";
const LINK_ID = "wl_0123456789ABCDEFGHJKLMNPQR";
const ETH = realFundingClaims()[0]!;
const USDC = realFundingClaims()[5]!;
const TX_ETH = ETH!.txHash!;
const TX_USDC = USDC.txHash!;
const FUNDED = { status: "funded", claims: realFundingClaims() };
const PARTIAL = { status: "partial", claims: [...realFundingClaims("device"), { token: "usdc", amount: "1", status: "failed" }] };
const PENDING = { status: "pending", claims: realFundingClaims().map(({ txHash: _hash, ...claim }) => ({ ...claim, status: "pending" })) };
let directory: string;
let output: string[];
let errors: string[];
let sleeps: number[];
let clock: number;
let servers: Server[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pcc-wallet-funding-"));
  vi.stubEnv("PCC_WALLET_DIR", directory);
  vi.stubEnv("PCC_API_KEY", "");
  vi.stubEnv("PCC_RPC_URL", "");
  output = [];
  errors = [];
  sleeps = [];
  servers = [];
  clock = Date.parse("2026-10-13T12:00:00.000Z");
});
afterEach(async () => {
  for (const server of servers) {
    if (!server.listening) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function runtime(extra: Partial<WalletRuntime> = {}): Partial<WalletRuntime> {
  return {
    stdout: text => { output.push(text); }, stderr: text => { errors.push(text); },
    stdinIsTTY: false, prompt: async () => "create", now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    waitForReceipt: async () => ({ status: "success" as const }),
    ...extra,
  };
}
function store(role: Role = "agent", status = "approved", requestId: string | null = REQUEST_ID): void {
  const wallet = createWallet({ label: role, role, keyType: "secp256k1", chainId: 84532,
    gatewayOrigin: ORIGIN, createdAt: new Date(clock).toISOString() });
  updateLink(wallet, { status, linkId: LINK_ID, ...(requestId ? { requestId } : {}) });
}
function fund(role: Role = "agent", flags: string[] = [], io: Partial<WalletRuntime> = runtime()): Promise<number> {
  return main(["fund", "--role", role, "--label", role, "--gateway", ORIGIN, ...flags], io);
}
function gateway(data: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  }));
}
function claimResponse<T extends { token: unknown }>(claim: T, status = "funded") {
  const claims: unknown[] = realFundingClaims();
  claims[claim.token === "usdc" ? 5 : 0] = claim;
  return { status, claims };
}

describe("W2 funding response contract", () => {
  it("uses requestId path, JSON {}, no Authorization even with an owner key in env", async () => {
    vi.stubEnv("PCC_API_KEY", "owner-test-token");
    const fetchSpy = gateway(FUNDED);
    expect(await requestFunding(ORIGIN, REQUEST_ID, "agent")).toEqual(FUNDED);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/wallets/link-requests/${REQUEST_ID}/fund`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });
  it("fund POST has no amount input for either role", async () => {
    for (const role of ["agent", "device"] as const) {
      const fetchSpy = gateway({ status: "funded", claims: realFundingClaims(role) });
      await requestFunding(ORIGIN, REQUEST_ID, role);
      expect(JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body))).toEqual({});
      fetchSpy.mockRestore();
    }
  });
  it("accepts device ETH claims", async () => {
    const device = { status: "funded", claims: realFundingClaims("device") };
    gateway(device);
    expect(await requestFunding(ORIGIN, REQUEST_ID, "device")).toEqual(device);
  });
  it("YANKEE-I1d refuses two claims whose txHashes differ only in hex case", async () => {
    const claims = realFundingClaims();
    claims[0] = { ...claims[0]!, txHash: `0x${"ab".repeat(32)}` };
    claims[1] = { ...claims[1]!, txHash: `0x${"AB".repeat(32)}` };
    gateway({ status: "funded", claims });
    await expect(requestFunding(ORIGIN, REQUEST_ID, "agent")).rejects.toThrow("invalid_gateway_response");
  });
  it("YANKEE-OR3 accepts a funded body whose distinct txHashes use uppercase hex", async () => {
    const claims = realFundingClaims().map((claim, index) => ({
      ...claim, txHash: `0x${(index + 10).toString(16).toUpperCase().padStart(2, "0").repeat(32)}`,
    }));
    const body = { status: "funded", claims };
    gateway(body);
    expect(await requestFunding(ORIGIN, REQUEST_ID, "agent")).toEqual(body);
  });
  it("PROBE-NM3a accepts two claims whose txHashes differ only in the first nibble", async () => {
    const claims = realFundingClaims();
    claims[0] = { ...claims[0]!, txHash: `0x1${"a".repeat(63)}` };
    claims[1] = { ...claims[1]!, txHash: `0x2${"a".repeat(63)}` };
    const body = { status: "funded", claims };
    gateway(body);
    expect(await requestFunding(ORIGIN, REQUEST_ID, "agent")).toEqual(body);
  });
  it("PROBE-NM3b accepts two claims whose txHashes differ only in the last nibble", async () => {
    const claims = realFundingClaims();
    claims[0] = { ...claims[0]!, txHash: `0x${"a".repeat(63)}1` };
    claims[1] = { ...claims[1]!, txHash: `0x${"a".repeat(63)}2` };
    const body = { status: "funded", claims };
    gateway(body);
    expect(await requestFunding(ORIGIN, REQUEST_ID, "agent")).toEqual(body);
  });
  it("refuses any USDC claim for a device", async () => {
    gateway(FUNDED);
    await expect(requestFunding(ORIGIN, REQUEST_ID, "device")).rejects.toThrow("invalid_gateway_response");
  });
  it.each([
    ["null", null], ["array", []], ["missing status", { claims: [ETH] }],
    ["unknown status", claimResponse(ETH, "ready")],
    ["unknown root field", { ...FUNDED, hashes: [TX_ETH] }],
    ["missing claims", { status: "funded" }], ["claims object", { status: "funded", claims: {} }],
    ["empty claims", { status: "funded", claims: [] }],
    ["null claim", { status: "funded", claims: [null, ...realFundingClaims().slice(1)] }],
    ["unknown token", claimResponse({ ...ETH, token: "btc" })],
    ["wrong ETH amount", claimResponse({ ...ETH, amount: "1" })],
    ["wrong USDC amount", claimResponse({ ...USDC, amount: "0.0001" })],
    ["numeric amount", claimResponse({ ...ETH, amount: 0.0001 })],
    ["unknown claim status", claimResponse({ ...ETH, status: "mined" })],
    ["unknown claim field", claimResponse({ ...ETH, diagnostic: "do not echo" })],
    ["invalid hash", claimResponse({ ...ETH, txHash: "0xbad" })],
    ["succeeded without hash", claimResponse({ token: "eth", amount: "0.0001", status: "succeeded" })],
    ["funded with failed claim", claimResponse({ token: "eth", amount: "0.0001", status: "failed" })],
    ["funded with pending claim", claimResponse({ token: "eth", amount: "0.0001", status: "pending" })],
    ["partial without failed claim", claimResponse(ETH, "partial")],
    ["pending without pending claim", claimResponse(ETH, "pending")],
    ["duplicate txHash", { status: "funded", claims: realFundingClaims().map(claim => ({ ...claim, txHash: TX_ETH })) }],
    ["four ETH claims", { status: "funded", claims: realFundingClaims().slice(1) }],
    ["claims out of order", { status: "funded", claims: realFundingClaims().reverse() }],
    ["hash on failed claim", claimResponse({ ...USDC, status: "failed" }, "partial")],
    ["hash on pending claim", claimResponse({ ...USDC, status: "pending" }, "pending")],
    ["partial with pending claim", { ...PARTIAL, claims: [...PARTIAL.claims.slice(0, 4), { token: "eth", amount: "0.0001", status: "pending" }, PARTIAL.claims[5]] }],
    ["partial with no success", { status: "partial", claims: realFundingClaims().map(({ txHash: _hash, ...claim }) => ({ ...claim, status: "failed" })) }],
    ["hash in unrelated nested object", { status: "funded", claims: [{ token: "eth", amount: "0.0001", status: "succeeded" }], extra: { txHash: TX_ETH } }],
  ])("refuses %s instead of collecting arbitrary hashes", async (_name, data) => {
    gateway(data);
    await expect(requestFunding(ORIGIN, REQUEST_ID, "agent")).rejects.toThrow("invalid_gateway_response");
  });
  it.each([PARTIAL, PENDING])("accepts the strict $status shape", async data => {
    gateway(data);
    expect(await requestFunding(ORIGIN, REQUEST_ID, "agent")).toEqual(data);
  });
  it("refuses a 204 because only a strict 200 can prove funding", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(requestFunding(ORIGIN, REQUEST_ID, "agent")).rejects.toThrow("invalid_gateway_response");
  });
});

describe("W2 CLI funding", () => {
  it("waits for EVERY claim receipt before printing funded", async () => {
    store(); gateway(FUNDED);
    const waiter = vi.fn(async (_hash: `0x${string}`, _rpcUrl: string, _timeoutMs: number) => {
      expect(output.join("")).not.toContain("funded");
      return { status: "success" as const };
    });
    expect(await fund("agent", ["--rpc-url", "http://127.0.0.1:8545"], runtime({ waitForReceipt: waiter }))).toBe(0);
    expect(waiter.mock.calls.map(call => call[0])).toEqual(realFundingClaims().map(claim => claim.txHash));
    expect(waiter.mock.calls.every(call => call[1] === "http://127.0.0.1:8545")).toBe(true);
    expect(output.join("")).toContain("funded");
  });
  it("a reverted receipt refuses funded", async () => {
    store(); gateway(FUNDED);
    expect(await fund("agent", [], runtime({ waitForReceipt: async () => ({ status: "reverted" }) }))).not.toBe(0);
    expect(errors.join("")).toContain("funding_transaction_reverted");
    expect(output.join("")).not.toContain("funded");
  });
  it("partial prints each claim and exits nonzero", async () => {
    store(); gateway(PARTIAL);
    expect(await fund()).not.toBe(0);
    const text = output.join("") + errors.join("");
    for (const value of ["eth", "0.0001", "succeeded", "usdc", "1", "failed"]) expect(text).toContain(value);
    expect(text).not.toMatch(/(?:^|\n)funded(?:\n|$)/);
    expect(text).not.toContain("ready");
    expect(output.join("")).toContain("pcc-wallet fund again after 30 s");
  });
  it("pending re-polls the SAME POST path with bounded backoff", async () => {
    store();
    const responses = [PENDING, PENDING, FUNDED];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    expect(await fund()).toBe(0);
    expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual(Array(3).fill(`${ORIGIN}/api/wallets/link-requests/${REQUEST_ID}/fund`));
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]!);
    expect(output.join("")).toContain("funded");
  });
  it("permanent pending stops with a nonzero exit and no funded", async () => {
    store();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(PENDING), { status: 200 }));
    expect(await fund()).not.toBe(0);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(20);
    expect(sleeps.every(ms => ms > 0 && ms <= 10_000)).toBe(true);
    expect(errors.join("")).toContain("funding_pending");
    expect(output.join("")).not.toContain("funded");
  });
  it.each([[404, "not_found"]] as const)("%s/%s is linked (unfunded), exit zero", async (status, error) => {
    store(); gateway({ error }, status);
    expect(await fund()).toBe(0);
    expect(output.join("")).toContain("linked (unfunded)");
  });
  it.each([[502, "faucet_error"], [403, "link_inactive"], [403, "capability_expired"], [409, "not_fundable"], [503, "faucet_unavailable"]] as const)("%s/%s exits nonzero", async (status, error) => {
    store(); gateway({ error, detail: "untrusted funding error" }, status);
    expect(await fund()).not.toBe(0);
    expect(errors.join("")).toContain(error);
    expect(output.join("")).not.toContain("funded");
    expect(output.join("") + errors.join("")).not.toContain("untrusted funding error");
    if (error === "capability_expired") expect(errors.join("")).toContain("owner");
  });
  it.each(["address", "account", "global"])("prints the exact cap %s on cap_reached", async cap => {
    store(); gateway({ error: "cap_reached", cap }, 409);
    expect(await fund()).not.toBe(0);
    expect(errors.join("")).toContain("cap_reached");
    expect(errors.join("")).toContain(`cap: ${cap}`);
  });
  it("requires an approved active link and requestId before requesting funds", async () => {
    store("agent", "approved", null);
    const fetchSpy = gateway(FUNDED);
    expect(await fund()).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("approved_link_required");
  });
  it.each(["http://rpc.example", "http://192.168.0.2"])("refuses insecure RPC %s before a gateway request", async rpcUrl => {
    store(); const fetchSpy = gateway(FUNDED);
    expect(await fund("agent", ["--rpc-url", rpcUrl])).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("insecure_rpc_origin");
  });
  it("PCC_RPC_URL supplies the RPC origin and defaults remain Base Sepolia", async () => {
    store(); gateway(FUNDED);
    const waiter = vi.fn(async (_hash: `0x${string}`, _rpcUrl: string, _timeoutMs: number) => ({ status: "success" as const }));
    vi.stubEnv("PCC_RPC_URL", "http://localhost:8545");
    expect(await fund("agent", [], runtime({ waitForReceipt: waiter }))).toBe(0);
    expect(waiter.mock.calls[0]?.[1]).toBe("http://localhost:8545");
  });
});

async function rpc(status: "success" | "reverted" | "timeout") {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string; params: unknown[] };
      methods.push(payload.method);
      const result = payload.method === "eth_blockNumber" ? "0x1"
        : payload.method === "eth_getTransactionReceipt" && status !== "timeout" ? {
          transactionHash: payload.params[0], transactionIndex: "0x0", blockHash: TX_USDC,
          blockNumber: "0x1", from: "0x0000000000000000000000000000000000000001",
          to: "0x0000000000000000000000000000000000000002", cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
          logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", status: status === "success" ? "0x1" : "0x0",
        } : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub_address_unavailable");
  return { url: `http://127.0.0.1:${address.port}`, methods };
}

describe("Base Sepolia receipt RPC via a native loopback stub", () => {
  it.each(["success", "reverted", "timeout"] as const)("native RPC receipt %s", async status => {
    const stub = await rpc(status);
    store();
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === ORIGIN) return new Response(JSON.stringify(claimResponse(ETH)), { status: 200 });
      if (url.origin === stub.url) return originalFetch(input, init);
      throw new Error("unexpected_nonlocal_fetch");
    });
    const io = runtime();
    delete io.waitForReceipt;
    io.receiptTimeoutMs = 100;
    const result = await fund("agent", ["--rpc-url", stub.url], io);
    expect(stub.methods).toContain("eth_getTransactionReceipt");
    if (status === "success") {
      expect(result).toBe(0);
      expect(output.join("")).toContain("funded");
    } else {
      expect(result).not.toBe(0);
      expect(output.join("")).not.toContain("funded");
      expect(errors.join("")).toContain(status === "reverted" ? "funding_transaction_reverted" : "funding_receipt_timeout");
    }
  });
});

describe("receipt action using fetch spies", () => {
  function receipt(txHash: string, status: "0x1" | "0x0") {
    return {
      transactionHash: txHash, transactionIndex: "0x0", blockHash: TX_USDC,
      blockNumber: "0x1", from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002", cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
      logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", status,
    };
  }
  it.each(["success", "reverted", "timeout", "mismatched hash"] as const)("viem receipt %s", async (status) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      const result = payload.method === "eth_blockNumber" ? "0x1" : status === "timeout" ? null
        : receipt(status === "mismatched hash" ? TX_USDC : TX_ETH, status === "reverted" ? "0x0" : "0x1");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    });
    if (status === "timeout" || status === "mismatched hash") {
      await expect(waitForFundingReceipt(TX_ETH, "http://127.0.0.1:8545", 50)).rejects.toThrow(status === "timeout" ? "funding_receipt_timeout" : "funding_receipt_mismatch");
    } else {
      await expect(waitForFundingReceipt(TX_ETH, "http://127.0.0.1:8545", 50)).resolves.toEqual({ status });
    }
    expect(fetchSpy.mock.calls.every((call) => new URL(String(call[0])).origin === "http://127.0.0.1:8545")).toBe(true);
  });

  it("stalledfirst receipt request leaves no RPC polling after its timeout", async () => {
    let first = true;
    let cleanupLateWatcher = false;
    let block = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (first) {
        first = false;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException("request aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      const result = payload.method === "eth_blockNumber" ? `0x${(++block).toString(16)}`
        : cleanupLateWatcher ? receipt(TX_ETH, "0x1") : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    });
    await expect(waitForFundingReceipt(TX_ETH, "http://127.0.0.1:8545", 80)).rejects.toThrow("funding_receipt_timeout");
    const callsAtTimeout = fetchSpy.mock.calls.length;
    await new Promise<void>(resolve => setTimeout(resolve, 160));
    try {
      expect(fetchSpy.mock.calls.length).toBe(callsAtTimeout);
    } finally {
      // The reproduction leaves viem's watcher running. Let its next receipt
      // finish so the red run also releases that timer without any real RPC.
      if (fetchSpy.mock.calls.length > callsAtTimeout) {
        cleanupLateWatcher = true;
        await new Promise<void>(resolve => setTimeout(resolve, 1_100));
      }
    }
  });

  it("refuses a receipt budget below two milliseconds before RPC", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, result: receipt(TX_ETH, "0x1"),
    })));
    await expect(waitForFundingReceipt(TX_ETH, "http://127.0.0.1:8545", 1)).rejects.toThrow("invalid_receipt_timeout");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("W2 funding option boundaries", () => {
  it("init refuses insecure RPC before prompt, key creation or fetch", async () => {
    const fetchSpy = gateway(FUNDED);
    expect(await main(["init", "--role", "agent", "--label", "agent", "--gateway", ORIGIN, "--rpc-url", "http://rpc.example", "--yes"], runtime())).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("insecure_rpc_origin");
    expect(await (await import("node:fs/promises")).readdir(directory)).toEqual([]);
  });
  it("removed --usdc option is refused for devices before requests", async () => {
    const fetchSpy = gateway(FUNDED);
    expect(await main(["init", "--role", "device", "--label", "device", "--gateway", ORIGIN, "--usdc", "1", "--yes"], runtime())).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("invalid_wallet_option");
  });
  it.each(["0", "1", "2", "3", "4", "1.5"])("removed --usdc option %s is refused for agents before requests", async (usdc) => {
    store(); const fetchSpy = gateway(FUNDED);
    expect(await fund("agent", ["--usdc", usdc])).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("invalid_wallet_option");
  });
  it("bounds pending even with a frozen clock", async () => {
    store();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(PENDING)));
    expect(await fund("agent", [], runtime({ now: () => clock, sleep: async ms => { sleeps.push(ms); } }))).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(8);
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(errors.join("")).toContain("funding_pending");
  });
  it.each(["2", "3"])("refuses USDC response amount %s per the literal W2 contract", async amount => {
    gateway(claimResponse({ ...USDC, amount }));
    await expect(requestFunding(ORIGIN, REQUEST_ID, "agent")).rejects.toThrow("invalid_gateway_response");
  });
  it("rejects an explicitly empty RPC URL rather than substituting a default", async () => {
    store(); const fetchSpy = gateway(FUNDED);
    expect(await fund("agent", ["--rpc-url", ""])).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("invalid_rpc_origin");
  });
  it("partial waits for every supplied claim hash and still exits nonzero", async () => {
    store(); gateway(PARTIAL);
    const waiter = vi.fn(async () => ({ status: "success" as const }));
    expect(await fund("agent", [], runtime({ waitForReceipt: waiter }))).toBe(1);
    expect(waiter).toHaveBeenCalledTimes(5);
    expect(errors.join("")).toContain("funding_partial");
  });
});

it("wallet help exposes no --usdc input", async () => {
  expect(await main(["--help"], runtime())).toBe(0);
  expect(output.join("")).not.toContain("--usdc");
});

describe("funding 404 discrimination", () => {
  it.each(["link_request_not_found", "link_not_found", "other_code"])("404 %s is an error with its code, never route absent", async error => {
    store(); gateway({ error }, 404);
    expect(await fund()).toBe(1);
    expect(errors.join("")).toContain(error);
    expect(output.join("")).not.toContain("linked (unfunded)");
  });
  it("404 not_found with extra fields is an error", async () => {
    store(); gateway({ error: "not_found", extra: true }, 404);
    expect(await fund()).toBe(1);
    expect(errors.join("")).toContain("not_found");
  });
  it("non-JSON 404 is an error with invalid_gateway_response", async () => {
    store(); vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing route", { status: 404 }));
    expect(await fund()).toBe(1);
    expect(errors.join("")).toContain("invalid_gateway_response");
  });
});

describe("bounded receipt polling and RPC retries", () => {
  afterEach(() => { vi.useRealTimers(); });

  function rpcReceipt() {
    return {
      transactionHash: TX_ETH, transactionIndex: "0x0", blockHash: TX_USDC,
      blockNumber: "0x1", from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002", cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
      logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", status: "0x1",
    };
  }
  function reply(id: number, result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "content-type": "application/json" },
    });
  }
  function observedReceipt(timeoutMs = 10_000) {
    return waitForFundingReceipt(TX_ETH, "http://127.0.0.1:8545", timeoutMs).then(
      result => result.status,
      error => error instanceof Error ? error.message : String(error),
    );
  }
  function rpcError(code: number): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: "test RPC error" } }));
  }

  it("PROBE-P1 reads a receipt body that also carries error: null", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: rpcReceipt(), error: null })));
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("success");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("LOW-F1 polls a pending result with error: null again before reading the receipt", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts.push(Date.now() - started);
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: attempts.length === 1 ? null : rpcReceipt(), error: null,
      }));
    });
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempts).toEqual([0]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("success");
    expect(attempts).toEqual([0, 2_000]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-32602, -32005])("PROBE-E1 JSON-RPC error %s takes precedence over a matching receipt in HTTP 200", async code => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts.push(Date.now() - started);
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, error: { code, message: "test RPC error" }, result: rpcReceipt(),
      }));
    });
    const result = observedReceipt(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe(code === -32602 ? "funding_rpc_unavailable" : "funding_receipt_timeout");
    expect(attempts).toEqual(code === -32602 ? [0] : [0, 2_000, 4_000]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(code === -32602 ? 1 : 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([405, 407, 409, 410])("PROBE-X1 RPC HTTP %s stays permanent", async status => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("request refused", { status }));
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("funding_rpc_unavailable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-32000, -32004, -32006, -32600, -32601])("PROBE-X2 JSON-RPC %s inside HTTP 200 stays permanent", async code => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => rpcError(code));
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("funding_rpc_unavailable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("PROBE-NM1 transient -32005 with a data member (Infura shape) is retried then succeeds", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: {
        code: -32005, message: "daily request count exceeded, request rate limited",
        data: { rate: { allowed_rps: 1, backoff_seconds: 30, current_rps: 1.4 }, see: "https://infura.io/dashboard" },
      } })))
      .mockImplementation(async () => reply(1, rpcReceipt()));
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("success");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-32005, -32603])("transient JSON-RPC %s inside HTTP 200 is retried then succeeds", async code => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts.push(Date.now() - started);
      return attempts.length === 1 ? rpcError(code) : reply(1, rpcReceipt());
    });
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("success");
    expect(attempts).toEqual([0, 2_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("transient RPC HTTP 408 is retried then succeeds", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts.push(Date.now() - started);
      return attempts.length === 1 ? new Response("request timed out", { status: 408 }) : reply(1, rpcReceipt());
    });
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("success");
    expect(attempts).toEqual([0, 2_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("permanent JSON-RPC -32602 inside HTTP 200 fails without retrying", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => rpcError(-32602))
      .mockImplementation(async () => reply(1, rpcReceipt()));
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("funding_rpc_unavailable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-32005, -32603, 408])("persistent transient RPC %s exhausts the receipt budget without later polling", async failure => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts.push(Date.now() - started);
      return failure === 408 ? new Response("request timed out", { status: 408 }) : rpcError(failure);
    });
    const result = observedReceipt(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe("funding_receipt_timeout");
    expect(attempts).toEqual([0, 2_000, 4_000]);
    const callsAtTimeout = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(callsAtTimeout);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("receipt polls are at least 2000 ms apart", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    let block = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (payload.method === "eth_blockNumber") return reply(payload.id, `0x${(++block).toString(16)}`);
      attempts.push(Date.now() - started);
      return reply(payload.id, attempts.length < 3 ? null : rpcReceipt());
    });
    const result = observedReceipt();
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(attempts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toEqual([0, 2_000]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toBe("success");
      expect(attempts).toEqual([0, 2_000, 4_000]);
    } finally { await vi.runAllTimersAsync(); }
  });

  it.each([429, 500, 503, "network", "network body"] as const)("transient RPC %s is retried within the receipt budget", async failure => {
    vi.useFakeTimers();
    let attempts = 0;
    let block = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (payload.method === "eth_blockNumber") return reply(payload.id, `0x${(++block).toString(16)}`);
      attempts++;
      if (attempts === 1) return reply(payload.id, null);
      if (attempts === 2) {
        if (failure === "network") throw new TypeError("test network failure");
        if (failure === "network body") return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError("test connection reset during body")); },
        }));
        return new Response("temporarily unavailable", { status: failure });
      }
      return reply(payload.id, rpcReceipt());
    });
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("persistent 429s exhaust one receipt budget and leave no later RPC polling", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    let block = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (payload.method === "eth_blockNumber") return reply(payload.id, `0x${(++block).toString(16)}`);
      attempts.push(Date.now() - started);
      return new Response("rate limited", { status: 429 });
    });
    const result = observedReceipt(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe("funding_receipt_timeout");
    expect(attempts).toEqual([0, 2_000, 4_000]);
    const callsAtTimeout = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(callsAtTimeout);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404])("permanent RPC HTTP %s fails without retrying", async status => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (payload.method === "eth_blockNumber") return reply(payload.id, "0x1");
      attempts++;
      return new Response("request refused", { status });
    });
    const result = observedReceipt();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("funding_rpc_unavailable");
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("one overall receipt budget covers every funding claim", async () => {
    store(); gateway(FUNDED);
    const waiter = vi.fn(async (_hash: `0x${string}`, _rpcUrl: string, _timeoutMs: number) => {
      clock += 15_000;
      return { status: "success" as const };
    });
    expect(await fund("agent", [], runtime({ waitForReceipt: waiter, receiptTimeoutMs: 60_000 }))).toBe(1);
    expect(waiter).toHaveBeenCalledTimes(4);
    expect(waiter.mock.calls.map(call => call[2])).toEqual([60_000, 45_000, 30_000, 15_000]);
    expect(errors.join("")).toContain("funding_receipt_timeout");
    expect(output.join("")).not.toContain("funded");
  });

  it("a stalled receipt body is aborted at the overall deadline without later polling", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => { aborted = true; controller.error(new DOMException("aborted", "AbortError")); };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    });
    const result = observedReceipt(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe("funding_receipt_timeout");
    expect(aborted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("faucet errorClass safety", () => {
  it.each(["faucet_limit_exceeded", "rate_limit_exceeded", "unauthorized", "forbidden", "bad_gateway", "internal_server_error", "network_timeout", "network_connection_failed", "timeout", "invalid_tx_hash", "unknown"])("fund prints 502 faucet_error and errorClass %s", async errorClass => {
    store(); gateway({ error: "faucet_error", errorClass }, 502);
    expect(await fund()).toBe(1);
    expect(errors.join("")).toContain(`faucet_error, ${errorClass}`);
  });
  it.each([undefined, "untrusted diagnostic text", { nested: true }])("502 always prints a safe errorClass for %j", async errorClass => {
    store(); gateway({ error: "faucet_error", errorClass }, 502);
    expect(await fund()).toBe(1);
    expect(errors.join("")).toContain("faucet_error, unknown");
    expect(errors.join("")).not.toContain("untrusted diagnostic text");
  });
});

describe("receipt redirect rule", () => {
  it("H1rpc every receipt RPC request refuses redirects", async () => {
    const hash = `0x${"ab".repeat(32)}` as `0x${string}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      const result = payload.method === "eth_blockNumber" ? "0x1" : {
        transactionHash: hash, transactionIndex: "0x0", blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1",
        from: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000002",
        cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
        logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", status: "0x1",
      };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    });
    await expect(waitForFundingReceipt(hash, "http://127.0.0.1:8545", 50)).resolves.toEqual({ status: "success" });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(fetchSpy.mock.calls.every((call) => (call[1] as RequestInit | undefined)?.redirect === "error")).toBe(true);
  });
});

it("W2f partial refuses a succeeded claim without txHash", async () => {
  const claims = PARTIAL.claims.map((claim, index) => index === 0
    ? { token: "eth", amount: "0.0001", status: "succeeded" } : claim);
  gateway({ status: "partial", claims });
  await expect(requestFunding(ORIGIN, REQUEST_ID, "agent")).rejects.toThrow("invalid_gateway_response");
});
it("refuses four ETH claims for a device", async () => {
  gateway({ status: "funded", claims: realFundingClaims("device").slice(0, 4) });
  await expect(requestFunding(ORIGIN, REQUEST_ID, "device")).rejects.toThrow("invalid_gateway_response");
});
