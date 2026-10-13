import Fastify, { type FastifyInstance, type FastifyRequest, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@pcc/store";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";
import { corsDelegator, irCorsReadProjection } from "../middleware/security-hardening.js";
import { jobRoutes } from "../routes/jobs.js";
import { operatorRoutes } from "../routes/operator.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { walletsRoutes } from "../routes/wallets.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import { GATEWAY_LOGGER_OPTIONS } from "../services/telemetry-privacy.js";
import { writeAuditHook } from "../services/write-audit-hook.js";
import { auditService } from "../services/audit-service.js";
import { capturePrincipal, intentActor } from "../services/unmet-capture.js";
import * as posthog from "../services/posthog-service.js";
import { decorateWithReportHint } from "../report-hint.js";

const PATH = "/api/wallets/link-requests";
const KERNEL = "kernel-w1b";
const JOB = "job-w1b";
const ADMIN = "w1b-admin-secret";
const OPERATOR = "w1b-operator@example.test";
const OTHER_OPERATOR = "w1b-other@example.test";
type ProofRequest = FastifyRequest & { provenWallet?: unknown };
type Headers = NonNullable<InjectOptions["headers"]>;
let app: FastifyInstance;
let clockNow: number;
let logs: string[];
let wallet: ReturnType<typeof privateKeyToAccount>;
let key: ReturnType<typeof provisionApiKey>;
let sameOperatorKey: ReturnType<typeof provisionApiKey>;
let otherKey: ReturnType<typeof provisionApiKey>;

const bearer = (credential = key): Record<string, string> => ({ authorization: `Bearer ${credential.rawKey}` });
const header = (address: string = wallet.address, credential = key): Headers => ({ ...bearer(credential), "x-pcc-wallet": address });

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  vi.stubEnv("PCC_UNMET_CAPTURE_ENABLED", "true");
  vi.spyOn(posthog, "trackServerEvent").mockImplementation(() => undefined);
  clockNow = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clockNow);
  logs = [];
  closeStore();
  const { repos } = initStore({ seed: true });
  wallet = privateKeyToAccount(generatePrivateKey());
  key = provisionApiKey({ operatorId: OPERATOR, scopes: ["*"] });
  sameOperatorKey = provisionApiKey({ operatorId: OPERATOR, scopes: ["*"] });
  otherKey = provisionApiKey({ operatorId: OTHER_OPERATOR, scopes: ["*"] });
  repos.kernels.insert({ ...repos.kernels.findAll()[0]!, id: KERNEL, operatorAddress: wallet.address });
  repos.jobs.insert({ ...repos.jobs.findAll()[0]!, id: JOB, kernelId: KERNEL, status: "queued", evidenceBundleId: null });
  app = Fastify({ logger: { ...GATEWAY_LOGGER_OPTIONS, level: "info", stream: { write: (line: string) => logs.push(line) } } });
  await app.register(cookie);
  await app.register(cors, { delegator: corsDelegator });
  await app.register(apiGate);
  app.addHook("onRequest", async req => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as ProofRequest).provenWallet = proven;
    if (req.headers["x-test-wallet-array"]) req.headers["x-pcc-wallet"] = [wallet.address];
    if (req.headers["x-test-wallet-raw-duplicate"]) {
      req.raw.rawHeaders.push("X-PCC-Wallet", wallet.address);
    }
  });
  app.addHook("onResponse", writeAuditHook);
  app.addHook("onSend", async (req, reply, payload) => typeof payload === "string"
    ? decorateWithReportHint(payload, { statusCode: reply.statusCode,
      contentType: String(reply.getHeader("content-type") ?? ""), url: req.url, method: req.method })
    : payload);
  app.addHook("onSend", irCorsReadProjection);
  // Match production's sibling order, including a DECIDE route preceding wallets.
  await app.register(operatorRoutes);
  await app.register(jobRoutes);
  await app.register(walletsRoutes);
  await app.register(operatorRelayRoutes);
  await app.register(async sibling => {
    sibling.get("/api/w1b/proof", async req => ({ provenWallet: (req as ProofRequest).provenWallet ?? null }));
    sibling.post("/api/w1b/intent", async req => {
      const actor = intentActor(capturePrincipal(req), { actorId: "anonymous", actorType: "agent" });
      posthog.trackServerEvent("w1b_intent", { ...actor });
      return { captured: true };
    });
  });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function link(options: {
  account?: ReturnType<typeof privateKeyToAccount>;
  creator?: ReturnType<typeof provisionApiKey> | null;
  approver?: ReturnType<typeof provisionApiKey>;
  role?: "agent" | "device";
} = {}) {
  const account = options.account ?? wallet;
  const creator = options.creator === undefined ? key : options.creator;
  const created = await app.inject({ method: "POST", url: PATH, headers: creator ? bearer(creator) : {},
    payload: { keyType: "secp256k1", address: account.address.toLowerCase(), chainId: 84532,
      role: options.role ?? "agent", label: "w1b-test" } });
  expect(created.statusCode).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const signature = await account.signMessage({ message: request.message });
  const proof = await app.inject({ method: "POST", url: `${PATH}/${request.requestId}/proof`, payload: { signature } });
  expect(proof.statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `${PATH}/${request.requestId}/approve`,
    headers: bearer(options.approver ?? key),
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
  expect(approved.statusCode).toBe(200);
  return { ...request, linkId: approved.json<{ linkId: string }>().linkId };
}

function evidence(headers: Headers = {}) {
  return app.inject({ method: "POST", url: "/api/operator/evidence", headers,
    payload: { jobId: JOB, evidence: { events: [{ type: "execution_completed", timestamp: new Date(clockNow).toISOString(),
      source: { deviceId: "w1b-printer", deviceType: "fdm", kernelId: KERNEL }, payload: { jobId: JOB, ok: true } }] } } });
}

async function refused(headers: Headers) {
  const response = await evidence(headers);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
}

describe("API key self-linked proven wallet", () => {
  it("1 grants DECIDE for real evidence and an operator route registered before wallets", async () => {
    await link();
    const response = await evidence(header());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stored: true, jobId: JOB, eventsStored: 1 });
    const policy = await app.inject({ method: "PATCH", url: `/api/operator/policy/${KERNEL}`, headers: header(), payload: { emergencyStop: false } });
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toMatchObject({ updated: true, policy: { emergencyStop: false } });
  });

  it("normalizes the selected wallet to lowercase on a later sibling route", async () => {
    await link();
    const response = await app.inject({ url: "/api/w1b/proof", headers: header(`0x${wallet.address.slice(2).toUpperCase()}`) });
    expect(response.json()).toEqual({ provenWallet: wallet.address.toLowerCase() });
  });

  it("2 requires the header even with a valid self-link", async () => { await link(); await refused(bearer()); });
  it("3 requires a link for the wallet named by the header", async () => {
    await link();
    await refused(header(privateKeyToAccount(generatePrivateKey()).address));
  });
  it("3 binds the header to the self-link before granting a second kernel", async () => {
    await link();
    const unlinkedWallet = privateKeyToAccount(generatePrivateKey()).address;
    const otherKernel = "kernel-w1b-unlinked-wallet";
    getRepos().kernels.insert({ ...getRepos().kernels.findById(KERNEL)!, id: otherKernel,
      operatorAddress: unlinkedWallet });
    const headers = header(unlinkedWallet);
    const proof = await app.inject({ url: "/api/w1b/proof", headers });
    expect(proof.statusCode).toBe(200);
    expect(proof.json()).toEqual({ provenWallet: null });
    const policy = await app.inject({ method: "PATCH", url: `/api/operator/policy/${otherKernel}`, headers,
      payload: { emergencyStop: false } });
    expect(policy.statusCode).toBe(403);
    expect(policy.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
  });
  it("4 reads revocation on the very next request", async () => {
    const linked = await link();
    expect((await evidence(header())).statusCode).toBe(200);
    const revoked = await app.inject({ method: "POST", url: `/api/wallets/${linked.linkId}/revoke`, headers: bearer(), payload: {} });
    expect(revoked.statusCode).toBe(200);
    await refused(header());
  });
  it.each([0, 1])("5 refuses an agent link at expiry plus %i ms", async extra => {
    await link();
    clockNow += 30 * 86400000 + extra;
    await refused(header());
  });
  it("accepts an unexpired device link with no expiry", async () => {
    await link({ role: "device" });
    clockNow += 60 * 86400000;
    expect((await evidence(header())).statusCode).toBe(200);
  });
  it("6 refuses another operator's self-linked wallet", async () => {
    await link({ creator: otherKey, approver: otherKey });
    await refused(header());
  });
  it("7 refuses a second key with the SAME claimed operator id", async () => {
    await link();
    await refused(header(wallet.address, sameOperatorKey));
  });
  it.each(["anonymous", "other-key"])("8 refuses a link created by %s and approved by K", async creator => {
    await link({ creator: creator === "anonymous" ? null : sameOperatorKey });
    await refused(header());
  });
  it("8 refuses both keys when K creates and K2 approves", async () => {
    await link({ creator: key, approver: sameOperatorKey });
    await refused(header());
    await refused(header(wallet.address, sameOperatorKey));
  });
  it.each([
    ["39 hex characters", `0x${"a".repeat(39)}`],
    ["missing prefix", "a".repeat(40)],
    ["non-hex", `0x${"g".repeat(40)}`],
    ["empty", ""],
    ["comma-joined", `0x${"a".repeat(40)}, 0x${"a".repeat(40)}`],
  ])("9 ignores a malformed header: %s", async (_name, value) => {
    await link();
    const lookup = vi.spyOn(getStore().db, "get");
    await refused(header(value));
    expect(lookup).not.toHaveBeenCalled();
  });
  it("9 ignores repeated header values", async () => {
    await link();
    const lookup = vi.spyOn(getStore().db, "get");
    await refused({ ...bearer(), "x-pcc-wallet": [wallet.address, wallet.address] });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("9 ignores an array even with only one element", async () => {
    await link();
    await refused({ ...header(), "x-test-wallet-array": "true" });
  });
  it("9 ignores raw duplicate headers even if normalized to one value", async () => {
    await link();
    await refused({ ...header(), "x-test-wallet-raw-duplicate": "true" });
  });
  it("10 never overwrites a non-empty provenWallet", async () => {
    await link();
    const established = privateKeyToAccount(generatePrivateKey()).address;
    const headers = { ...header(), "x-test-proven-wallet": established };
    await refused(headers);
    const response = await app.inject({ url: "/api/w1b/proof", headers });
    expect(response.json()).toEqual({ provenWallet: established });
  });
  it.each(["no header", "malformed", "valid"])("preserves an existing proof with %s", async kind => {
    const established = wallet.address;
    const headers = { ...bearer(), "x-test-proven-wallet": established,
      ...(kind === "no header" ? {} : { "x-pcc-wallet": kind === "malformed" ? "invalid" : established }) };
    const lookup = vi.spyOn(getStore().db, "get");
    const response = await app.inject({ url: "/api/w1b/proof", headers });
    expect(response.json()).toEqual({ provenWallet: established });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("11 leaves unauthenticated responses unchanged", async () => {
    const without = await evidence();
    const lookup = vi.spyOn(getStore().db, "get");
    const withHeader = await evidence({ "x-pcc-wallet": wallet.address });
    expect(withHeader.statusCode).toBe(without.statusCode);
    expect(withHeader.json()).toEqual(without.json());
    expect(lookup).not.toHaveBeenCalled();
  });
  it("leaves a cookie session without an API key untouched", async () => {
    await link();
    getRepos().sessions.insert({ id: "w1b-cookie", token: "w1b-cookie", walletAddress: wallet.address,
      createdAt: new Date(clockNow).toISOString(), lastActiveAt: new Date(clockNow).toISOString(),
      expiresAt: new Date(clockNow + 86400000).toISOString() });
    const lookup = vi.spyOn(getStore().db, "get");
    const response = await app.inject({ url: "/api/w1b/proof", headers: { cookie: "pcc_session=w1b-cookie", "x-pcc-wallet": wallet.address } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provenWallet: null });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("12 leaves an admin request unchanged", async () => {
    const without = await evidence({ ...bearer(), "x-admin-key": ADMIN });
    const withHeader = await evidence({ ...header(), "x-admin-key": ADMIN });
    expect(without.statusCode).toBe(200);
    expect(withHeader.statusCode).toBe(without.statusCode);
    expect(withHeader.json()).toMatchObject({ stored: true, jobId: JOB });
  });
  it("13 returns 503 wallet_link_unavailable on a lookup failure", async () => {
    await link();
    vi.spyOn(getStore().db, "get").mockImplementation(() => { throw new Error(`lookup-error-sensitive-${wallet.address}`); });
    const response = await evidence(header());
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "wallet_link_unavailable" });
    expect(logs.join("")).not.toContain(wallet.address);
  });
  it("13 performs no link lookup at all without the header", async () => {
    await link();
    const lookup = vi.spyOn(getStore().db, "get").mockImplementation(() => { throw new Error("lookup-must-not-run"); });
    await refused(bearer());
    expect(lookup).not.toHaveBeenCalled();
  });
  it("13 preserves the lookup failure body through cross-origin GET projection", async () => {
    await link();
    vi.spyOn(getStore().db, "get").mockImplementation(() => { throw new Error("lookup-failed"); });
    const response = await app.inject({ url: "/api/jobs", headers: { ...header(), origin: "https://untrusted.example" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "wallet_link_unavailable" });
  });
  it("14 refuses a valid proof for a different kernel operatorAddress", async () => {
    await link();
    getRepos().kernels.update(KERNEL, { operatorAddress: privateKeyToAccount(generatePrivateKey()).address });
    await refused(header());
  });
  it.each(["chain", "key-type", "account", "request-creator", "request-approver"])("refuses a mismatched persisted %s", async field => {
    const linked = await link();
    // These corrupt states cannot be produced by W1's validated, atomic API.
    const db = getStore().db;
    if (field === "chain") db.run(sql`UPDATE wallet_links SET chain_id = 1 WHERE id = ${linked.linkId}`);
    if (field === "key-type") db.run(sql`UPDATE wallet_links SET key_type = 'ed25519' WHERE id = ${linked.linkId}`);
    if (field === "account") db.run(sql`UPDATE wallet_links SET account_id = ${OTHER_OPERATOR} WHERE id = ${linked.linkId}`);
    if (field === "request-creator") db.run(sql`UPDATE wallet_link_requests SET created_by_key_id = NULL WHERE id = ${linked.requestId}`);
    if (field === "request-approver") db.run(sql`UPDATE wallet_link_requests SET approved_by_key_id = NULL WHERE id = ${linked.requestId}`);
    await refused(header());
  });
  it("15 preserves actor and IP in normal DECIDE write audits without copying the wallet header", async () => {
    await link();
    logs.length = 0;
    const audit = vi.spyOn(auditService, "log");
    expect((await evidence(header())).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/operator/policy/${KERNEL}`, headers: header(), payload: { emergencyStop: false } })).statusCode).toBe(200);
    expect(audit).toHaveBeenCalled();
    const writes = getRepos().auditLog.query({ eventType: "http.write" });
    for (const [method, url] of [["POST", "/api/operator/evidence"], ["PATCH", `/api/operator/policy/${KERNEL}`]]) {
      expect(writes.find(row => (row.metadata as Record<string, unknown> | null)?.url === url)).toMatchObject({
        eventType: "http.write", actor: OPERATOR, ip: "127.0.0.1", resourceType: "http",
        action: method!.toLowerCase(), metadata: { method, url, statusCode: 200 },
      });
    }
    const sinks = JSON.stringify([logs, writes, audit.mock.calls]);
    expect(sinks.toLowerCase()).not.toContain(wallet.address.toLowerCase());
  });
  it("15 preserves a wallet-valued claimed operator in audit when the header is present", async () => {
    const claimedKey = provisionApiKey({ operatorId: wallet.address, scopes: ["*"] });
    await link({ creator: claimedKey, approver: claimedKey });
    expect((await evidence(header(wallet.address, claimedKey))).statusCode).toBe(200);
    expect(getRepos().auditLog.query({ eventType: "http.write" }).find(row =>
      (row.metadata as Record<string, unknown> | null)?.url === "/api/operator/evidence")).toMatchObject({
      actor: wallet.address, ip: "127.0.0.1", metadata: { method: "POST", statusCode: 200 },
    });
  });
  it("preserves proven and claimed principals for header-carrying intent capture", async () => {
    await link();
    const track = vi.mocked(posthog.trackServerEvent);
    track.mockClear();
    expect((await app.inject({ method: "POST", url: "/api/w1b/intent", headers: header() })).statusCode).toBe(200);
    expect(track).toHaveBeenCalledWith("w1b_intent", { actorId: wallet.address.toLowerCase(), actorType: "authenticated_operator" });
    track.mockClear();
    expect((await app.inject({ method: "POST", url: "/api/w1b/intent", headers: header("malformed") })).statusCode).toBe(200);
    expect(track).toHaveBeenCalledWith("w1b_intent", { actorId: OPERATOR, actorType: "authenticated_key" });
  });
});
