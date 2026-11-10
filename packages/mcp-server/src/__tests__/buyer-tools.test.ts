import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hexToString, verifyMessage, type Hex } from "viem";
import type { BuyerConfig } from "../tools/buyer.js";

const GATEWAY = "http://localhost:3200";
const NEXT = "Use this address as userAgentId when you open a negotiation.";
const NO_SESSION = "No buyer session. Call pcc_buyer_sign_in first, or set PCC_API_KEY to a key minted from a wallet session.";
const INVALID = "The buyer signer settings are malformed. Check PCC_BUYER_PRIVATE_KEY, or PCC_BUYER_SIGNER_URL (https, or http on localhost) and PCC_BUYER_ADDRESS.";
const TEST_MONEY = "Test-network funds are not real money.";
const PAST_CHECK = "A verification is a past check at that block, not a live balance.";
const UNCONFIRMED = "couldn't confirm the network";
const SIGN_IN_DESCRIPTION = "Sign in as the buyer with this server's configured wallet signer (Sign-In with Ethereum), and keep the gateway's session key in memory for this server's later calls. Test network only: Base Sepolia (84532) or a local anvil chain (31337). Ends any previous buyer session first. Returns the proven wallet address to use as userAgentId when you open a negotiation. Moves no funds.";
const SIGN_OUT_DESCRIPTION = "End the buyer session: ask the gateway to revoke the session and its key, then forget both. Later calls use PCC_API_KEY again, if it is set.";
const STATUS_DESCRIPTION = "Read where a job's buyer funding stands, from the gateway's stored records (GET /api/jobs/:jobId/funding). Needs a buyer session (pcc_buyer_sign_in) or a PCC_API_KEY minted from a wallet session. Reports each paid scope's status, network and verification. A verification is a past check at a block, not a live balance.";
const JOB_DESCRIPTION = "The jobId from pcc_negotiate_commit's reply.";
const makeKey = () => "pcc_test_" + randomBytes(32).toString("hex");
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect?: RequestRedirect; credentials?: RequestCredentials; signal?: AbortSignal | null };
let buyer: typeof import("../tools/buyer.js");
let api: typeof import("../api.js");
let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;
let clock: number;
let privateKey: Hex;
let account: ReturnType<typeof privateKeyToAccount>;
let token: string;
let sessionKey: string;
let expiresAt: string;
let nonce: string;
let answer: (call: Call) => Response | Promise<Response>;
let routeOverride: ((call: Call) => Response | Promise<Response> | undefined) | undefined;
const clients: Client[] = [];
const servers: McpServer[] = [];
const signatureSpies: Array<ReturnType<typeof vi.spyOn>> = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  vi.resetModules();
  for (const name of ["PCC_API_KEY", "PCC_BUYER_PRIVATE_KEY", "PCC_BUYER_SIGNER_URL", "PCC_BUYER_ADDRESS", "PCC_BUYER_CHAIN_ID"]) vi.stubEnv(name, undefined);
  vi.stubEnv("PCC_URL", GATEWAY);
  clock = Date.parse("2026-11-09T05:00:00.000Z");
  privateKey = generatePrivateKey();
  account = privateKeyToAccount(privateKey);
  token = randomUUID();
  sessionKey = makeKey();
  expiresAt = new Date(clock + 3_600_000).toISOString();
  nonce = randomBytes(16).toString("hex");
  calls = [];
  routeOverride = undefined;
  answer = async call => {
    const override = await routeOverride?.(call);
    if (override) return override;
    const path = new URL(call.url).pathname;
    if (path === "/api/auth/nonce") return json({ nonce });
    if (path === "/api/auth/verify") return json({ token, address: account.address, expiresAt });
    if (path === "/api/auth/session-key") return json({ api_key: sessionKey, operator_id: account.address, expires_at: expiresAt }, 201);
    if (path === "/api/auth/logout") return json({ ok: true });
    if (path === "/api/negotiate/session") return json({ id: "negotiation-1" });
    throw new Error("Unexpected mock route");
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {
      url: input instanceof Request ? input.url : String(input), method: init?.method ?? "GET", headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect, credentials: init?.credentials, signal: init?.signal,
    };
    calls.push(call);
    return answer(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  buyer = await import("../tools/buyer.js");
  api = await import("../api.js");
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  signatureSpies.splice(0);
  api.setSessionBearerProvider(undefined);
  api.setRedactionSecretsProvider(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function config(extra: Record<string, string | undefined> = {}) {
  return buyer.buyerConfigFromEnv({ PCC_URL: GATEWAY, PCC_BUYER_PRIVATE_KEY: privateKey, ...extra });
}
async function harness(cfg: BuyerConfig = config(), negotiate = false, timeoutMs = 1000) {
  if (cfg.signer?.kind === "local") signatureSpies.push(vi.spyOn(cfg.signer.account, "signMessage"));
  const server = new McpServer({ name: "buyer-test", version: "0.0.0" });
  buyer.registerBuyerTools(server, cfg, { fetchImpl: fetchMock as typeof fetch, now: () => clock, timeoutMs });
  if (negotiate) (await import("../tools/negotiate.js")).registerNegotiateTools(server);
  servers.push(server);
  return connect(server);
}
async function connect(server: McpServer) {
  const client = new Client({ name: "buyer-client", version: "0.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const raw = await client.callTool({ name, arguments: args });
      const text = (raw.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");
      let data: any;
      try { data = JSON.parse(text); } catch { data = undefined; }
      return { raw, text, data };
    },
  };
}
function zeroWork() {
  expect(fetchMock).not.toHaveBeenCalled();
  for (const spy of signatureSpies) expect(spy).not.toHaveBeenCalled();
}
function expectRefusal(reply: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["call"]>>, error: string, message: string) {
  expect(reply.raw.isError).toBe(true);
  expect(reply.data).toEqual({ error, message });
}
function secureRequests() {
  for (const call of calls) {
    expect(call.redirect).toBe("error");
    expect(call.credentials).toBe("omit");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  }
}
const negotiateArgs = { userAgentId: "buyer", kernelId: "kernel-1", capabilityType: "fdm-printer" };

// Each test name begins with the FINAL's cell id, so a mutant can target it alone.
describe("buyer preconditions", () => {
  it("P1 missing signer refuses before any work", async () => {
    const h = await harness(config({ PCC_BUYER_PRIVATE_KEY: undefined }));
    expectRefusal(await h.call("pcc_buyer_sign_in"), "BUYER_SIGNER_MISSING", "No buyer signer is configured. Set PCC_BUYER_SIGNER_URL and PCC_BUYER_ADDRESS for an external signer, or PCC_BUYER_PRIVATE_KEY for a dedicated test-network wallet.");
    zeroWork();
  });
  it("P2 ambiguous signer refuses before any work", async () => {
    const h = await harness(config({ PCC_BUYER_SIGNER_URL: "http://localhost:8545", PCC_BUYER_ADDRESS: account.address }));
    expectRefusal(await h.call("pcc_buyer_sign_in"), "BUYER_SIGNER_AMBIGUOUS", "Configure one buyer signer: PCC_BUYER_SIGNER_URL with PCC_BUYER_ADDRESS, or PCC_BUYER_PRIVATE_KEY, not both.");
    zeroWork();
  });
  it.each(["short-key", "zero-key", "url-only", "address-only", "http-remote", "short-address"])("P3 malformed signer %s has no work or value echo", async kind => {
    const external = { PCC_BUYER_PRIVATE_KEY: undefined, PCC_BUYER_SIGNER_URL: "http://localhost:8545", PCC_BUYER_ADDRESS: account.address };
    let extra: Record<string, string | undefined>;
    let bad: string;
    if (kind === "short-key") { bad = privateKey.slice(0, -1); extra = { PCC_BUYER_PRIVATE_KEY: bad }; }
    else if (kind === "zero-key") { bad = "0x" + "0".repeat(64); extra = { PCC_BUYER_PRIVATE_KEY: bad }; }
    else if (kind === "url-only") { bad = external.PCC_BUYER_SIGNER_URL; extra = { ...external, PCC_BUYER_ADDRESS: undefined }; }
    else if (kind === "address-only") { bad = account.address; extra = { ...external, PCC_BUYER_SIGNER_URL: undefined }; }
    else if (kind === "http-remote") { bad = "http://example.com"; extra = { ...external, PCC_BUYER_SIGNER_URL: bad }; }
    else { bad = account.address.slice(0, -1); extra = { ...external, PCC_BUYER_ADDRESS: bad }; }
    const h = await harness(config(extra));
    const reply = await h.call("pcc_buyer_sign_in");
    expectRefusal(reply, "BUYER_SIGNER_INVALID", INVALID);
    expect(reply.text.toLowerCase()).not.toContain(bad.toLowerCase());
    expect(reply.text.toLowerCase()).not.toContain(bad.replace(/^0x/, "").toLowerCase());
    zeroWork();
  });
  it.each(["8453", "1", "abc", "84532.0", " 845320"])("P4 chain %s refuses before any work", async chain => {
    const h = await harness(config({ PCC_BUYER_CHAIN_ID: chain }));
    expectRefusal(await h.call("pcc_buyer_sign_in"), "BUYER_CHAIN_REFUSED", "Buyer tools run only on a test network: PCC_BUYER_CHAIN_ID must be 84532 (Base Sepolia) or 31337 (a local anvil chain).");
    zeroWork();
  });
  it("P5 insecure gateway refuses before any work", async () => {
    const h = await harness(config({ PCC_URL: "http://example.com" }));
    expectRefusal(await h.call("pcc_buyer_sign_in"), "BUYER_GATEWAY_INSECURE", "Buyer sign-in needs PCC_URL on https (http only on localhost).");
    zeroWork();
  });
  it.each(["https://user:pass@example.com", "https://example.com?query", "https://example.com#fragment", "https://example.com\\path", " https://example.com"])("P5 gateway URL rule rejects %s", async gateway => {
    const h = await harness(config({ PCC_URL: gateway }));
    expectRefusal(await h.call("pcc_buyer_sign_in"), "BUYER_GATEWAY_INSECURE", "Buyer sign-in needs PCC_URL on https (http only on localhost).");
    zeroWork();
  });
  it("P6 sign-out without a session does no work", async () => {
    const h = await harness();
    expectRefusal(await h.call("pcc_buyer_sign_out"), "BUYER_NOT_SIGNED_IN", NO_SESSION);
    zeroWork();
  });
  it("P7 status without a bearer does no work", async () => {
    const h = await harness();
    expectRefusal(await h.call("pcc_buyer_order_status", { jobId: "job-1" }), "BUYER_NOT_SIGNED_IN", NO_SESSION);
    zeroWork();
  });
  it("P8 expired session does not authorize a read", async () => {
    const h = await harness();
    expect((await h.call("pcc_buyer_sign_in")).data.signedIn).toBe(true);
    clock = Date.parse(expiresAt) + 1;
    fetchMock.mockClear();
    signatureSpies.forEach(spy => spy.mockClear());
    expectRefusal(await h.call("pcc_buyer_order_status", { jobId: "job-1" }), "BUYER_NOT_SIGNED_IN", NO_SESSION);
    zeroWork();
  });
  it.each([
    ["BUYER_SIGNER_MISSING", { PCC_BUYER_PRIVATE_KEY: undefined }],
    ["BUYER_SIGNER_AMBIGUOUS", { PCC_BUYER_ADDRESS: "0x" + "1".repeat(40) }],
    ["BUYER_SIGNER_INVALID", { PCC_BUYER_PRIVATE_KEY: "0x" + "0".repeat(64) }],
    ["BUYER_CHAIN_REFUSED", {}],
  ] as const)("P1-P5 order: %s is reported before a refused chain and an insecure gateway", async (error, extra) => {
    const h = await harness(config({ ...extra, PCC_BUYER_CHAIN_ID: "8453", PCC_URL: "http://example.com" }));
    expectRefusal(await h.call("pcc_buyer_sign_in"), error, buyer.BUYER_ERROR_TEXTS[error]);
    zeroWork();
  });
});

describe("buyer session", () => {
  it.each([GATEWAY, "http://127.0.0.1:3200"])("S1 hot-key sign-in at %s binds exact SIWE and transport", async gateway => {
    vi.stubEnv("PCC_API_KEY", makeKey());
    vi.resetModules();
    buyer = await import("../tools/buyer.js");
    api = await import("../api.js");
    const h = await harness(config({ PCC_URL: gateway }));
    const reply = await h.call("pcc_buyer_sign_in");
    expect(reply.raw.isError).not.toBe(true);
    expect(reply.data).toEqual({ signedIn: true, address: account.address, chainId: 84532, expiresAt, next: NEXT });
    const { buildBuyerSignInMessage } = await import("../tools/buyer-session.js");
    const expected = `${new URL(gateway).host} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Physical Capability Cloud as a buyer.\n\nURI: ${gateway}\nVersion: 1\nChain ID: 84532\nNonce: ${nonce}\nIssued At: ${new Date(clock).toISOString()}`;
    expect(buildBuyerSignInMessage({ domain: new URL(gateway).host, address: account.address, uri: gateway, chainId: 84532, nonce, issuedAt: new Date(clock).toISOString() })).toBe(expected);
    expect(calls.map(c => [c.url, c.method])).toEqual([
      [gateway + "/api/auth/nonce", "GET"], [gateway + "/api/auth/verify", "POST"], [gateway + "/api/auth/session-key", "POST"],
    ]);
    expect(calls[0].headers).toEqual({ accept: "application/json" });
    expect(calls[0].body).toBeUndefined();
    expect(calls[1].headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    expect(calls[1].body).toEqual({ message: expected, signature: expect.stringMatching(/^0x[0-9a-f]+$/i) });
    expect(await verifyMessage({ address: account.address, message: expected, signature: (calls[1].body as { signature: Hex }).signature })).toBe(true);
    expect(calls[2].headers).toEqual({ authorization: `Bearer ${token}`, accept: "application/json" });
    expect(calls[2].body).toBeUndefined();
    secureRequests();
  });
  it("S2 external signer signs once and wrong signatures never reach verify", async () => {
    const signerUrl = "http://localhost:8545";
    let wrong = false;
    const other = privateKeyToAccount(generatePrivateKey());
    routeOverride = async call => {
      if (new URL(call.url).origin !== signerUrl) return undefined;
      const body = call.body as { jsonrpc: string; id: number; method: string; params: [Hex, string] };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("personal_sign");
      expect(body.params[1].toLowerCase()).toBe(account.address.toLowerCase());
      const message = hexToString(body.params[0]);
      expect(message).toContain("Sign in to Physical Capability Cloud as a buyer.");
      return json({ jsonrpc: "2.0", id: body.id, result: await (wrong ? other : account).signMessage({ message }) });
    };
    const h = await harness(config({ PCC_BUYER_PRIVATE_KEY: undefined, PCC_BUYER_SIGNER_URL: signerUrl, PCC_BUYER_ADDRESS: account.address.toLowerCase() }));
    expect((await h.call("pcc_buyer_sign_in")).data.signedIn).toBe(true);
    expect(calls.filter(c => new URL(c.url).origin === signerUrl)).toHaveLength(1);
    expect(calls.map(c => c.method)).toEqual(["GET", "POST", "POST", "POST"]);
    expect(calls[1].headers).toEqual({ "content-type": "application/json" });
    secureRequests();
    await h.call("pcc_buyer_sign_out");
    calls = [];
    wrong = true;
    const failed = await h.call("pcc_buyer_sign_in");
    expect(failed.data.error).toBe("BUYER_SIGN_IN_FAILED");
    expect(failed.data.step).toBe("sign");
    expect(failed.data.status).toBe(200);
    expect(calls.filter(c => new URL(c.url).origin === signerUrl)).toHaveLength(1);
    expect(calls.some(c => c.url.endsWith("/verify"))).toBe(false);
  });
  it.each([
    ["nonce", 503, "status"], ["verify", 401, "status"], ["verify", 200, "address"],
    ["session_key", 401, "status"], ["session_key", 429, "status"],
    ["session_key", 201, "address"], ["session_key", 201, "key"],
  ] as const)("S3 failed %s %i %s forgets all state", async (step, status, fault) => {
    routeOverride = call => {
      const path = step === "session_key" ? "session-key" : step;
      if (!call.url.endsWith("/" + path)) return undefined;
      if (fault === "status") return json({ untrusted: "DO NOT REPEAT THIS" }, status);
      if (step === "verify") return json({ token, address: privateKeyToAccount(generatePrivateKey()).address }, status);
      return json({ api_key: fault === "key" ? "x" : sessionKey, operator_id: fault === "address" ? privateKeyToAccount(generatePrivateKey()).address : account.address, expires_at: expiresAt }, status);
    };
    const h = await harness();
    const failed = await h.call("pcc_buyer_sign_in");
    expect(failed.raw.isError).toBe(true);
    expect(failed.data).toEqual({ error: "BUYER_SIGN_IN_FAILED", step, status, message: `Sign-in failed at the ${step} step (HTTP ${status}). No session was kept.` });
    expect(failed.text).not.toContain("DO NOT REPEAT");
    fetchMock.mockClear();
    signatureSpies.forEach(spy => spy.mockClear());
    expectRefusal(await h.call("pcc_buyer_order_status", { jobId: "job-1" }), "BUYER_NOT_SIGNED_IN", NO_SESSION);
    zeroWork();
  });
  it.each([
    ["nonce", "nonce"], ["verify", "token"], ["session_key", "expiry"],
  ] as const)("S3 malformed %s field %s leaves no session", async (step, field) => {
    routeOverride = call => {
      const path = step === "session_key" ? "session-key" : step;
      if (!call.url.endsWith("/" + path)) return undefined;
      if (field === "nonce") return json({ nonce: "bad nonce" });
      if (field === "token") return json({ token: "space in token", address: account.address });
      return json({ api_key: sessionKey, operator_id: account.address, expires_at: new Date(clock).toISOString() }, 201);
    };
    const h = await harness();
    const reply = await h.call("pcc_buyer_sign_in");
    expect(reply.data).toMatchObject({ error: "BUYER_SIGN_IN_FAILED", step, status: step === "session_key" ? 201 : 200 });
    fetchMock.mockClear();
    expectRefusal(await h.call("pcc_buyer_order_status", { jobId: "job-1" }), "BUYER_NOT_SIGNED_IN", NO_SESSION);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["network", "timeout", "body-timeout"])("S3 %s at nonce returns a fixed failure and aborts", async fault => {
    answer = fault === "network" ? async () => { throw new Error("untrusted transport text"); }
      : fault === "timeout" ? () => new Promise<Response>(() => {})
      : () => { const reply = json({ nonce }); vi.spyOn(reply, "json").mockImplementation(() => new Promise(() => {})); return reply; };
    const h = await harness(config(), false, 5);
    const reply = await h.call("pcc_buyer_sign_in");
    expect(reply.data).toEqual({ error: "BUYER_SIGN_IN_FAILED", step: "nonce", status: fault === "body-timeout" ? 200 : null,
      message: fault === "body-timeout" ? "Sign-in failed at the nonce step (HTTP 200). No session was kept." : "Sign-in failed at the nonce step. No session was kept." });
    expect(reply.text).not.toContain("untrusted");
    if (fault !== "network") expect(calls[0].signal?.aborted).toBe(true);
    secureRequests();
  });
  it("S4 re-sign-in logs out with the old token before the new nonce", async () => {
    const h = await harness();
    await h.call("pcc_buyer_sign_in");
    const oldToken = token;
    token = randomUUID();
    calls = [];
    await h.call("pcc_buyer_sign_in");
    expect(calls.map(c => [new URL(c.url).pathname, c.method])).toEqual([
      ["/api/auth/logout", "POST"], ["/api/auth/nonce", "GET"], ["/api/auth/verify", "POST"], ["/api/auth/session-key", "POST"],
    ]);
    expect(calls[0].headers).toEqual({ authorization: `Bearer ${oldToken}` });
    expect(calls[0].body).toBeUndefined();
    secureRequests();
  });
  it.each([true, false])("S5 session provider is gateway-bound: matching=%s", async matching => {
    const fallback = makeKey();
    vi.stubEnv("PCC_API_KEY", fallback);
    vi.resetModules();
    buyer = await import("../tools/buyer.js");
    api = await import("../api.js");
    const h = await harness(config({ PCC_URL: matching ? GATEWAY : "http://localhost:3300" }), true);
    await h.call("pcc_negotiate_create", negotiateArgs);
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${fallback}`);
    await h.call("pcc_buyer_sign_in");
    await h.call("pcc_negotiate_create", negotiateArgs);
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${matching ? sessionKey : fallback}`);
    expect(calls.at(-1)?.url).toBe(GATEWAY + "/api/negotiate/session");
    expect(calls.at(-1)?.body).toEqual(negotiateArgs);
    await h.call("pcc_buyer_sign_out");
    await h.call("pcc_negotiate_create", negotiateArgs);
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${fallback}`);
  });
  it.each([200, 500])("S6 logout %i forgets the key and reports revocation", async status => {
    const h = await harness(config(), true);
    await h.call("pcc_buyer_sign_in");
    routeOverride = c => c.url.endsWith("/logout") ? json({ untrusted: "not output" }, status) : undefined;
    const reply = await h.call("pcc_buyer_sign_out");
    expect(reply.data).toEqual({ signedOut: true, revoked: status === 200,
      ...(status !== 200 ? { note: `The gateway didn't confirm the revocation; the session key still expires at ${expiresAt}.` } : {}),
    });
    expect(calls.at(-1)).toMatchObject({ url: GATEWAY + "/api/auth/logout", method: "POST", headers: { authorization: `Bearer ${token}` }, body: undefined });
    secureRequests();
    await h.call("pcc_negotiate_create", negotiateArgs);
    expect(calls.at(-1)?.headers.authorization).toBeUndefined();
  });
  it("S1 trimmed local chain on IPv6 uses a fixed buyer statement", async () => {
    const h = await harness(config({ PCC_URL: "http://[::1]:3200", PCC_BUYER_CHAIN_ID: " 31337 " }));
    expect((await h.call("pcc_buyer_sign_in")).data.chainId).toBe(31337);
    expect((calls[1].body as { message: string }).message).toContain("Chain ID: 31337");
    secureRequests();
  });
  it("S4 simultaneous sign-ins run in order: the second logs out the first session before its nonce", async () => {
    const h = await harness();
    const tokens = [randomUUID(), randomUUID()];
    let verified = 0;
    routeOverride = call => call.url.endsWith("/api/auth/verify") ? json({ token: tokens[verified++], address: account.address, expiresAt }) : undefined;
    const replies = await Promise.all([h.call("pcc_buyer_sign_in"), h.call("pcc_buyer_sign_in")]);
    expect(replies.map(reply => reply.data.signedIn)).toEqual([true, true]);
    expect(calls.map(c => new URL(c.url).pathname)).toEqual([
      "/api/auth/nonce", "/api/auth/verify", "/api/auth/session-key",
      "/api/auth/logout", "/api/auth/nonce", "/api/auth/verify", "/api/auth/session-key",
    ]);
    expect(calls[3].headers).toEqual({ authorization: `Bearer ${tokens[0]}` });
    secureRequests();
  });
  it("S2 a signer answering 500 is asked exactly once and verify is never sent", async () => {
    const signerUrl = "http://localhost:8545";
    routeOverride = call => new URL(call.url).origin === signerUrl ? json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal" } }, 500) : undefined;
    const h = await harness(config({ PCC_BUYER_PRIVATE_KEY: undefined, PCC_BUYER_SIGNER_URL: signerUrl, PCC_BUYER_ADDRESS: account.address }));
    const reply = await h.call("pcc_buyer_sign_in");
    expect(reply.data).toEqual({ error: "BUYER_SIGN_IN_FAILED", step: "sign", status: 500, message: "Sign-in failed at the sign step (HTTP 500). No session was kept." });
    expect(calls.filter(c => new URL(c.url).origin === signerUrl)).toHaveLength(1);
    expect(calls.some(c => c.url.endsWith("/api/auth/verify"))).toBe(false);
  });
});

function dto(patch: Record<string, unknown> = {}) {
  return { scopeId: "scope-1", state: "funded_verified", scope: { sourceStatus: "active" }, verification: { blockNumber: "123" }, deployment: { chainClass: "testnet", basis: "recorded" }, ...patch };
}
async function readScope(scope: Record<string, unknown>) {
  routeOverride = c => c.url.endsWith("/funding") ? json({ jobId: "job-1", scopes: [scope] }) : undefined;
  const h = await harness();
  await h.call("pcc_buyer_sign_in");
  const reply = await h.call("pcc_buyer_order_status", { jobId: "job-1" });
  expect(reply.raw.isError).not.toBe(true);
  expect(reply.text.toLowerCase()).not.toMatch(/held|balance:/);
  expect(reply.data.scopes[0].record).toEqual(scope);
  return reply.data.scopes[0];
}

describe("buyer status", () => {
  it("O1 recorded testnet active scope has exact status, network and block words", async () => {
    const scope = dto();
    expect(await readScope(scope)).toEqual({ scopeId: "scope-1", status: "active", network: "test network", verification: "verified at block 123 against the recorded deployment", notes: [TEST_MONEY, PAST_CHECK], record: scope });
  });
  it("O2 local deployment is a test network", async () => {
    const view = await readScope(dto({ deployment: { chainClass: "local", basis: "recorded" } }));
    expect(view.network).toBe("test network");
    expect(view.notes).toEqual([TEST_MONEY, PAST_CHECK]);
  });
  it("O3 unknown chain does not derive a network from the schedule flag", async () => {
    const view = await readScope(dto({ deployment: { chainClass: "unknown", scheduleTestnetOnly: true } }));
    expect(view.network).toBe(UNCONFIRMED);
    expect(view.notes).toEqual([PAST_CHECK]);
  });
  it("O4 null deployment has no confirmed network", async () => {
    const view = await readScope(dto({ deployment: null }));
    expect(view.network).toBe(UNCONFIRMED);
    expect(view.notes).toEqual([PAST_CHECK]);
  });
  it("O5 v1 never infers the network from verification.chainId", async () => {
    const scope = dto({ verification: { blockNumber: "123", chainId: 84532 } });
    delete (scope as Record<string, unknown>).deployment;
    const view = await readScope(scope);
    expect(view.network).toBe(UNCONFIRMED);
    expect(view.verification).toBe("verified at block 123");
    expect(view.notes).toEqual([PAST_CHECK]);
  });
  it("O6 configured mainnet record keeps its network and basis", async () => {
    const view = await readScope(dto({ deployment: { chainClass: "mainnet", basis: "configured" } }));
    expect(view.network).toBe("mainnet");
    expect(view.verification).toBe("verified at block 123 against the configured deployment");
    expect(view.notes).toEqual([PAST_CHECK]);
  });
  it("O7 awaiting_funding has the human status text", async () => {
    expect((await readScope(dto({ state: "awaiting_funding" }))).status).toBe("awaiting funding");
  });
  it.each(["awaiting_funding", "expired"])("O8 funded verification with source %s is not active", async sourceStatus => {
    expect((await readScope(dto({ scope: { sourceStatus } }))).status).toBe("funded_verified");
  });
  it.each(["unknown", "active"])("O9 source active with DTO state %s is unknown", async state => {
    expect((await readScope(dto({ state }))).status).toBe("unknown");
  });
  it.each(["prepared", "expired", "cancelled"])("O10 state %s passes through", async state => {
    expect((await readScope(dto({ state }))).status).toBe(state);
  });
  it("O11 no scopes carries the exact empty-list note", async () => {
    routeOverride = c => c.url.endsWith("/funding") ? json({ jobId: "job-1", scopes: [] }) : undefined;
    const h = await harness();
    await h.call("pcc_buyer_sign_in");
    expect((await h.call("pcc_buyer_order_status", { jobId: "job-1" })).data).toEqual({ jobId: "job-1", scopes: [], note: "The gateway reports no paid scope for this job." });
  });
  it.each([null, {}, { blockNumber: 123 }, { blockNumber: "-1" }, { blockNumber: "1".repeat(31) }])("O5 malformed verification %j has no verification text", async verification => {
    const view = await readScope(dto({ deployment: null, verification }));
    expect(view.verification).toBeNull();
    expect(view.notes).toEqual([]);
  });
  it.each(["network", "timeout"])("O12 %s gives a fixed failure without transport text", async fault => {
    const h = await harness(config(), false, 5);
    await h.call("pcc_buyer_sign_in");
    answer = fault === "network" ? async () => { throw new Error("untrusted transport text"); } : () => new Promise<Response>(() => {});
    const reply = await h.call("pcc_buyer_order_status", { jobId: "job-1" });
    expect(reply.data).toEqual({ error: "BUYER_STATUS_FAILED", status: null, message: "The funding read failed." });
    if (fault === "timeout") expect(calls.at(-1)?.signal?.aborted).toBe(true);
    secureRequests();
  });
  it.each([
    [401, "BUYER_NOT_SIGNED_IN", NO_SESSION],
    [403, "BUYER_IDENTITY_UNVERIFIED", "The gateway shows a job's funding only to a proven wallet. Call pcc_buyer_sign_in, or use a key minted from a wallet session."],
    [404, "BUYER_JOB_NOT_FOUND", "The gateway has no job with this id that this buyer can read."],
    [503, "BUYER_STATUS_UNAVAILABLE", "The gateway couldn't read the job's funding records. Try again shortly."],
    [500, "BUYER_STATUS_FAILED", "The funding read failed (HTTP 500)."],
    [200, "BUYER_STATUS_FAILED", "The funding read failed (malformed reply)."],
  ] as const)("O12 HTTP %i maps to fixed refusal with authenticated encoded GET", async (status, error, message) => {
    const fallback = makeKey();
    vi.stubEnv("PCC_API_KEY", fallback);
    vi.resetModules();
    buyer = await import("../tools/buyer.js");
    api = await import("../api.js");
    const h = await harness();
    const jobId = "job /?#%";
    const untrusted = "UNTRUSTED BODY " + randomUUID();
    routeOverride = c => c.url.endsWith("/funding") ? json(status === 200 ? {} : { error: "identity_unverified", untrusted }, status) : undefined;
    for (const bearer of [fallback, sessionKey]) {
      if (bearer === sessionKey) await h.call("pcc_buyer_sign_in");
      const reply = await h.call("pcc_buyer_order_status", { jobId });
      expect(reply.raw.isError).toBe(true);
      expect(reply.data).toEqual({ error, message, ...(status === 500 ? { status } : {}) });
      expect(reply.text).not.toContain(untrusted);
      expect(calls.at(-1)).toMatchObject({ url: GATEWAY + `/api/jobs/${encodeURIComponent(jobId)}/funding`, method: "GET", headers: { authorization: `Bearer ${bearer}`, accept: "application/json" }, body: undefined });
      secureRequests();
    }
  });
  it.each([
    ["another job", { jobId: "job-2", scopes: [dto()] }],
    ["a scope with no scopeId", { jobId: "job-1", scopes: [dto(), { state: "funded_verified" }] }],
    ["a numeric scopeId", { jobId: "job-1", scopes: [dto({ scopeId: 7 })] }],
  ] as const)("O12 a 200 naming %s is a malformed reply", async (_row, body) => {
    routeOverride = c => c.url.endsWith("/funding") ? json(body) : undefined;
    const h = await harness();
    await h.call("pcc_buyer_sign_in");
    expectRefusal(await h.call("pcc_buyer_order_status", { jobId: "job-1" }), "BUYER_STATUS_FAILED", "The funding read failed (malformed reply).");
  });
});

describe("buyer registration and secret boundaries", () => {
  it("H1 exact descriptions, hints and inline input shapes", async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    expect(tools.map(t => t.name)).toEqual([...buyer.BUYER_TOOL_NAMES]);
    const [signIn, signOut, status] = tools;
    expect(signIn.description).toBe(SIGN_IN_DESCRIPTION);
    expect(signOut.description).toBe(SIGN_OUT_DESCRIPTION);
    expect(status.description).toBe(STATUS_DESCRIPTION);
    expect(signIn.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(signOut.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(status.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(signIn.inputSchema.properties).toEqual({});
    expect(signOut.inputSchema.properties).toEqual({});
    expect(status.inputSchema.properties).toEqual({ jobId: { type: "string", minLength: 1, maxLength: 200, description: JOB_DESCRIPTION } });
    expect(status.inputSchema.required).toEqual(["jobId"]);
    expect(buyer.BUYER_TOOL_TEXTS).toEqual({ S26: SIGN_IN_DESCRIPTION, S27: SIGN_OUT_DESCRIPTION, S28: STATUS_DESCRIPTION, S29: JOB_DESCRIPTION });
    expect(Object.isFrozen(buyer.BUYER_TOOL_TEXTS)).toBe(true);
    expect(Object.isFrozen(buyer.BUYER_ERROR_TEXTS)).toBe(true);
  });
  it("G1 real server with no buyer env retains every CORE tool and adds all three buyer tools", async () => {
    const { server } = await import("../index.js");
    servers.push(server);
    const h = await connect(server);
    const { tools } = await h.client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      ...buyer.BUYER_TOOL_NAMES, "pcc_list_capabilities", "pcc_search_capabilities", "pcc_build_options", "pcc_calculate_price", "pcc_build_contract",
      "pcc_negotiate_create", "pcc_negotiate_get", "pcc_negotiate_select", "pcc_negotiate_quote", "pcc_negotiate_review", "pcc_negotiate_commit", "pcc_negotiate_cancel",
      "pcc_list_escrows", "pcc_get_escrow", "pcc_get_escrow_events",
    ]));
    expect(new Set(names).size).toBe(names.length);
    // This count is measured through tools/list, and pins the README catalog heading.
    expect(tools).toHaveLength(80);
  });
  it("F1 pccFetch redacts every sent bearer and fallback occurrence, preserving other replies", async () => {
    const fallback = makeKey();
    const bearer = makeKey();
    vi.stubEnv("PCC_API_KEY", fallback);
    vi.resetModules();
    api = await import("../api.js");
    api.setSessionBearerProvider(() => bearer);
    answer = () => new Response(`${bearer}/${fallback}/${bearer}`, { status: 500 });
    await expect(api.pccFetch("/failure")).rejects.toThrow("PCC API 500: [redacted]/[redacted]/[redacted]");
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${bearer}`);
    answer = () => new Response("ordinary failure", { status: 500 });
    await expect(api.pccFetch("/failure")).rejects.toThrow("PCC API 500: ordinary failure");
    api.setSessionBearerProvider(undefined);
    answer = () => new Response(fallback, { status: 500 });
    await expect(api.pccFetch("/failure")).rejects.toThrow("PCC API 500: [redacted]");
  });
  it("F1 r2 redacts case variants and treats regexp characters as literal secrets", async () => {
    const fallback = makeKey();
    const bearer = makeKey();
    const secret = randomUUID() + "[.*+?^${}()|\\]";
    vi.stubEnv("PCC_API_KEY", fallback);
    vi.resetModules();
    api = await import("../api.js");
    api.setSessionBearerProvider(() => bearer);
    api.setRedactionSecretsProvider(() => [secret, ""]);
    answer = () => new Response([bearer.toUpperCase(), fallback.toUpperCase(), secret.toUpperCase(), secret].join("/"), { status: 500 });
    const message = await api.pccFetch("/failure").catch((error: Error) => error.message);
    expect(message === "PCC API 500: [redacted]/[redacted]/[redacted]/[redacted]").toBe(true);
  });
  it("K1 r2 reads the original env on each call and forgets session secrets on sign-out", async () => {
    const env: Record<string, string | undefined> = { PCC_URL: GATEWAY, PCC_BUYER_PRIVATE_KEY: privateKey };
    const h = await harness(buyer.buyerConfigFromEnv(env), true);
    await h.call("pcc_buyer_sign_in");
    // The signing account remains the original account; only the env secret changes.
    const nextKey = generatePrivateKey();
    env.PCC_BUYER_PRIVATE_KEY = nextKey;
    const body = [nextKey.toUpperCase(), nextKey.slice(2), token.toUpperCase(), sessionKey.toUpperCase()].join("/");
    routeOverride = call => call.url.endsWith("/api/negotiate/session") ? new Response(body, { status: 500 }) : undefined;
    const signedIn = await h.call("pcc_negotiate_create", negotiateArgs);
    expect(signedIn.text === "PCC API 500: [redacted]/[redacted]/[redacted]/[redacted]").toBe(true);
    await h.call("pcc_buyer_sign_out");
    const signedOut = await h.call("pcc_negotiate_create", negotiateArgs);
    expect(signedOut.text === `PCC API 500: [redacted]/[redacted]/${token.toUpperCase()}/${sessionKey.toUpperCase()}`).toBe(true);
    env.PCC_BUYER_PRIVATE_KEY = undefined;
    const removed = await h.call("pcc_negotiate_create", negotiateArgs);
    expect(removed.text === `PCC API 500: ${body}`).toBe(true);
  });
  it("K1 echoed secrets never appear in results, errors or logs", async () => {
    const outputs: string[] = [];
    const logs: string[] = [];
    for (const name of ["log", "error", "warn", "info", "debug", "trace"] as const) vi.spyOn(console, name).mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write);
    const echo = { privateKey, token, api_key: sessionKey };
    let failSignIn = true;
    let failStatus = false;
    routeOverride = call => {
      const path = new URL(call.url).pathname;
      if (path === "/api/auth/nonce") return json({ ...echo, nonce }, failSignIn ? 503 : 200);
      if (path === "/api/auth/verify") return json({ ...echo, address: account.address });
      if (path === "/api/auth/session-key") return json({ ...echo, operator_id: account.address, expires_at: expiresAt }, 201);
      if (path.endsWith("/funding")) return json({ ...echo, jobId: "job-1", scopes: [dto()] }, failStatus ? 500 : 200);
      if (path === "/api/negotiate/session") return json(echo, 500);
      if (path === "/api/auth/logout") return json(echo);
      return undefined;
    };
    const h = await harness(config(), true);
    outputs.push((await h.call("pcc_buyer_sign_in")).text);
    failSignIn = false;
    outputs.push((await h.call("pcc_buyer_sign_in")).text);
    outputs.push((await h.call("pcc_buyer_order_status", { jobId: "job-1" })).text);
    failStatus = true;
    outputs.push((await h.call("pcc_buyer_order_status", { jobId: "job-1" })).text);
    outputs.push((await h.call("pcc_negotiate_create", negotiateArgs)).text);
    outputs.push((await h.call("pcc_buyer_sign_out")).text);
    const invalid = await harness(config({ PCC_BUYER_PRIVATE_KEY: privateKey.slice(0, -1) }));
    outputs.push((await invalid.call("pcc_buyer_sign_in")).text);
    const captured = [...outputs, ...logs].join("\n").toLowerCase();
    for (const secret of [privateKey, privateKey.slice(2), token, sessionKey]) expect(captured.includes(secret.toLowerCase())).toBe(false);
    expect(logs).toEqual([]);
  });
});
