import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@pcc/store";
import { CdpWalletClient } from "@pcc/payments";
import { closeStore, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { scopeChecker, __resetScopeCacheForTests } from "../middleware/scope-checker.js";
import { rateLimiter, __resetRateLimitState } from "../middleware/rate-limiter.js";
import { hashApiKey } from "../auth/api-key-auth.js";
import { walletsRoutes } from "../routes/wallets.js";
import { walletFaucetRoutes } from "../routes/wallet-faucet.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import { telemetryLookalikeHook } from "../services/telemetry-privacy.js";
import {
  GLOBAL_ETH_CLAIM_CAP, GLOBAL_USDC_CLAIM_CAP, finishFundingClaim, fundingClaims, leaseFundingClaim,
} from "../services/wallet-faucet/repository.js";
const path = "/api/wallets/link-requests";
const owner = { authorization: "Bearer pcc_test_faucet_owner" };
const other = { authorization: "Bearer pcc_test_faucet_other" };
const same = { authorization: "Bearer pcc_test_faucet_same" };
const credentials = { PCC_FAUCET_CDP_API_KEY_ID: "dummy-faucet-id", PCC_FAUCET_CDP_API_KEY_SECRET: "dummy-faucet-secret" };
const hash = () => `0x${randomBytes(32).toString("hex")}`;
type Token = "eth" | "usdc";
let app: FastifyInstance;
let now: number;
let calls: {
  address: string;
  token: Token;
}[];
let behavior: (address: string, token: Token) => Promise<unknown>;
const fake = { requestFaucet: async (address: `0x${string}`, token: Token) => {
    calls.push({ address, token });
    return behavior(address, token);
  } };
let extraApps: FastifyInstance[];
let temporaryDirectories: string[];
async function build(options: Record<string, unknown> = {}) {
  const instance = Fastify({ logger: false });
  instance.addHook("onRequest", telemetryLookalikeHook);
  await instance.register(cookie);
  await instance.register(rateLimiter);
  await instance.register(apiGate);
  await instance.register(tenantContext);
  await instance.register(scopeChecker);
  await instance.register(walletsRoutes);
  if (options.bodyDelayMs)
    instance.addHook("preParsing", async (req, _reply, stream) => {
      if (req.url.endsWith("/fund"))
        now += Number(options.bodyDelayMs);
      return stream;
    });
  await instance.register(walletFaucetRoutes, { client: fake, env: credentials, ...options });
  await instance.ready();
  extraApps.push(instance);
  return instance;
}
beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  for (const name of ["PCC_NETWORK", "CDP_NETWORK", "PCC_X402_CHAIN", "CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  calls = [];
  extraApps = [];
  temporaryDirectories = [];
  behavior = async () => ({ transactionHash: hash() });
  __resetRateLimitState();
  __resetScopeCacheForTests();
  const store = initStore({ seed: false });
  for (const [id, token, operatorId] of [["owner", "pcc_test_faucet_owner", "account-a"], ["other", "pcc_test_faucet_other", "account-b"], ["same", "pcc_test_faucet_same", "account-a"]]) {
    store.repos.apiKeys.insert({ id: id!, keyHash: hashApiKey(token!), keyPrefix: token!.slice(0, 12), operatorId: operatorId!, name: null, description: null, scopes: "[]", rateLimit: "1000/hour", usageCount: "0", createdAt: new Date(now).toISOString(), expiresAt: null, metadata: null, publicKey: null });
  }
  app = await build();
});
afterEach(async () => {
  for (const instance of extraApps ?? [])
    await instance.close();
  for (const directory of temporaryDirectories ?? [])
    rmSync(directory, { recursive: true, force: true });
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function create(role: "agent" | "device" = "agent", account = privateKeyToAccount(generatePrivateKey()), kernelId?: string) {
  const response = await app.inject({ method: "POST", url: path, payload: { keyType: "secp256k1", address: account.address.toLowerCase(), role, label: "cli", chainId: 84532, ...(kernelId ? { kernelId } : {}) } });
  expect(response.statusCode).toBe(201);
  return { account, request: response.json() as {
      requestId: string;
      userCode: string;
      message: string;
    } };
}
async function approve(result: Awaited<ReturnType<typeof create>>, headers = owner, decision = "approve") {
  const signature = await result.account.signMessage({ message: result.request.message });
  expect((await app.inject({ method: "POST", url: `${path}/${result.request.requestId}/proof`, payload: { signature } })).statusCode).toBe(200);
  const response = await app.inject({ method: "POST", url: `${path}/${result.request.requestId}/approve`, headers, payload: { userCode: result.request.userCode, decision, consentSha256: CONSENT_SHA256 } });
  expect(response.statusCode).toBe(200);
  return { ...result, linkId: response.json().linkId as string };
}
async function linked(role: "agent" | "device" = "agent", account?: ReturnType<typeof privateKeyToAccount>, headers = owner) {
  return approve(await create(role, account), headers);
}
type Linked = Awaited<ReturnType<typeof linked>>;
function fund(result: Linked, route: "cli" | "owner" = "cli", instance = app) {
  return instance.inject({ method: "POST", url: route === "cli" ? `${path}/${result.request.requestId}/fund` : `/api/wallets/${result.linkId}/fund`, ...(route === "owner" ? { headers: owner, payload: {} } : {}) });
}
function rows(linkId?: string) {
  return getStore().db.all<{
    token: Token;
    seq: number;
    status: string;
    attempts: number;
    tx_hash: string | null;
    address: string;
    lease_until: string | null;
  }>(linkId ? sql`SELECT * FROM faucet_claims WHERE link_id = ${linkId} ORDER BY CASE token WHEN 'eth' THEN 0 ELSE 1 END, seq` : sql`SELECT * FROM faucet_claims`);
}
async function refused(url: string, code: number, body: object, headers: Record<string, string> = {}, instance = app, payload?: object) {
  const before = rows();
  const n = calls.length;
  const response = await instance.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });
  expect(response.statusCode).toBe(code);
  expect(response.json()).toEqual(body);
  expect(rows()).toEqual(before);
  expect(calls).toHaveLength(n);
  return response;
}
async function revoke(result: Linked) {
  expect((await app.inject({ method: "POST", url: `/api/wallets/${result.linkId}/revoke`, headers: owner })).statusCode).toBe(200);
}
// Raw INSERTs are confined to historical cap fixtures. Live grants use W1/W2 routes.
function oldClaim(id: string, token: Token, seq: number, address: string, account = "history", age = 0, status = "failed", accountProof = "claimed", approvedByKeyId: string | null = "history-key") {
  const stamp = new Date(now - age).toISOString();
  getStore().db.run(sql`INSERT INTO faucet_claims (link_id, token, seq, account_id, account_proof, approved_by_key_id, address, chain_id, amount, status, attempts, created_at, updated_at) VALUES (${id}, ${token}, ${seq}, ${account}, ${accountProof}, ${approvedByKeyId}, ${address}, 84532, ${token === "eth" ? "0.0001" : "1"}, ${status}, 1, ${stamp}, ${stamp})`);
}
function holdFaucetCalls(count: number) {
  const releases: Array<() => void> = [];
  let started!: () => void;
  const allStarted = new Promise<void>(resolve => { started = resolve; });
  behavior = async () => new Promise(resolve => {
    releases.push(() => resolve({ transactionHash: hash() }));
    if (releases.length === count) started();
  });
  return {
    allStarted,
    // New requests may complete while these first calls remain in flight.
    allowNewCalls() { behavior = async () => ({ transactionHash: hash() }); },
    release() {
      behavior = async () => ({ transactionHash: hash() });
      for (const release of releases) release();
    },
  };
}
describe("W2 wallet faucet", () => {
  it("2 agent CLI: anonymous empty body funds six ordered claims and real hashes", async () => {
    const result = await linked();
    const response = await fund(result);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("funded");
    const claims = response.json().claims;
    expect(claims.map((c: {
      token: string;
      amount: string;
    }) => [c.token, c.amount])).toEqual([...Array.from({ length: 5 }, () => ["eth", "0.0001"]), ["usdc", "1"]]);
    expect(new Set(claims.map((c: {
      txHash: string;
    }) => c.txHash)).size).toBe(6);
    expect(calls).toEqual([...Array.from({ length: 5 }, () => ({ address: result.account.address, token: "eth" })), { address: result.account.address, token: "usdc" }]);
    expect(rows(result.linkId)).toHaveLength(6);
    expect(rows(result.linkId).every(r => r.status === "succeeded" && r.attempts === 1 && r.lease_until === null && r.address === result.account.address.toLowerCase())).toBe(true);
  });
  it("3 device owner with {} funds five ETH claims", async () => {
    const result = await linked("device");
    const response = await fund(result, "owner");
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("funded");
    expect(response.json().claims).toHaveLength(5);
    expect(calls.map(c => c.token)).toEqual(Array(5).fill("eth"));
  });
  it("4 idempotent on both routes including concurrent first calls", async () => {
    const result = await linked();
    const [one, two] = await Promise.all([fund(result), fund(result, "owner")]);
    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    expect(rows(result.linkId)).toHaveLength(6);
    expect(rows(result.linkId).map(r => r.attempts)).toEqual(Array(6).fill(1));
    const body = (await fund(result)).json();
    expect(body.status).toBe("funded");
    const n = calls.length;
    expect((await fund(result, "owner")).json()).toEqual(body);
    expect((await fund(result)).json()).toEqual(body);
    expect(calls).toHaveLength(n);
    expect(n).toBe(6);
    expect(rows(result.linkId)).toHaveLength(6);
  });
  it("4 a concurrent request sees the live lease and starts no parallel claims", async () => {
    const result = await linked();
    let release!: (value: unknown) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    behavior = async () => {
      if (calls.length === 1) {
        started();
        return new Promise(resolve => {
          release = resolve;
        });
      }
      return { transactionHash: hash() };
    };
    const first = fund(result);
    await firstStarted;
    const second = await fund(result, "owner");
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("pending");
    expect(calls).toHaveLength(1);
    release({ transactionHash: hash() });
    expect((await first).json().status).toBe("funded");
    expect(calls).toHaveLength(6);
    expect(rows(result.linkId).map(row => row.attempts)).toEqual(Array(6).fill(1));
  });
  it("P2 a held CDP call keeps its lease for 59,999 ms without a concurrent send", async () => {
    const result = await linked("device");
    const held = holdFaucetCalls(1);
    const first = fund(result).then(response => response);
    try {
      await held.allStarted;
      now += 59_999;
      held.allowNewCalls();
      const concurrent = await fund(result, "owner");
      expect(concurrent.statusCode).toBe(200);
      expect(concurrent.json().status).toBe("pending");
      expect(calls).toHaveLength(1);
    } finally {
      held.release();
      await first;
    }
    // The clock advance spent the first request's budget; finish via a new POST.
    expect((await first).statusCode).toBe(200);
    expect((await first).json().status).toBe("pending");
    const completed = await fund(result);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("funded");
    expect(calls).toHaveLength(5);
    expect(rows(result.linkId).map(row => row.attempts)).toEqual(Array(5).fill(1));
  });
  it("P3 the address cap permits two funded grants after revocation and re-linking", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    for (let grant = 0; grant < 2; grant++) {
      const result = await linked("device", account);
      const response = await fund(result);
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("funded");
      await revoke(result);
    }
    expect(calls).toHaveLength(10);
    const third = await linked("device", account);
    await refused(`${path}/${third.request.requestId}/fund`, 409, { error: "cap_reached", cap: "address" });
  });
  it.each([
    { age: 23 * 60 * 60 * 1000, retry: true },
    { age: 86_400_001, retry: false },
  ])("P1 failed device claims at age $age ms retry only inside their grant window", async ({ age, retry }) => {
    const banked = await linked("device");
    behavior = async () => { throw { errorType: "faucet_limit_exceeded" }; };
    const failed = await fund(banked);
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: "faucet_error", errorClass: "faucet_limit_exceeded" });
    expect(calls).toHaveLength(5);
    expect(rows(banked.linkId).map(row => [row.status, row.attempts])).toEqual(
      Array.from({ length: 5 }, () => ["failed", 1]),
    );

    now += age;
    behavior = async () => ({ transactionHash: hash() });
    if (!retry) {
      // Synthetic history fills the new window without consuming live-link caps.
      const address = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      for (let i = 0; i < GLOBAL_ETH_CLAIM_CAP - 5; i++)
        oldClaim(`ge-${Math.floor(i / 5)}`, "eth", i % 5 + 1, address);
      const fresh = await fund(await linked("device"));
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().status).toBe("funded");
      const blocked = await linked("device");
      await refused(`${path}/${blocked.request.requestId}/fund`, 409, { error: "cap_reached", cap: "global" });
    }
    const before = rows(banked.linkId);
    const n = calls.length;
    const response = await fund(banked, "owner");
    expect(calls).toHaveLength(n + (retry ? 5 : 0));
    if (retry) {
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("funded");
      expect(rows(banked.linkId).map(row => [row.status, row.attempts])).toEqual(
        Array.from({ length: 5 }, () => ["succeeded", 2]),
      );
    } else {
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual(failed.json());
      expect(rows(banked.linkId)).toEqual(before);
      const counted = getStore().db.get<{ n: number }>(sql`SELECT count(*) AS n FROM faucet_claims
        WHERE token = 'eth' AND created_at > ${new Date(now - 86_400_000).toISOString()}`)!.n;
      expect(counted).toBe(GLOBAL_ETH_CLAIM_CAP);
    }
  });
  it("5 retry waits 30 seconds and only retries failed ETH 2 and USDC", async () => {
    const result = await linked();
    behavior = async (_address, token) => {
      if (calls.length === 2 || token === "usdc")
        throw {};
      return { transactionHash: hash() };
    };
    const response = await fund(result);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("partial");
    const first = response.json();
    expect(Object.keys(first).sort()).toEqual(["claims", "status"]);
    expect(first.claims).toHaveLength(6);
    expect(first.claims.filter((c: {
      status: string;
    }) => c.status === "failed").every((c: {
      txHash?: string;
    }) => c.txHash === undefined)).toBe(true);
    expect((await fund(result)).json()).toEqual(first);
    expect(calls).toHaveLength(6);
    now += 29999;
    expect((await fund(result)).json()).toEqual(first);
    expect(calls).toHaveLength(6);
    now++;
    behavior = async () => ({ transactionHash: hash() });
    expect((await fund(result)).json().status).toBe("funded");
    expect(calls.slice(6).map(c => c.token)).toEqual(["eth", "usdc"]);
    expect(rows(result.linkId).map(r => r.attempts)).toEqual([1, 2, 1, 1, 1, 2]);
  });
  it.each(["mock", "zero", "63 hex", "no prefix", "undefined", "throw", "timeout"])("6 bad hashes/all fail: %s", async (kind) => {
    const result = await linked();
    behavior = async () => {
      if (kind === "throw")
        throw {};
      if (kind === "timeout")
        return new Promise(() => {
        });
      return { transactionHash: kind === "mock" ? `0x${"f".repeat(64)}` : kind === "zero" ? `0x${"0".repeat(64)}` : kind === "63 hex" ? `0x${randomBytes(32).toString("hex").slice(1)}` : kind === "no prefix" ? hash().slice(2) : undefined };
    };
    const response = await fund(result, "cli", await build({ callTimeoutMs: 5 }));
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "faucet_error", errorClass: kind === "throw" ? "unknown" : kind === "timeout" ? "timeout" : "invalid_tx_hash" });
    expect(rows(result.linkId).every(r => r.status === "failed" && r.tx_hash === null)).toBe(true);
  });
  it("6 reused hash fails second claim including alternate hex case", async () => {
    const result = await linked("device");
    const tx = hash();
    behavior = async () => ({ transactionHash: calls.length === 2 ? `0x${tx.slice(2).toUpperCase()}` : calls.length === 1 ? tx : hash() });
    const response = await fund(result);
    expect(response.json().status).toBe("partial");
    expect(response.json().claims[1]).toEqual({ token: "eth", amount: "0.0001", status: "failed" });
    expect(rows(result.linkId)[1]!.tx_hash).toBeNull();
  });
  it("6 late timeout never overwrites failed claim", async () => {
    const result = await linked("device");
    const late: ((v: unknown) => void)[] = [];
    behavior = () => new Promise(resolve => late.push(resolve));
    const response = await fund(result, "cli", await build({ callTimeoutMs: 2 }));
    expect(response.statusCode).toBe(502);
    late.forEach(resolve => resolve({ transactionHash: hash() }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(rows(result.linkId).every(r => r.status === "failed" && r.tx_hash === null)).toBe(true);
  });
  it("6 hashes already stored by another link fail every new claim", async () => {
    const previous = await linked("device");
    const tx = (await fund(previous)).json().claims[0].txHash;
    const result = await linked();
    behavior = async () => ({ transactionHash: tx });
    const response = await fund(result);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "faucet_error", errorClass: "invalid_tx_hash" });
    expect(rows(result.linkId).every(row => row.status === "failed" && row.tx_hash === null)).toBe(true);
  });
  it.each(["faucet_limit_exceeded", "rate_limit_exceeded", "unauthorized", "forbidden", "bad_gateway", "internal_server_error", "network_timeout", "network_connection_failed", "unknown_type"])("7 sanitizes SDK class %s", async (errorType) => {
    const result = await linked();
    behavior = async () => {
      throw { errorType, message: result.account.address };
    };
    const response = await fund(result);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "faucet_error", errorClass: errorType === "unknown_type" ? "unknown" : errorType });
    expect(response.body).not.toContain(result.account.address);
  });
  it.each([{}, { CDP_API_KEY_ID: "dummy-id", CDP_API_KEY_SECRET: "dummy-secret" }, { ...credentials, CDP_API_KEY_ID: "dummy-id" }, { ...credentials, CDP_API_KEY_NAME: "dummy-name" }, { ...credentials, CDP_API_KEY_SECRET: "dummy-secret" }, { ...credentials, CDP_WALLET_SECRET: "dummy-wallet" }])("8 unavailable creds %j", async (env) => {
    const result = await linked();
    await refused(`${path}/${result.request.requestId}/fund`, 503, { error: "faucet_unavailable" }, {}, await build({ env }));
  });
  it("8 real wrapper mock refused; funded ignores missing credentials", async () => {
    const result = await linked();
    const client = new CdpWalletClient();
    const spy = vi.spyOn(client, "requestFaucet");
    await refused(`${path}/${result.request.requestId}/fund`, 503, { error: "faucet_unavailable" }, {}, await build({ client }));
    expect(spy).not.toHaveBeenCalled();
    const funded = (await fund(result)).json();
    const n = calls.length;
    expect((await fund(result, "cli", await build({ env: {} }))).json()).toEqual(funded);
    expect(calls).toHaveLength(n);
  });
  it("8 SDK fallback appearing after initialization blocks later attempts", async () => {
    const result = await linked();
    behavior = async () => {
      vi.stubEnv("CDP_API_KEY_ID", "dummy-sdk-id");
      return { transactionHash: hash() };
    };
    const response = await fund(result);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "faucet_unavailable" });
    expect(calls).toHaveLength(1);
    expect(rows(result.linkId).filter(r => r.attempts === 0)).toHaveLength(5);
  });
  it("8 dummy credential file takes precedence, ignores extra lines and never alters process.env", async () => {
    const directory = mkdtempSync(join(tmpdir(), "w2-faucet-route-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "dummy.env");
    writeFileSync(file, "CDP_API_KEY_ID=\"dummy-file-id\"\nCDP_API_KEY_SECRET='dummy-file-secret'\nCDP_API_KEY_NAME=dummy-ignored\nCDP_WALLET_SECRET=dummy-ignored\nPCC_NETWORK=base\n");
    const result = await linked();
    const before = { ...process.env };
    const instance = await build({ env: { ...credentials, PCC_FAUCET_CDP_ENV_FILE: file } });
    const response = await fund(result, "cli", instance);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("funded");
    expect(process.env).toEqual(before);
    expect(Object.keys(process.env).filter(name => name.startsWith("CDP_"))).toEqual([]);
    expect(response.body).not.toContain(file);
    expect(response.body).not.toContain("dummy-file");
  });
  it.each(["missing", "incomplete", "unreadable"])("8 configured %s file refuses without fallback, rows or calls", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "w2-faucet-route-"));
    temporaryDirectories.push(directory);
    const file = kind === "unreadable" ? directory : join(directory, "dummy.env");
    if (kind === "incomplete")
      writeFileSync(file, "CDP_API_KEY_ID=dummy-only-id\n");
    const result = await linked();
    const response = await refused(`${path}/${result.request.requestId}/fund`, 503, { error: "faucet_unavailable" }, {}, await build({ env: { ...credentials, PCC_FAUCET_CDP_ENV_FILE: file } }));
    expect(response.body).not.toContain(file);
    expect(response.body).not.toContain("dummy-only-id");
  });
  it("9 revoke blocks both routes", async () => {
    const result = await linked();
    await revoke(result);
    for (const [url, headers] of [[`${path}/${result.request.requestId}/fund`, {}], [`/api/wallets/${result.linkId}/fund`, owner]] as const)
      await refused(url, 403, { error: "link_inactive" }, headers);
  });
  it("9 agent expires after 30 days; CLI capability expiry takes precedence", async () => {
    const result = await linked();
    now += 30 * 86400000;
    await refused(`/api/wallets/${result.linkId}/fund`, 403, { error: "link_inactive" }, owner);
    await refused(`${path}/${result.request.requestId}/fund`, 403, { error: "capability_expired" });
  });
  it("9 revoke in second CDP call stops remaining attempts", async () => {
    const result = await linked();
    behavior = async () => {
      if (calls.length === 2)
        await revoke(result);
      return { transactionHash: hash() };
    };
    const response = await fund(result);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "link_inactive" });
    expect(calls).toHaveLength(2);
    expect(rows(result.linkId).map(r => r.attempts)).toEqual([1, 1, 0, 0, 0, 0]);
  });
  it("10 capability valid at 3599999 ms; expired at 3600000; owner still works", async () => {
    const result = await linked();
    now += 3599999;
    expect((await fund(result)).json().status).toBe("funded");
    now++;
    await refused(`${path}/${result.request.requestId}/fund`, 403, { error: "capability_expired" });
    expect((await fund(result, "owner")).json().status).toBe("funded");
  });
  it("11 distinct request 404s: unknown, pending, denied", async () => {
    await refused(`${path}/unknown/fund`, 404, { error: "link_request_not_found" });
    const pending = await create();
    await refused(`${path}/${pending.request.requestId}/fund`, 404, { error: "link_request_not_found" });
    await approve(pending, owner, "deny");
    await refused(`${path}/${pending.request.requestId}/fund`, 404, { error: "link_request_not_found" });
  });
  it("11 distinct owner 404s: unknown, other account, other credential; no auth 401", async () => {
    const result = await linked();
    for (const [id, headers] of [["unknown", owner], [result.linkId, other], [result.linkId, same]] as const)
      await refused(`/api/wallets/${id}/fund`, 404, { error: "link_not_found" }, headers);
    const before = rows();
    const response = await app.inject({ method: "POST", url: `/api/wallets/${result.linkId}/fund` });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("api_key_required");
    expect(rows()).toEqual(before);
    expect(calls).toHaveLength(0);
  });
  it("11 ed25519 device is not fundable on either route", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
    const created = await app.inject({ method: "POST", url: path, payload: { keyType: "ed25519", publicKey, role: "device", label: "device", chainId: 84532 } });
    expect(created.statusCode).toBe(201);
    const request = created.json();
    expect((await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature: sign(null, Buffer.from(request.message), pair.privateKey).toString("hex") } })).statusCode).toBe(200);
    const approved = await app.inject({ method: "POST", url: `${path}/${request.requestId}/approve`, headers: owner, payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
    expect(approved.statusCode).toBe(200);
    await refused(`${path}/${request.requestId}/fund`, 409, { error: "not_fundable" });
    await refused(`/api/wallets/${approved.json().linkId}/fund`, 409, { error: "not_fundable" }, owner);
  });
  it.each(["lower", "upper"])("12 address ETH cap all statuses and either case %s", async (casing) => {
    const result = await linked();
    const address = casing === "upper" ? result.account.address.toUpperCase() : result.account.address.toLowerCase();
    for (let i = 1; i <= 6; i++)
      oldClaim("old", "eth", i, address, "history", 0, i % 2 ? "pending" : "failed");
    await refused(`${path}/${result.request.requestId}/fund`, 409, { error: "cap_reached", cap: "address" });
  });
  it("12 address USDC cap", async () => {
    const result = await linked();
    for (let i = 1; i <= 3; i++)
      oldClaim("old", "usdc", i, result.account.address.toLowerCase());
    await refused(`${path}/${result.request.requestId}/fund`, 409, { error: "cap_reached", cap: "address" });
  });
  it("12 account cap refuses fourth link", async () => {
    for (let i = 0; i < 3; i++)
      expect((await fund(await linked())).json().status).toBe("funded");
    const result = await linked();
    await refused(`${path}/${result.request.requestId}/fund`, 409, { error: "cap_reached", cap: "account" });
  });
  it("12 global USDC cap: device passes", async () => {
    for (let i = 0; i < 8; i++)
      oldClaim(`global-${i}`, "usdc", 1, privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
    expect((await fund(await linked("device"))).json().status).toBe("funded");
  });
  it("12 rows older than 24h do not count toward any cap", async () => {
    const result = await linked();
    const namespace = getStore().db.get<{ account_proof: string; approved_by_key_id: string | null }>(sql`
      SELECT account_proof, approved_by_key_id FROM wallet_links WHERE id = ${result.linkId}`)!;
    for (let i = 0; i < 12; i++) {
      oldClaim(`old-${i}`, "eth", 1, result.account.address.toLowerCase(), "account-a", 86400001, "failed", namespace.account_proof, namespace.approved_by_key_id);
      oldClaim(`old-${i}`, "usdc", 1, result.account.address.toLowerCase(), "account-a", 86400001, "failed", namespace.account_proof, namespace.approved_by_key_id);
    }
    const response = await fund(result);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe("funded");
    expect(response.json().claims.map((claim: { token: string }) => claim.token)).toEqual([...Array(5).fill("eth"), "usdc"]);
  });
  it.each([{ PCC_NETWORK: "base" }, { CDP_NETWORK: "base" }, { PCC_X402_CHAIN: "base-mainnet" }, { PCC_NETWORK: "unknown-net" }])("13 mainnet hides both routes; W1 still creates %j", async (settings) => {
    const result = await linked();
    const instance = await build({ env: { ...credentials, ...settings } });
    await refused(`${path}/${result.request.requestId}/fund`, 404, { error: "not_found" }, {}, instance);
    await refused(`/api/wallets/${result.linkId}/fund`, 404, { error: "not_found" }, owner, instance);
    expect((await instance.inject({ method: "POST", url: path, payload: { keyType: "secp256k1", address: privateKeyToAccount(generatePrivateKey()).address, role: "agent", label: "cli", chainId: 84532 } })).statusCode).toBe(201);
  });
  it("14 strict body and I1 before validation on both routes", async () => {
    const result = await linked();
    for (const [url, headers] of [[`${path}/${result.request.requestId}/fund`, {}], [`/api/wallets/${result.linkId}/fund`, owner]] as const) {
      await refused(url, 400, { error: "invalid_request" }, headers, app, { usdc: 2 });
      await refused(url, 400, { error: "key_material_refused" }, headers, app, { privateKey: "x" });
    }
  });
  it("15 zero budget creates pending grant; default app completes it", async () => {
    const result = await linked();
    const response = await fund(result, "cli", await build({ attemptBudgetMs: 0 }));
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("pending");
    expect(Object.keys(response.json()).sort()).toEqual(["claims", "status"]);
    expect(response.json().claims).toHaveLength(6);
    expect(calls).toHaveLength(0);
    expect(rows(result.linkId).map(r => r.attempts)).toEqual(Array(6).fill(0));
    expect((await fund(result)).json().status).toBe("funded");
  });
  it("15 expired lease attempts; live lease pending without calls", async () => {
    const result = await linked();
    await fund(result, "cli", await build({ attemptBudgetMs: 0 }));
    // Lease fixtures UPDATE rows created by the route, never raw INSERT live grants.
    getStore().db.run(sql`UPDATE faucet_claims SET lease_until = ${new Date(now + 60000).toISOString()}, attempts = 1, last_attempt_at = ${new Date(now).toISOString()} WHERE link_id = ${result.linkId} AND token = 'eth' AND seq = 1`);
    expect((await fund(result)).json().status).toBe("pending");
    expect(calls).toHaveLength(0);
    now += 60000;
    expect((await fund(result)).json().status).toBe("funded");
    expect(rows(result.linkId)[0]!.attempts).toBe(2);
  });
  it("15 five failures terminal; no credentials needed", async () => {
    const result = await linked();
    behavior = async () => {
      throw {};
    };
    for (let i = 0; i < 5; i++) {
      expect((await fund(result)).statusCode).toBe(502);
      now += 30000;
    }
    expect(calls).toHaveLength(30);
    expect(rows(result.linkId).map(r => r.attempts)).toEqual(Array(6).fill(5));
    expect((await fund(result, "cli", await build({ env: {} }))).statusCode).toBe(502);
    expect(calls).toHaveLength(30);
  });
  it("15 pending outranks failures; no attempt starts after request budget", async () => {
    const result = await linked();
    behavior = async () => {
      now += 5000;
      throw {};
    };
    const response = await fund(result);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("pending");
    expect(calls).toHaveLength(1);
    expect(rows(result.linkId).map(r => r.status)).toEqual(["failed", "pending", "pending", "pending", "pending", "pending"]);
  });
  it("15 body processing counts toward the request attempt budget", async () => {
    const result = await linked();
    const response = await fund(result, "cli", await build({ bodyDelayMs: 5000 }));
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("pending");
    expect(calls).toHaveLength(0);
    expect(rows(result.linkId).map(row => row.attempts)).toEqual(Array(6).fill(0));
  });
  it("check order: unavailable before caps; inactive before unavailable; live lease needs no credentials", async () => {
    const result = await linked();
    for (let i = 0; i < 6; i++)
      oldClaim("old", "eth", i, result.account.address.toLowerCase());
    await refused(`${path}/${result.request.requestId}/fund`, 503, { error: "faucet_unavailable" }, {}, await build({ env: {} }));
    await revoke(result);
    await refused(`${path}/${result.request.requestId}/fund`, 403, { error: "link_inactive" }, {}, await build({ env: {} }));
    const device = await linked("device");
    await fund(device, "cli", await build({ attemptBudgetMs: 0 }));
    getStore().db.run(sql`UPDATE faucet_claims SET lease_until = ${new Date(now + 60000).toISOString()} WHERE link_id = ${device.linkId}`);
    const n = calls.length;
    expect((await fund(device, "cli", await build({ env: {} }))).json().status).toBe("pending");
    expect(calls).toHaveLength(n);
  });
  it("T10 a live retry lease is pending in the claim and rollup", async () => {
    const result = await linked("device");
    behavior = async () => { throw {}; };
    expect((await fund(result)).statusCode).toBe(502);
    now += 30000;
    let release!: (value: unknown) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    behavior = async () => {
      if (calls.length === 6) {
        started();
        return new Promise(resolve => { release = resolve; });
      }
      return { transactionHash: hash() };
    };
    const first = fund(result);
    await firstStarted;
    const concurrent = await fund(result, "owner");
    const callsWhileBlocked = calls.length;
    release({ transactionHash: hash() });
    const completed = await first;
    expect(concurrent.statusCode).toBe(200);
    expect(concurrent.json()).toEqual({
      status: "pending",
      claims: [
        { token: "eth", amount: "0.0001", status: "pending" },
        ...Array.from({ length: 4 }, () => ({ token: "eth", amount: "0.0001", status: "failed" })),
      ],
    });
    expect(callsWhileBlocked).toBe(6);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("funded");
  });
  it("T11(a) the SQL own-lease guard refuses a second lease at the same instant", async () => {
    const result = await linked("device");
    expect((await fund(result, "cli", await build({ attemptBudgetMs: 0 }))).json().status).toBe("pending");
    const claim = fundingClaims(result.linkId)[0]!;
    expect(leaseFundingClaim(claim, now)).toBeDefined();
    const before = rows();
    expect(leaseFundingClaim(claim, now)).toBeUndefined();
    expect(rows()).toEqual(before);
    expect(calls).toHaveLength(0);
  });
  it("T11(b) the SQL per-link mutex refuses another claim while one is leased", async () => {
    const result = await linked("device");
    expect((await fund(result, "cli", await build({ attemptBudgetMs: 0 }))).json().status).toBe("pending");
    const claims = fundingClaims(result.linkId);
    expect(leaseFundingClaim(claims[0]!, now)).toBeDefined();
    const before = rows();
    expect(leaseFundingClaim(claims[1]!, now)).toBeUndefined();
    expect(rows()).toEqual(before);
    expect(calls).toHaveLength(0);
  });
  it("T11(c) the SQL link-active guard refuses a revoked link", async () => {
    const zeroBudget = await build({ attemptBudgetMs: 0 });
    const first = await linked("device");
    expect((await fund(first, "cli", zeroBudget)).json().status).toBe("pending");
    const second = await linked("device");
    expect((await fund(second, "cli", zeroBudget)).json().status).toBe("pending");
    await revoke(second);
    const before = rows();
    expect(leaseFundingClaim(fundingClaims(second.linkId)[0]!, now)).toBeUndefined();
    expect(rows()).toEqual(before);
    expect(calls).toHaveLength(0);
  });
  it("T11(d) a stale completion cannot finish a replacement lease", async () => {
    const result = await linked("device");
    expect((await fund(result, "cli", await build({ attemptBudgetMs: 0 }))).json().status).toBe("pending");
    const claim = fundingClaims(result.linkId)[0]!;
    const firstLease = leaseFundingClaim(claim, now)!;
    expect(firstLease).toBeDefined();
    now += 60000;
    const replacement = leaseFundingClaim(claim, now)!;
    expect(replacement).toBeDefined();
    const before = rows();
    finishFundingClaim(firstLease, hash(), undefined, now);
    expect(rows()).toEqual(before);
    expect(calls).toHaveLength(0);
    const txHash = hash();
    finishFundingClaim(replacement, txHash, undefined, now);
    expect(fundingClaims(result.linkId)[0]).toMatchObject({ status: "succeeded", tx_hash: txHash, lease_until: null, attempts: 2 });
  });
  it("T12 kernelId never grants owner-route access", async () => {
    const result = await approve(await create("device", undefined, "account-b"));
    await refused(`/api/wallets/${result.linkId}/fund`, 404, { error: "link_not_found" }, other, app, {});
    const response = await fund(result, "owner");
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("funded");
    expect(response.json().claims).toHaveLength(5);
  });
  it("T13 global USDC exhaustion fixes an agent grant at five ETH claims", async () => {
    for (let i = 0; i < 8; i++)
      oldClaim(`global-${i}`, "usdc", 1, privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
    const result = await linked();
    const response = await fund(result);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["claims", "skipped", "status"]);
    expect(body.status).toBe("funded");
    expect(body.claims).toHaveLength(5);
    expect(body.claims.every((claim: { token: string; amount: string; status: string; txHash: string }) =>
      claim.token === "eth" && claim.amount === "0.0001" && claim.status === "succeeded" && /^0x[0-9a-f]{64}$/.test(claim.txHash))).toBe(true);
    expect(body.skipped).toEqual([{ token: "usdc", amount: "1", reason: "cap_reached", cap: "global" }]);
    expect(calls.map(call => call.token)).toEqual(Array(5).fill("eth"));
    expect(rows(result.linkId)).toHaveLength(5);
    const n = calls.length;
    expect((await fund(result, "owner")).json()).toEqual(body);
    expect((await fund(result)).json()).toEqual(body);
    expect(calls).toHaveLength(n);
    const device = await fund(await linked("device"));
    expect(device.statusCode).toBe(200);
    expect(Object.keys(device.json()).sort()).toEqual(["claims", "status"]);
    // The grant stays ETH-only even after the historical USDC shortage rolls off.
    const completedCalls = calls.length;
    now += 86400001;
    expect((await fund(result, "owner")).json()).toEqual(body);
    expect(calls).toHaveLength(completedCalls);
  });
  it("T14 seven global USDC rows permit the complete six-claim agent grant", async () => {
    for (let i = 0; i < 7; i++)
      oldClaim(`global-${i}`, "usdc", 1, privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
    const response = await fund(await linked());
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(["claims", "status"]);
    expect(response.json().status).toBe("funded");
    expect(response.json().claims.map((claim: { token: string }) => claim.token)).toEqual([...Array(5).fill("eth"), "usdc"]);
  });
  it.each(["partial", "pending", "failed"] as const)("T15 ETH-only grants preserve the %s response contract", async (outcome) => {
    for (let i = 0; i < 8; i++)
      oldClaim(`global-${i}`, "usdc", 1, privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
    const result = await linked();
    if (outcome === "partial") behavior = async () => {
      if (calls.length === 2) throw {};
      return { transactionHash: hash() };
    };
    if (outcome === "failed") behavior = async () => { throw {}; };
    const response = await fund(result, "cli", outcome === "pending" ? await build({ attemptBudgetMs: 0 }) : app);
    expect(rows(result.linkId)).toHaveLength(5);
    if (outcome === "failed") {
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "faucet_error", errorClass: "unknown" });
    } else {
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual(["claims", "skipped", "status"]);
      expect(response.json().status).toBe(outcome);
      expect(response.json().skipped).toEqual([{ token: "usdc", amount: "1", reason: "cap_reached", cap: "global" }]);
      expect(response.json().claims.map((claim: { status: string }) => claim.status)).toEqual(
        outcome === "pending" ? Array(5).fill("pending") : ["succeeded", "failed", "succeeded", "succeeded", "succeeded"],
      );
    }
    expect(calls.map(call => call.token)).toEqual(Array(outcome === "pending" ? 0 : 5).fill("eth"));
  });
  it("T16 the global ETH cap is inclusive and refuses either role before USDC", async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    for (let i = 0; i < GLOBAL_ETH_CLAIM_CAP - 5; i++)
      oldClaim(`ge-${Math.floor(i / 5)}`, "eth", i % 5 + 1, address);
    oldClaim("global-usdc", "usdc", 1, address);
    const first = await fund(await linked("device"));
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("funded");
    for (const role of ["device", "agent"] as const) {
      const result = await linked(role);
      await refused(`${path}/${result.request.requestId}/fund`, 409, { error: "cap_reached", cap: "global" });
    }
  });
  it("T17 global claim cap constants retain their agreed literal values", () => {
    expect(GLOBAL_ETH_CLAIM_CAP).toBe(800);
    expect(GLOBAL_USDC_CLAIM_CAP).toBe(8);
  });
  it("T18 claimed account caps are independent for each approving credential", async () => {
    for (let i = 0; i < 3; i++)
      expect((await fund(await linked("device"))).json().status).toBe("funded");
    const sameAccount = await linked("device", undefined, same);
    const response = await app.inject({ method: "POST", url: `/api/wallets/${sameAccount.linkId}/fund`, headers: same, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("funded");
    const fourth = await linked("device");
    await refused(`${path}/${fourth.request.requestId}/fund`, 409, { error: "cap_reached", cap: "account" });
  });
  it("C1 pending device grants count toward the global ETH cap", async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    for (let i = 0; i < GLOBAL_ETH_CLAIM_CAP - 10; i++)
      oldClaim(`ge-${Math.floor(i / 5)}`, "eth", i % 5 + 1, address);
    const links = [await linked("device"), await linked("device"), await linked("device")];
    const held = holdFaucetCalls(2);
    const pending = links.slice(0, 2).map(link => fund(link).then(response => response));
    try {
      await held.allStarted;
      expect(rows().filter(row => row.status === "pending")).toHaveLength(10);
      expect(calls).toHaveLength(2);
      held.allowNewCalls();
      await refused(`${path}/${links[2]!.request.requestId}/fund`, 409, { error: "cap_reached", cap: "global" });
    } finally {
      held.release();
      await Promise.all(pending);
    }
    for (const response of await Promise.all(pending)) {
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("funded");
    }
    expect(calls).toHaveLength(10);
  });
  it("C2 pending grants of one approving key count toward its account cap", async () => {
    const links = [await linked("device"), await linked("device"), await linked("device"), await linked("device")];
    const held = holdFaucetCalls(3);
    const pending = links.slice(0, 3).map(link => fund(link).then(response => response));
    try {
      await held.allStarted;
      expect(rows().filter(row => row.status === "pending")).toHaveLength(15);
      expect(calls).toHaveLength(3);
      held.allowNewCalls();
      await refused(`${path}/${links[3]!.request.requestId}/fund`, 409, { error: "cap_reached", cap: "account" });
    } finally {
      held.release();
      await Promise.all(pending);
    }
    for (const response of await Promise.all(pending)) {
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("funded");
    }
    expect(calls).toHaveLength(15);
  });
  it("C3 a pending agent USDC claim triggers the global ETH-only fallback", async () => {
    for (let i = 0; i < GLOBAL_USDC_CLAIM_CAP - 1; i++)
      oldClaim(`global-${i}`, "usdc", 1, privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
    const first = await linked();
    const second = await linked();
    const held = holdFaucetCalls(1);
    const pending = fund(first).then(response => response);
    try {
      await held.allStarted;
      expect(rows(first.linkId).map(row => [row.token, row.status])).toEqual([
        ...Array.from({ length: 5 }, () => ["eth", "pending"]), ["usdc", "pending"],
      ]);
      held.allowNewCalls();
      const response = await fund(second);
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual(["claims", "skipped", "status"]);
      expect(response.json().status).toBe("funded");
      expect(response.json().claims.map((claim: { token: string; status: string }) => [claim.token, claim.status]))
        .toEqual(Array.from({ length: 5 }, () => ["eth", "succeeded"]));
      expect(response.json().skipped).toEqual([{ token: "usdc", amount: "1", reason: "cap_reached", cap: "global" }]);
      expect(rows(second.linkId).map(row => row.token)).toEqual(Array(5).fill("eth"));
      expect(calls.slice(1).map(call => call.token)).toEqual(Array(5).fill("eth"));
    } finally {
      held.release();
      await pending;
    }
    const completed = await pending;
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("funded");
    expect(Object.keys(completed.json()).sort()).toEqual(["claims", "status"]);
    expect(calls).toHaveLength(11);
  });
  it("C4 succeeded plus budget-pending claims roll up to pending", async () => {
    const result = await linked("device");
    behavior = async () => {
      now += 5000;
      return { transactionHash: hash() };
    };
    const response = await fund(result);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(["claims", "status"]);
    expect(response.json().status).toBe("pending");
    expect(response.json().claims.map((claim: { status: string }) => claim.status))
      .toEqual(["succeeded", "pending", "pending", "pending", "pending"]);
    expect(calls).toHaveLength(1);
    expect(rows(result.linkId).map(row => row.attempts)).toEqual([1, 0, 0, 0, 0]);
  });
  it("C5 a stale lease on terminal failed claims reports the exact 502 body", async () => {
    const result = await linked("device");
    expect((await fund(result, "cli", await build({ attemptBudgetMs: 0 }))).json().status).toBe("pending");
    // A crashed terminal attempt can leave a stale lease; no route produces this fixture.
    getStore().db.run(sql`UPDATE faucet_claims SET status = 'failed', error_class = 'unknown', attempts = 5,
      lease_until = ${new Date(now - 1000).toISOString()}, last_attempt_at = ${new Date(now - 61000).toISOString()}
      WHERE link_id = ${result.linkId}`);
    await refused(`${path}/${result.request.requestId}/fund`, 502, { error: "faucet_error", errorClass: "unknown" });
    expect(calls).toHaveLength(0);
  });
});
