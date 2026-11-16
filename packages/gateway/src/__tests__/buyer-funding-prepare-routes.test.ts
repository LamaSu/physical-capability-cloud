import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { custom, decodeFunctionData, encodeFunctionResult, getAddress, toHex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI, policySalt, predictEscrow } from "@pcc/contracts/vnext";
import { buyerFundingRoutes } from "../routes/buyer-funding.js";
import { operatorRoutes } from "../routes/operator.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { walletsRoutes } from "../routes/wallets.js";
import { apiGate } from "../middleware/api-gate.js";
import { BUYER_MISMATCH, BUYER_PROOF_REQUIRED } from "../auth/buyer-identity.js";
import { AUTHENTICATION_REQUIRED, EXPLICIT_CREDENTIAL_REQUIRED } from "../auth/kernel-authority.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import { configuredVNextDeploymentRecord } from "../services/paid-scope-activation-terms.js";
import { __setVNextTransportForTest } from "../services/vnext-rpc-client.js";
import { __setBuyerFundingTestUnitForTest, fundingPrepareRow, prepareRefusalAnswer, prepareSigningInput } from "../services/buyer-funding-prepare.js";
import { getSignerAddress } from "../contracts/escrow-client.js";
import { setUpFixture, tearDownFixture, asKey, OTHER, type Fixture } from "./helpers/paid-scope-fixture.js";
import { actAsJobParty } from "./helpers/job-read-party.js";
import { C, inputs, payload, configure, seedPrepare, counts, pendingBody } from "./helpers/buyer-funding-prepare-fixture.js";
import { hash } from "./helpers/buyer-funding-fixture.js";

vi.mock("../contracts/escrow-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../contracts/escrow-client.js")>(),
  getSignerAddress: vi.fn(() => undefined),
}));

let f: Fixture, app: FastifyInstance, gated: FastifyInstance;
let requests: Array<{ method: string; params: any[] }>;
const serverSource = () => readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const registered = () => expect(serverSource()).toContain("  await app.register(negotiationRoutes);\n  await app.register(buyerFundingRoutes);");
const buyerPath = (id: string) => `/api/buyer-funding/scopes/${id}/prepare`;
const operatorPath = (id: string) => `/api/operator/scopes/${id}/funding-prepare`;
const routes = [
  { method: "POST", path: buyerPath, buyer: true },
  { method: "GET", path: buyerPath, buyer: true },
  { method: "GET", path: operatorPath, buyer: false },
  { method: "POST", path: (id: string) => `${operatorPath(id)}/signature`, buyer: false },
] as const;
const unavailable = { error: "buyer_funding_unavailable", message: "Buyer funding is unavailable." };
const gateRequired = { error: "api_key_required", message: "This endpoint requires authentication. Provide an API key via Authorization: Bearer pcc_live_... header, or sign in with your wallet.",
  provision_url: "/api/auth/provision", docs: "https://capability.network/whitepaper.md" };
const operatorRequired = { error: "forbidden", reason: "operator_proof_required",
  message: "This needs the gateway admin secret, or proof that you control the kernel's operator wallet (wallet sign-in proof, WP-A). An API key's claimed identity is not proof." };
function installTransport(fail = false, onCall?: (functionName: string) => void) {
  const record = configuredVNextDeploymentRecord()!;
  const abi = [...VNextSettlementEscrowABI, ...VNextSettlementEscrowFactoryABI];
  __setVNextTransportForTest(custom({ request: async ({ method, params = [] }: any) => {
    requests.push({ method, params });
    if (fail) throw new Error("fixture read refused");
    if (method === "eth_chainId") return toHex(84532);
    if (method === "eth_getBlockByNumber" && params[0] === "latest") return { number: toHex(100), hash: hash(100), timestamp: toHex(C), transactions: [] };
    if (method === "eth_getCode") return "0x6000";
    if (method !== "eth_call") throw new Error("unexpected read");
    const decoded = decodeFunctionData({ abi, data: params[0].data });
    const values: Record<string, unknown> = { implementation: record.implementation, USDC: record.usdc, fundedEscrowOf: zeroAddress, policyNonceFloor: 0n };
    const result = decoded.functionName === "predictEscrow"
      ? predictEscrow({ factory: record.factory, implementation: record.implementation, salt: policySalt(decoded.args![0] as never) })
      : values[decoded.functionName];
    onCall?.(decoded.functionName);
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result: result as never });
  } }, { retryCount: 0 }));
}
beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  f = await setUpFixture();
  configure(); vi.setSystemTime(Number(C) * 1000);
  vi.mocked(getSignerAddress).mockReturnValue(undefined);
  requests = []; installTransport();
  // setUpFixture seals its app; reproduce its route stack over the same store.
  app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null); app.decorateRequest("userId", null); app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async req => {
    const key = req.headers["x-test-key"];
    if (typeof key === "string") { req.operatorId = key; req.userId = key; }
  });
  actAsJobParty(app, inputs.operator);
  app.addHook("onRequest", async req => {
    if (req.headers["x-test-carrier"] === "cookie") req.provenWalletCarrier = "cookie";
  });
  await app.register(walletsRoutes);
  await app.register(negotiationRoutes);
  await app.register(buyerFundingRoutes);
  await app.register(paidJobFlowRoutes);
  await app.register(deviceRelayRoutes);
  await app.register(operatorRoutes);
  await app.ready();
  gated = Fastify({ logger: false });
  await gated.register(cookie); await gated.register(apiGate); await gated.register(walletsRoutes);
  await gated.register(negotiationRoutes); await gated.register(buyerFundingRoutes); await gated.register(operatorRoutes);
  await gated.ready();
});
afterEach(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VITEST", "true");
  __setVNextTransportForTest(null); __setBuyerFundingTestUnitForTest(null);
  await app?.close(); await gated?.close(); await tearDownFixture(f);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe("buyerFundingRoutes and operatorRoutes", () => {
  it.each(["PCC_VNEXT_RECORD_NETWORK", "PCC_VNEXT_RPC_URL"] as const)("INERT2: buyerFundingAvailable refuses with %s unset", async env => {
    registered(); const j = seedPrepare(); const before = counts();
    const key = provisionApiKey({ operatorId: inputs.payer, scopes: ["*"] });
    vi.stubEnv(env, "");
    for (const route of routes) for (const id of [j.scopeId, "unknown-scope"]) {
      const response = await gated.inject({ method: route.method, url: route.path(id), headers: { authorization: `Bearer ${key.rawKey}` } });
      expect(response.statusCode).toBe(503); expect(response.json()).toEqual(unavailable);
      const anonymous = await gated.inject({ method: route.method, url: route.path(id) });
      expect(anonymous.statusCode).toBe(401); expect(anonymous.json()).toEqual(gateRequired);
    }
    expect(counts()).toEqual(before); expect(requests).toEqual([]);
  });
  it.each(routes)("RT1: authority and object binding precede reads for $method $path", async route => {
    registered(); const j = seedPrepare(); const before = counts();
    const anonymous = await gated.inject({ method: route.method, url: route.path(j.scopeId) });
    expect(anonymous.statusCode).toBe(401); expect(anonymous.json()).toEqual(gateRequired);
    const handlerAnonymous = await app.inject({ method: route.method, url: route.path(j.scopeId), headers: { "x-test-principal": "", "x-test-proven-wallet": "none" } });
    expect(handlerAnonymous.statusCode).toBe(401); expect(handlerAnonymous.json()).toEqual(AUTHENTICATION_REQUIRED);
    const missing = await app.inject({ method: route.method, url: route.path("unknown-scope"), headers: asKey(inputs.payer) });
    expect(missing.statusCode).toBe(404); expect(missing.json()).toEqual({ error: "scope_not_found", message: "The execution scope was not found." });
    const mismatch = await app.inject({ method: route.method, url: route.path(j.scopeId), headers: asKey(OTHER) });
    expect(mismatch.statusCode).toBe(403); expect(mismatch.json()).toEqual(route.buyer ? BUYER_MISMATCH : operatorRequired);
    if (route.buyer) {
      const claimed = await app.inject({ method: route.method, url: route.path(j.scopeId), headers: { ...asKey(inputs.payer), "x-test-proven-wallet": "none" } });
      expect(claimed.statusCode).toBe(403); expect(claimed.json()).toEqual(BUYER_PROOF_REQUIRED);
    }
    vi.stubEnv("PCC_VNEXT_RPC_URL", "");
    const inert = await app.inject({ method: route.method, url: route.path("unknown-scope"), headers: asKey(inputs.payer) });
    expect(inert.statusCode).toBe(503); expect(inert.json()).toEqual(unavailable);
    expect(counts()).toEqual(before); expect(requests).toEqual([]);
  });
  it("RT2: server.ts registers buyerFundingRoutes directly after negotiationRoutes and after walletsRoutes", () => {
    registered(); const source = serverSource();
    expect(source.indexOf("await app.register(buyerFundingRoutes);")).toBeGreaterThan(source.indexOf("await app.register(walletsRoutes"));
  });
  it("RT3: prepareRowAnswer serves the golden bytes through HTTP", async () => {
    registered(); const j = seedPrepare(); const headers = asKey(inputs.payer);
    const first = await app.inject({ method: "POST", url: buyerPath(j.scopeId), headers });
    expect(first.statusCode).toBe(202); expect(first.json()).toEqual(pendingBody);
    const pending = await app.inject({ url: buyerPath(j.scopeId), headers });
    expect(pending.statusCode).toBe(202); expect(pending.json()).toEqual(pendingBody);
    const signing = await app.inject({ url: operatorPath(j.scopeId) });
    expect(signing.statusCode).toBe(200);
    expect(signing.json()).toEqual(prepareSigningInput(fundingPrepareRow(j.scopeId)!));
    expect(signing.json().subjectBlock).toEqual(inputs.subject);
    expect(signing.json().units).toEqual(payload.fund.configs); expect(signing.json().bindings).toEqual([]);
    expect(signing.json().policy.escrow).toBe(getAddress(payload.escrow));
    expect(signing.json().policy.chainId).toBe(payload.chainId); expect(signing.json().policy.factory).toBe(payload.factory);
    expect(signing.json().policy.expiry).toBe(payload.expiry);
    const signed = await app.inject({ method: "POST", url: `${operatorPath(j.scopeId)}/signature`, payload: { signature: payload.fund.acceptance.operatorSignature } });
    expect(signed.statusCode, signed.body).toBe(200); expect(signed.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(signed.json()).toEqual(payload); expect(signed.rawPayload).toEqual(Buffer.from(JSON.stringify(payload)));
    const before = counts(), frozen = fundingPrepareRow(j.scopeId), calls = requests.length;
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({ method, url: buyerPath(j.scopeId), headers });
      expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(signed.rawPayload);
      expect(counts()).toEqual(before); expect(fundingPrepareRow(j.scopeId)).toEqual(frozen);
    }
    expect(requests.length).toBe(calls);
  });
  it("RT4: no_prepare, signature_malformed and prepare_expired retain their complete bodies", async () => {
    const j = seedPrepare(), headers = asKey(inputs.payer);
    for (const url of [buyerPath(j.scopeId), operatorPath(j.scopeId)]) {
      const missing = await app.inject({ url, headers: url === buyerPath(j.scopeId) ? headers : {} });
      expect(missing.statusCode).toBe(404); expect(missing.json()).toEqual({ error: "no_prepare", message: "The scope has no funding prepare." });
    }
    expect((await app.inject({ method: "POST", url: buyerPath(j.scopeId), headers })).statusCode).toBe(202);
    const malformed = await app.inject({ method: "POST", url: `${operatorPath(j.scopeId)}/signature`, payload: { signature: "0x1234" } });
    expect(malformed.statusCode).toBe(400); expect(malformed.json()).toEqual({ error: "signature_malformed", message: "The signature must be a canonical EOA signature." });
    vi.setSystemTime((fundingPrepareRow(j.scopeId)!.expiry - 600) * 1000 + 1);
    const expired = await app.inject({ url: buyerPath(j.scopeId), headers });
    expect(expired.statusCode).toBe(410); expect(expired.json()).toEqual({ error: "prepare_expired", message: "The funding prepare has expired." });
    expect(fundingPrepareRow(j.scopeId)!.state).toBe("expired");
  });
  it("RT6: prepareBuyerFunding refuses the default gateway signer as operator", async () => {
    const j = seedPrepare(); const before = counts();
    vi.mocked(getSignerAddress).mockReturnValue(inputs.operator);
    const response = await app.inject({ method: "POST", url: buyerPath(j.scopeId), headers: asKey(inputs.payer) });
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: "operator_unusable", message: "The operator cannot sign this policy." });
    expect(counts()).toEqual(before); expect(requests).toEqual([]);
  });
  for (const late of [true, false]) it(`RT7: prepareBuyerFunding ${late ? "refuses after" : "accepts at"} the serve margin edge over HTTP`, async () => {
    const j = seedPrepare({ scopeExp: C + 2800n });
    const atMs = Number(C + 100n) * 1000; vi.setSystemTime(atMs);
    installTransport(false, name => { if (late && name === "policyNonceFloor") vi.setSystemTime(atMs + 1000); });
    const before = counts();
    const response = await app.inject({ method: "POST", url: buyerPath(j.scopeId), headers: asKey(inputs.payer) });
    expect(response.statusCode).toBe(late ? 409 : 202);
    expect(response.json()).toEqual(late ? prepareRefusalAnswer("window_too_short").body : pendingBody);
    if (late) { expect(counts()).toEqual(before); expect(fundingPrepareRow(j.scopeId)).toBeUndefined(); }
  });
  it("RT8a: operatorRoutes requires explicit credentials to view the signing input", async () => {
    const j = seedPrepare();
    expect((await app.inject({ method: "POST", url: buyerPath(j.scopeId), headers: asKey(inputs.payer) })).statusCode).toBe(202);
    const response = await app.inject({ url: operatorPath(j.scopeId), headers: { "x-test-carrier": "cookie" } });
    expect(response.statusCode).toBe(403); expect(response.json()).toEqual(EXPLICIT_CREDENTIAL_REQUIRED);
    expect(fundingPrepareRow(j.scopeId)!.signatureRequestedAt).toBeNull();
    const control = await app.inject({ url: operatorPath(j.scopeId) });
    expect(control.statusCode).toBe(200); expect(control.json()).toEqual(prepareSigningInput(fundingPrepareRow(j.scopeId)!));
  });
  it("RT8b: operatorRoutes requires explicit credentials to submit a signature", async () => {
    const j = seedPrepare();
    expect((await app.inject({ method: "POST", url: buyerPath(j.scopeId), headers: asKey(inputs.payer) })).statusCode).toBe(202);
    const signature = { signature: payload.fund.acceptance.operatorSignature };
    const response = await app.inject({ method: "POST", url: `${operatorPath(j.scopeId)}/signature`, headers: { "x-test-carrier": "cookie" }, payload: signature });
    expect(response.statusCode).toBe(403); expect(response.json()).toEqual(EXPLICIT_CREDENTIAL_REQUIRED);
    expect(fundingPrepareRow(j.scopeId)).toMatchObject({ state: "pending_signature", operatorSignature: null, servedPayload: null, signatureVerifiedAt: null });
    const signing = await app.inject({ url: operatorPath(j.scopeId) });
    expect(signing.statusCode).toBe(200); expect(signing.json()).toEqual(prepareSigningInput(fundingPrepareRow(j.scopeId)!));
    const control = await app.inject({ method: "POST", url: `${operatorPath(j.scopeId)}/signature`, payload: signature });
    expect(control.statusCode).toBe(200); expect(control.rawPayload).toEqual(Buffer.from(JSON.stringify(payload), "utf8"));
  });
  it("RT9: prepareBuyerFunding forbids a disallowed testnet buyer before chain reads", async () => {
    const j = seedPrepare(); const before = counts();
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", privateKeyToAccount(generatePrivateKey()).address);
    const response = await app.inject({ method: "POST", url: buyerPath(j.scopeId), headers: asKey(inputs.payer) });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "testnet_buyer_not_allowed", message: "The buyer is not allowed on this testnet." });
    expect(counts()).toEqual(before); expect(requests).toEqual([]);
  });
  it("AUTH1: bindBuyer loses agent proof when walletsRoutes revokes its link", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const key = provisionApiKey({ operatorId: wallet.address, scopes: ["*"] });
    const bearer = { authorization: `Bearer ${key.rawKey}` }, headers = { ...bearer, "x-pcc-wallet": wallet.address };
    installTransport(true);
    const created = await gated.inject({ method: "POST", url: "/api/wallets/link-requests", headers: bearer,
      payload: { keyType: "secp256k1", address: wallet.address.toLowerCase(), chainId: 84532, role: "agent", label: "buyer-prepare" } });
    expect(created.statusCode).toBe(201); const request = created.json();
    const signature = await wallet.signMessage({ message: request.message });
    expect((await gated.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/proof`, payload: { signature } })).statusCode).toBe(200);
    expect((await gated.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/approve`, headers: bearer,
      payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } })).statusCode).toBe(200);
    const j = seedPrepare({ payer: wallet.address.toLowerCase() });
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", wallet.address);
    const control = await gated.inject({ method: "POST", url: buyerPath(j.scopeId), headers });
    expect(control.statusCode).toBe(503); expect(control.json()).toEqual({ error: "rpc_unavailable", message: "The chain reads are unavailable." });
    expect(requests.length).toBeGreaterThan(0);
    const before = counts(), calls = requests.length;
    const listed = await gated.inject({ url: "/api/wallets", headers: bearer });
    expect(listed.statusCode).toBe(200); const links = listed.json().links; expect(links).toHaveLength(1);
    expect((await gated.inject({ method: "POST", url: `/api/wallets/${links[0].linkId}/revoke`, headers: bearer, payload: {} })).statusCode).toBe(200);
    for (const method of ["POST", "GET"] as const) {
      const response = await gated.inject({ method, url: buyerPath(j.scopeId), headers });
      expect(response.statusCode).toBe(403); expect(response.json()).toEqual(BUYER_PROOF_REQUIRED);
    }
    expect(counts()).toEqual(before); expect(requests.length).toBe(calls);
  });
});
