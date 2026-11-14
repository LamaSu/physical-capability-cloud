import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, sql } from "@pcc/store";
import { custom, createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionResult, getAddress, toHex, zeroHash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI, predictEscrow, policySalt } from "@pcc/contracts/vnext";
import { dryRunUnitTestnetExpectation, prepareFunding } from "@pcc/spec/funding";
import { negotiationRoutes } from "../routes/negotiation.js";
import { escrowRoutes } from "../routes/escrow.js";
import { getRepos, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { actAsJobParty } from "./helpers/job-read-party.js";
import { setUpFixture, tearDownFixture, db, submit, basePolicy, setPolicy, KERNEL, BUYER, ADMIN, asKey, scopeRow, setEscrow, type Fixture } from "./helpers/paid-scope-fixture.js";
import { wire } from "./helpers/buyer-funding-fixture.js";
import { inputs, payload, C, configure, seedPrepare, selectUnit, prepareReads, recompile, counts, pendingBody } from "./helpers/buyer-funding-prepare-fixture.js";
import { BUYER_FUNDED_ESCROW_VERSION, findEscrowRowByAddress } from "../services/buyer-funded-escrow.js";
import { preparedActivationTtlMs } from "../services/paid-scope-activation-terms.js";
import { servedPrepareTtlMs } from "../services/funding-prepare-ttl.js";
import { escrowForJob } from "../services/scope-acceptance.js";
import { BUYER_FUNDING_SWEEP_INTERVAL_SEC } from "../services/buyer-funding-sweep.js";
import { __setVNextTransportForTest } from "../services/vnext-rpc-client.js";
import { prepareBuyerFunding, operatorPrepareView, servePrepareSignature, prepareRowAnswer, fundingPrepareRow, prepareSigningInput,
  buyerFundingSelection, commitBuyerFundingSelection, prepareRefusalAnswer, buyerFundingUnitEntry, __setBuyerFundingTestUnitForTest, BuyerFundingSelectionError,
  DRY_RUN_UNIT_ID, PREPARE_MARGIN_SECONDS, SERVE_MARGIN_SECONDS, CHAIN_CLOCK_LEAD_MAX_SECONDS } from "../services/buyer-funding-prepare.js";

let f: Fixture;
let negotiation: FastifyInstance;
let transportRequests: unknown[];
beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  f = await setUpFixture();
  configure();
  transportRequests = [];
  __setVNextTransportForTest(custom({ request: async req => { transportRequests.push(req); throw new Error("unexpected transport"); } }, { retryCount: 0 }));
  negotiation = Fastify({ logger: false });
  negotiation.decorateRequest("operatorId", null);
  negotiation.addHook("onRequest", async req => { (req as any).operatorId = req.headers["x-test-key"] ?? BUYER; });
  actAsJobParty(negotiation);
  await negotiation.register(negotiationRoutes);
  await negotiation.ready();
});
afterEach(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VITEST", "true");
  __setVNextTransportForTest(null); __setBuyerFundingTestUnitForTest(null);
  await negotiation?.close(); await tearDownFixture(f);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
const sessionRow = (id: string) => db().select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.id, id)).get()!;
const updateScope = (id: string, over: Partial<typeof schema.executionScopes.$inferInsert>) => db().update(schema.executionScopes).set(over).where(eq(schema.executionScopes.id, id)).run();
const updateSession = (id: string, over: Partial<typeof schema.negotiationSessions.$inferInsert>) => db().update(schema.negotiationSessions).set(over).where(eq(schema.negotiationSessions.id, id)).run();
const updateOperator = (address: string) => db().update(schema.shopKernels).set({ operatorAddress: address }).where(eq(schema.shopKernels.id, KERNEL)).run();
async function quoted(buyer = BUYER) {
  const headers = { ...asKey(buyer), "x-admin-key": ADMIN };
  const created = await negotiation.inject({ method: "POST", url: "/api/negotiate/session", headers,
    payload: { kernelId: KERNEL, capabilityType: "liquid-handler", userAgentId: buyer } });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().session.id;
  for (const step of ["quote", "review"]) expect((await negotiation.inject({ method: "POST", url: `/api/negotiate/session/${id}/${step}`, headers })).statusCode).toBe(200);
  return { id, commit: () => negotiation.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit`, headers }) };
}
function noJobChanges(before: number[]) {
  expect([db().select().from(schema.jobs).all().length, db().select().from(schema.executionScopes).all().length, ...counts()]).toEqual(before);
}
const allCounts = () => [db().select().from(schema.jobs).all().length, db().select().from(schema.executionScopes).all().length, ...counts()];
async function selectionFailure(code: string, buyer = BUYER) {
  const q = await quoted(buyer); const before = allCounts();
  const response = await q.commit();
  expect(response.statusCode, response.body).toBe(502);
  expect(response.json()).toEqual({ error: "settlement_failed", message: code, sessionId: q.id, jobId: sessionRow(q.id).jobId });
  expect(sessionRow(q.id).status).toBe("settlement_failed");
  expect(sessionRow(q.id).transitions.at(-1)?.reason).toBe("settlement_failed:preflight_no_escrow");
  noJobChanges(before);
  return q;
}
async function prepare(j: ReturnType<typeof seedPrepare>, r = prepareReads()) {
  const answer = await prepareBuyerFunding(j.scopeId, r.deps);
  expect(answer.kind, JSON.stringify(answer)).toBe("answer");
  if (answer.kind !== "answer") throw new Error(answer.code);
  return answer.row;
}
async function signed(j: ReturnType<typeof seedPrepare>) {
  const row = await prepare(j);
  expect((await servePrepareSignature(j.scopeId, payload.fund.acceptance.operatorSignature)).status).toBe(200);
  return fundingPrepareRow(j.scopeId)!;
}
function assertKeys(actual: any, expected: any) {
  if (expected && typeof expected === "object") {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    for (const k of Object.keys(expected)) assertKeys(actual[k], expected[k]);
  }
}
function marker(j: ReturnType<typeof seedPrepare>) { return getRepos().escrows.findByCwm(j.cwmId)!; }
function markerInsert(j: ReturnType<typeof seedPrepare>) {
  return getRepos().escrows.insert({ ...getRepos().escrows.findAll()[0]!, id: `marker-${randomUUID()}`, cwmId: j.cwmId,
    contractAddress: `0x${"99".repeat(20)}`, payer: j.payer, status: "created", version: BUYER_FUNDED_ESCROW_VERSION });
}

for (const mock of ["true", undefined]) describe(`createJobFromSession selection with MOCK_SETTLEMENT=${String(mock)}`, () => {
  beforeEach(() => vi.stubEnv("MOCK_SETTLEMENT", mock));
  it("SEL2: selected submit and commit mint only the job and awaiting scope", async () => {
    selectUnit(); const before = counts();
    const fast = await submit(f); expect(fast.statusCode, fast.body).toBe(201);
    expect(fast.json()).toMatchObject({ escrowId: null, escrowAddress: null, escrowStatus: null, fundingMode: "vnext_buyer" });
    const q = await quoted(); const commit = await q.commit(); expect(commit.statusCode, commit.body).toBe(200);
    expect(commit.json()).toMatchObject({ escrowId: null, escrowAddress: null, escrowStatus: null, fundingMode: "vnext_buyer",
      message: "Session committed. Job and execution scope created. The buyer funds the escrow after the kernel's operator accepts (POST /api/buyer-funding/scopes/:scopeId/prepare)." });
    for (const res of [fast, commit]) {
      const b = res.json(); expect(scopeRow(b.scopeId).status).toBe("awaiting_acceptance");
      const s = sessionRow(b.sessionId ?? b.session.id); expect(s.escrowAddress).toBeNull();
      expect(getRepos().escrows.findByCwm(s.cwmId!)).toBeUndefined();
    }
    expect(counts()).toEqual(before); expect(transportRequests).toEqual([]);
  });
  it("SEL6: useV3ModeA keeps selected jobs on the buyer path", async () => {
    vi.stubEnv("PCC_USE_V3_MODE_A", "true"); selectUnit();
    const before = counts(); const q = await quoted(); const res = await q.commit();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ fundingMode: "vnext_buyer", escrowId: null, escrowAddress: null, escrowStatus: null });
    expect(counts()).toEqual(before); expect(transportRequests).toEqual([]);
  });
});

describe("buyerFundingSelection", () => {
  it("SEL1: absent selection preserves legacy submit and commit replies", async () => {
    for (const res of [await submit(f), await (await quoted()).commit()]) {
      expect([200, 201]).toContain(res.statusCode); const b = res.json();
      expect(b).not.toHaveProperty("fundingMode"); expect(typeof b.escrowId).toBe("string"); expect(typeof b.escrowAddress).toBe("string");
      expect(scopeRow(b.scopeId).status).toBe("awaiting_acceptance");
      const s = sessionRow(b.sessionId ?? b.session.id);
      expect(getRepos().escrows.findByCwm(s.cwmId!)?.id).toBe(b.escrowId);
      expect(getRepos().escrows.findMilestonesByEscrow(b.escrowId)).toHaveLength(1);
    }
  });
  for (const mode of ["mock", "real", "signer"]) for (const value of ["dry-run-unit-testnet-v2", "", 1, null, {}, [DRY_RUN_UNIT_ID]]) {
    it(`SEL3: invalid selection ${JSON.stringify(value)} refuses before writes in ${mode}`, async () => {
      vi.stubEnv("MOCK_SETTLEMENT", mode === "mock" ? "true" : undefined);
      if (mode === "signer") vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", generatePrivateKey());
      selectUnit(value); await selectionFailure("buyer_funding_selection_invalid");
      const before = allCounts(); const fast = await submit(f);
      expect(fast.statusCode).toBe(500); expect(fast.json()).toEqual({ error: "fast_track_failed", details: "buyer_funding_selection_invalid" });
      noJobChanges(before); expect(transportRequests).toEqual([]);
    });
  }
  for (const key of ["PCC_VNEXT_RECORD_NETWORK", "PCC_VNEXT_RPC_URL"]) it(`SEL4: selected commit requires ${key}`, async () => {
    selectUnit(); vi.stubEnv(key, undefined); await selectionFailure("buyer_funding_unavailable");
  });
  for (const [field, value] of [["chainId", 8453], ["scheduleId", "vnext-mainnet-v1"], ["scheduleTestnetOnly", false], ["usdc", BUYER]] as const) {
    it(`SEL10: commitBuyerFundingSelection checks the record's ${field}`, async () => {
      __setBuyerFundingTestUnitForTest({ ...buyerFundingUnitEntry(DRY_RUN_UNIT_ID)!, id: "record-mismatch-unit", [field]: value });
      selectUnit("record-mismatch-unit");
      let error: unknown;
      try { commitBuyerFundingSelection(KERNEL, BUYER); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(BuyerFundingSelectionError);
      expect(error).toMatchObject({ code: "buyer_funding_unavailable" });
      await selectionFailure("buyer_funding_unavailable");
    });
  }
  for (const value of ["toString", "constructor", "__proto__"]) it(`SEL9: buyerFundingSelection requires an own unit key for ${value}`, () => {
    selectUnit(value);
    let error: unknown;
    try { buyerFundingSelection(KERNEL, "commit"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(BuyerFundingSelectionError);
    expect(error).toMatchObject({ code: "buyer_funding_selection_invalid" });
    expect(buyerFundingSelection(KERNEL, "prepare")).toBeNull();
  });
  it("SEL5: selected commit requires a wallet buyer", async () => { selectUnit(); await selectionFailure("buyer_not_wallet", "agent-alice"); });
  it("SEL7: unreadable policy preserves commit and refuses prepare", async () => {
    const j = seedPrepare(); const q = await quoted();
    db().run(sql`UPDATE operator_policies SET policy = ${"not json"} WHERE kernel_id = ${KERNEL}`);
    const res = await q.commit(); expect(res.statusCode, res.body).toBe(200); expect(res.json()).not.toHaveProperty("fundingMode");
    const r = prepareReads(); const before = counts();
    expect(await prepareBuyerFunding(j.scopeId, r.deps)).toEqual({ kind: "refused", code: "policy_unavailable" });
    expect(counts()).toEqual(before); expect(r.calls).toEqual([]);
  });
  it("SEL8: a selected preflight refusal retries after configuration", async () => {
    selectUnit(); vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", undefined); const q = await selectionFailure("buyer_funding_unavailable");
    configure(); const res = await negotiation.inject({ method: "POST", url: `/api/negotiate/session/${q.id}/retry-settlement`, headers: asKey(BUYER) });
    expect(res.statusCode, res.body).toBe(200); expect(res.json()).toMatchObject({ retried: true, fundingMode: "vnext_buyer" });
    expect(res.json().message).toBe("Settlement retried. Job and execution scope created. The buyer funds the escrow after the kernel's operator accepts (POST /api/buyer-funding/scopes/:scopeId/prepare).");
    expect(scopeRow(res.json().scopeId).status).toBe("awaiting_acceptance");
    setPolicy(KERNEL, { ...basePolicy(), vnextBuyerFunding: undefined }); const legacy = await quoted(); updateSession(legacy.id, { status: "settlement_failed", transitions: [{ reason: "settlement_failed:preflight_no_escrow" }] });
    const retried = await negotiation.inject({ method: "POST", url: `/api/negotiate/session/${legacy.id}/retry-settlement`, headers: asKey(BUYER) });
    expect(retried.statusCode).toBe(200); expect(retried.json()).not.toHaveProperty("fundingMode");
    expect(retried.json().message).toBe("Settlement retried. Job, escrow, and execution scope created.");
  });
  for (const mock of ["true", undefined]) it(`SEL11: retry-settlement preserves a selection refusal with MOCK_SETTLEMENT=${String(mock)}`, async () => {
    vi.stubEnv("MOCK_SETTLEMENT", mock);
    selectUnit(); vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", undefined);
    const q = await selectionFailure("buyer_funding_unavailable");
    const before = allCounts();
    const response = await negotiation.inject({ method: "POST", url: `/api/negotiate/session/${q.id}/retry-settlement`, headers: asKey(BUYER) });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "settlement_failed", message: "buyer_funding_unavailable", sessionId: q.id, jobId: sessionRow(q.id).jobId });
    expect(sessionRow(q.id).status).toBe("settlement_failed");
    expect(sessionRow(q.id).transitions.at(-1)?.reason).toBe("settlement_failed:preflight_no_escrow");
    expect(allCounts()).toEqual(before);
  });
  it("BuyerFundingSelectionError carries only its closed code", () => {
    const e = new BuyerFundingSelectionError("buyer_not_wallet"); expect(e.name).toBe("BuyerFundingSelectionError"); expect(e.message).toBe(e.code);
  });
});

describe("prepareBuyerFunding canonical policy", () => {
  beforeEach(() => vi.setSystemTime(Number(C) * 1000));
  it("GOLD1: prepareSigningInput and served bytes match the frozen fixtures", async () => {
    const j = seedPrepare(); const row = await prepare(j);
    const view = operatorPrepareView(j.scopeId); expect(view.status).toBe(200);
    expect((view.body as any).subjectBlock).toEqual(inputs.subject);
    expect((view.body as any).policy.escrow).toBe(getAddress(payload.escrow));
    const answer = await servePrepareSignature(j.scopeId, payload.fund.acceptance.operatorSignature);
    expect(answer.status).toBe(200); const stored = fundingPrepareRow(j.scopeId)!;
    expect(JSON.parse(stored.servedPayload!.toString())).toEqual(payload);
    assertKeys(JSON.parse(stored.servedPayload!.toString()), payload);
    expect(stored.servedPayload).toEqual(Buffer.from(JSON.stringify(payload), "utf8"));
    expect(answer.body).toEqual(stored.servedPayload);
    expect(row.typedDataDigest).toBe(recompile().digest);
  });
  it("GOLD2: frozen windows, hashes and served TTL match the canonical compiler", async () => {
    const j = seedPrepare(); const row = await signed(j);
    expect(row).toMatchObject({ expiry: 1800001200, reclaimAtEarliest: 1800007200, reclaimAtLatest: 1800007200, reconcileUntil: 1800004500,
      finalityFS: 1800, marginMS: 300, totalGross: "1000000", policyNonce: "0", escrow: payload.escrow,
      termsHash: payload.typedData.message.termsHash, typedDataDigest: recompile().digest });
    expect(servedPrepareTtlMs(j.scopeId)).toBe(900000); expect(preparedActivationTtlMs(scopeRow(j.scopeId))).toBe(900000);
    expect(row.servedPayloadSha256).toBe(createHash("sha256").update(row.servedPayload!).digest("hex"));
  });
  it("GOLD3 WIN3: another buyer's scope-arm policy is accepted by prepareFunding", async () => {
    const account = privateKeyToAccount(generatePrivateKey()); const payer = "0x6666666666666666666666666666666666666666";
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", payer);
    const j = seedPrepare({ payer, operator: account.address, jobId: "sdk-second-job", scopeExp: C + 3000n });
    const row = await prepare(j); expect(row.expiry).toBe(Number(C + 900n));
    const signature = await account.sign({ hash: row.typedDataDigest as Hex });
    const answer = await servePrepareSignature(j.scopeId, signature); expect(answer.status).toBe(200);
    const r = prepareReads();
    const transport = custom({ request: async ({ method, params = [] }: any) => {
      if (method === "eth_chainId") return toHex(84532);
      if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") return { number: "0x64", hash: zeroHash, timestamp: toHex(C), transactions: [] };
      if (method === "eth_getCode") return "0x6000";
      const abi = [...VNextSettlementEscrowFactoryABI, ...VNextSettlementEscrowABI];
      const decoded = decodeFunctionData({ abi, data: params[0].data });
      const values: any = { implementation: r.record.implementation, USDC: r.record.usdc };
      const result = decoded.functionName === "predictEscrow" ? predictEscrow({ factory: r.record.factory, implementation: r.record.implementation, salt: policySalt(decoded.args![0] as never) }) : values[decoded.functionName];
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result } as never);
    } }, { retryCount: 0 });
    const prepared = await prepareFunding({ payload: JSON.parse((answer.body as Buffer).toString()), wallet: createWalletClient({ account: payer, transport }), publicClient: createPublicClient({ transport }),
      quote: { maxTotalGross: 1000000n }, expect: dryRunUnitTestnetExpectation({ jobId: j.jobId, operator: account.address, fundingWallet: payer,
        subject: prepareSigningInput(row).subjectBlock, bindings: [], latestBlockTimestamp: C }) });
    expect(prepared.escrow.toLowerCase()).toBe(row.escrow); expect(prepared.totalGross.toString()).toBe(row.totalGross);
  });
});

const bldCases: Array<[string, string, (j: ReturnType<typeof seedPrepare>, r: ReturnType<typeof prepareReads>) => void]> = [];
for (const [name, address] of [["short", "0x1234"], ["payer", `0x${inputs.payer.slice(2).toUpperCase()}`]]) bldCases.push([`BLD1 ${name}`, "operator_unusable", () => updateOperator(address)]);
bldCases.push(["BLD1 gateway signer", "operator_unusable", (_j, r) => { r.deps.gatewaySigner = () => inputs.operator; }]);
for (const custody of ["gateway", null]) bldCases.push([`BLD1 custody ${custody}`, "operator_unusable", () => {
  const key = provisionApiKey({ operatorId: "custody-test", scopes: ["*"] });
  db().update(schema.apiKeys).set({ operatorWalletAddress: inputs.operator, operatorWalletCustody: custody }).where(eq(schema.apiKeys.id, key.record.id)).run();
}]);
for (const price of ["1.000001", "2", "1e0", " 1.00"]) bldCases.push([`BLD2 price ${price}`, "total_gross_not_quote", j => updateSession(j.sessionId, { quote: { totalPrice: price, currency: "USDC" } })]);
bldCases.push(["BLD2 currency", "total_gross_not_quote", j => updateSession(j.sessionId, { quote: { totalPrice: "1.00", currency: "USDT" } })]);
for (const milestones of [[{ amount: "1.00" }, { amount: "1.00" }], [{ amount: "0.99" }]]) bldCases.push([`BLD2 milestones ${JSON.stringify(milestones)}`, "milestones_not_quote", j => updateSession(j.sessionId, { contractTerms: { milestones } })]);
for (const assuranceTier of [0, 2, null]) bldCases.push([`BLD2 tier ${assuranceTier}`, "tier_not_quote", j => { db().update(schema.jobs).set({ assuranceTier }).where(eq(schema.jobs.id, j.jobId)).run(); }]);
for (const [key, value] of [["chainId", 8453], ["scheduleId", "vnext-mainnet-v1"], ["scheduleTestnetOnly", false], ["usdc", BUYER]] as const) bldCases.push([`BLD3 ${key}`, "unit_needs_testnet_record", (_j, r) => { (r.deps as any).record = { ...r.record, [key]: value }; }]);
bldCases.push(["BLD4 chain", "rpc_chain_mismatch", (_j, r) => vi.mocked(r.reads.chainId).mockResolvedValue(8453)],
  ["BLD4 latestBlock", "rpc_unavailable", (_j, r) => vi.mocked(r.reads.latestBlock).mockRejectedValue(new Error("read"))],
  ["BLD4 code", "deployment_mismatch", (_j, r) => vi.mocked(r.reads.code).mockResolvedValue("0x")]);
for (const [key, code, value] of [["implementation", "deployment_mismatch", BUYER], ["USDC", "deployment_mismatch", BUYER], ["predictEscrow", "escrow_not_predicted", BUYER], ["fundedEscrowOf", "escrow_already_funded", BUYER], ["policyNonceFloor", "nonce_revoked", 1n]] as const) bldCases.push([`BLD4 ${key}`, code, (_j, r) => { r.values[key] = value; }]);
bldCases.push(["BLD5 buyer", "buyer_not_wallet", j => updateScope(j.scopeId, { createdBy: "agent-alice" })],
  ["BLD5 allowance", "testnet_buyer_not_allowed", () => vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", BUYER)],
  ["BLD5 state", "scope_not_awaiting_funding", j => updateScope(j.scopeId, { status: "revoked" })],
  ["BLD5 expiry", "scope_expired", j => updateScope(j.scopeId, { expiresAt: new Date(Number(C) * 1000).toISOString() })],
  ["BLD5 stop", "kernel_emergency_stopped", () => setPolicy(KERNEL, { ...basePolicy(), emergencyStop: true })],
  ["BLD5 selection", "buyer_funding_not_selected", () => setPolicy(KERNEL, {})],
  ["BLD5 marker", "buyer_funding_not_selected", j => { markerInsert(j); }]);
for (const value of ["toString", "constructor", "__proto__"]) bldCases.push([`SEL9 ${value}`, "buyer_funding_not_selected", () => selectUnit(value)]);
for (const [label, code, change] of bldCases) it(`${label} TX6: prepareBuyerFunding refuses without writes`, async () => {
  vi.setSystemTime(Number(C) * 1000); const j = seedPrepare(); const r = prepareReads(); change(j, r);
  const before = counts(); const s = sessionRow(j.sessionId);
  expect(await prepareBuyerFunding(j.scopeId, r.deps)).toEqual({ kind: "refused", code });
  expect(counts()).toEqual(before); expect(sessionRow(j.sessionId)).toEqual(s);
  if (!label.startsWith("BLD4")) expect(r.calls).toEqual([]);
});
it("BLD6: prepareRefusalAnswer forbids a disallowed testnet buyer", () => {
  expect(prepareRefusalAnswer("testnet_buyer_not_allowed")).toEqual({ status: 403,
    body: { error: "testnet_buyer_not_allowed", message: "The buyer is not allowed on this testnet." } });
});
it("BLD1: explicitly operator-custodied API wallets remain usable", async () => {
  vi.setSystemTime(Number(C) * 1000); const j = seedPrepare(); const key = provisionApiKey({ operatorId: "own", scopes: ["*"] });
  db().update(schema.apiKeys).set({ operatorWalletAddress: inputs.operator, operatorWalletCustody: "operator" }).where(eq(schema.apiKeys.id, key.record.id)).run();
  await prepare(j);
});
it("BLD4: every deployment and policy read uses one block hash in order", async () => {
  vi.setSystemTime(Number(C) * 1000); const j = seedPrepare(); const r = prepareReads(); await prepare(j, r);
  expect(r.calls.map(c => c.method)).toEqual(["chainId", "latestBlock", "code", "implementation", "USDC", "predictEscrow", "fundedEscrowOf", "policyNonceFloor"]);
  expect(r.calls[2]!.args).toEqual([r.record.factory, r.block.hash]);
  for (const call of r.calls.slice(3)) expect(call.args[2]).toBe(r.block.hash);
  expect(r.calls[3]!.args[0]).toBe(r.record.factory); expect(r.calls[4]!.args[0]).toBe(r.record.implementation);
  expect(r.calls[5]!.args[1]).toEqual([recompile().identity]);
});

const winCases: Array<[string, bigint, bigint, bigint, string | null, Record<string, unknown>?]> = [
  ["WIN1 lag edge", C, C + 120n, C + 3600n, null], ["WIN1 lag outside", C, C + 121n, C + 3600n, "chain_clock_skew"],
  ["WIN2 lead edge", C, C - 2640n, C + 3600n, null], ["WIN2 lead outside", C, C - 2641n, C + 3600n, "chain_clock_skew"],
  ["WIN4 now arm edge", C, C + 100n, C + 2800n, null], ["WIN4 now arm outside", C, C + 100n, C + 2799n, "window_too_short"],
  ["WIN4 chain arm edge", C, C, C + 2700n, null], ["WIN4 chain arm outside", C, C, C + 2699n, "window_too_short"],
  ["WIN5 min edge", C, C, C + 3600n, null, { minReclaimDelaySec: 5100 }], ["WIN5 min outside", C, C, C + 3600n, "reclaim_window", { minReclaimDelaySec: 5101 }],
  ["WIN5 max edge", C, C, C + 3600n, null, { maxReclaimDelaySec: 7800 }], ["WIN5 max outside", C, C, C + 3600n, "reclaim_window", { maxReclaimDelaySec: 7799 }],
  ["WIN6 zero", C, C, C + 4500n, "ttl_unavailable"], ["WIN6 positive", C, C, C + 4499n, null],
];
for (const [label, chainS, nowS, scopeExp, code, record] of winCases) it(`${label} TX6: prepareBuyerFunding window boundary`, async () => {
  vi.setSystemTime(Number(nowS) * 1000); const j = seedPrepare({ scopeExp }); const r = prepareReads(chainS);
  const before = counts(); const s = sessionRow(j.sessionId);
  const answer = await prepareBuyerFunding(j.scopeId, { ...r.deps, now: () => new Date(Number(nowS) * 1000), ...(record ? { record: { ...r.record, ...record } } : {}) });
  if (code) { expect(answer).toEqual({ kind: "refused", code }); expect(counts()).toEqual(before); }
  else { expect(answer.kind).toBe("answer"); if (answer.kind === "answer" && label === "WIN6 positive") expect(answer.row.reconcileUntil * 1000 - Date.parse(answer.row.scopeExpiresAt)).toBe(1000); }
  expect(sessionRow(j.sessionId)).toEqual(s);
});
it("WIN7: PREPARE_MARGIN_SECONDS covers a sweep and SERVE_MARGIN_SECONDS includes buyer time", () => {
  expect(PREPARE_MARGIN_SECONDS).toBeGreaterThanOrEqual(BigInt(BUYER_FUNDING_SWEEP_INTERVAL_SEC.max + 120)); expect(SERVE_MARGIN_SECONDS).toBe(600n);
});

it("WIN8a: prepareBuyerFunding rechecks the serve margin at the transaction clock", async () => {
  const j = seedPrepare({ scopeExp: C + 2800n }); const r = prepareReads(C);
  const atMs = Number(C + 100n) * 1000; vi.setSystemTime(atMs);
  const now = vi.fn(() => new Date(atMs + 1000)).mockImplementationOnce(() => new Date(atMs));
  const before = counts(), session = sessionRow(j.sessionId);
  expect(await prepareBuyerFunding(j.scopeId, { ...r.deps, now })).toEqual({ kind: "refused", code: "window_too_short" });
  expect(counts()).toEqual(before); expect(sessionRow(j.sessionId)).toEqual(session);
});
it("WIN8b: prepareBuyerFunding returns the transaction clock at the serve margin edge", async () => {
  const j = seedPrepare({ scopeExp: C + 2800n }); const r = prepareReads(C);
  const atMs = Number(C + 100n) * 1000; vi.setSystemTime(atMs);
  const answer = await prepareBuyerFunding(j.scopeId, { ...r.deps, now: () => new Date(atMs) });
  expect(answer.kind).toBe("answer"); if (answer.kind !== "answer") throw new Error(answer.code);
  expect(answer.atMs).toBe(atMs);
  expect(prepareRowAnswer(answer.row, answer.atMs!)).toEqual({ status: 202, body: pendingBody });
});

function barrier(reads: ReturnType<typeof prepareReads>[], change?: () => void) {
  let resolve!: () => void; let reached!: () => void; let count = 0;
  const gate = new Promise<void>(r => { resolve = r; }); const ready = new Promise<void>(r => { reached = r; });
  for (const r of reads) vi.mocked(r.reads.latestBlock).mockImplementation(async () => { if (++count === reads.length) reached(); await gate; return r.block; });
  return { ready, resolve: () => { change?.(); resolve(); } };
}
describe("prepareBuyerFunding transaction", () => {
  beforeEach(() => vi.setSystemTime(Number(C) * 1000));
  it("TX1: existing pending, served and expired rows are the only prepare", async () => {
    const j = seedPrepare(); const row = await prepare(j); const before = counts();
    expect(await prepareBuyerFunding(j.scopeId, prepareReads().deps)).toEqual({ kind: "answer", row });
    expect(prepareRowAnswer(row, (row.expiry - 600) * 1000 + 1).status).toBe(410);
    const answer = await prepareBuyerFunding(j.scopeId, prepareReads().deps); expect(answer.kind).toBe("answer");
    if (answer.kind === "answer") expect(prepareRowAnswer(answer.row, Number(C) * 1000)).toEqual({ status: 410, body: { error: "prepare_expired", message: "The funding prepare has expired." } });
    expect(counts()).toEqual(before);
    const account = privateKeyToAccount(generatePrivateKey());
    const other = seedPrepare({ jobId: "existing-served", operator: account.address }); const pending = await prepare(other);
    expect((await servePrepareSignature(other.scopeId, await account.sign({ hash: pending.typedDataDigest as Hex }))).status).toBe(200);
    const served = fundingPrepareRow(other.scopeId)!;
    expect(await prepareBuyerFunding(other.scopeId, prepareReads().deps)).toEqual({ kind: "answer", row: served });
  });
  it("TX2: two chain-read races return one atomic winner", async () => {
    const j = seedPrepare(); const a = prepareReads(), b = prepareReads(); const deferred = barrier([a, b]); const before = counts();
    const requests = [prepareBuyerFunding(j.scopeId, a.deps), prepareBuyerFunding(j.scopeId, b.deps)];
    await deferred.ready; deferred.resolve(); const results = await Promise.all(requests);
    expect(results.map(r => r.kind === "answer" && r.row.id)).toEqual([fundingPrepareRow(j.scopeId)!.id, fundingPrepareRow(j.scopeId)!.id]);
    expect(counts()).toEqual(before.map(n => n + 1));
  });
  for (const kind of ["status", "stop", "selection", "marker", "expiry"]) it(`TX3: transaction rechecks ${kind} after reads`, async () => {
    const j = seedPrepare(); const r = prepareReads();
    const deferred = barrier([r], () => {
      if (kind === "status") updateScope(j.scopeId, { status: "revoked" });
      if (kind === "stop") setPolicy(KERNEL, { ...basePolicy(), emergencyStop: true });
      if (kind === "selection") setPolicy(KERNEL, {});
      if (kind === "marker") markerInsert(j);
      if (kind === "expiry") updateScope(j.scopeId, { expiresAt: new Date(Number(C) * 1000).toISOString() });
    });
    const request = prepareBuyerFunding(j.scopeId, r.deps); await deferred.ready; deferred.resolve(); const before = counts();
    expect(await request).toEqual({ kind: "refused", code: kind === "status" ? "scope_not_awaiting_funding" : kind === "stop" ? "kernel_emergency_stopped" : kind === "expiry" ? "scope_expired" : "buyer_funding_not_selected" });
    expect(counts()).toEqual(before);
  });
  it("TX4: a milestone abort rolls back all three inserts", async () => {
    const j = seedPrepare(); const before = counts();
    db().run(sql.raw("CREATE TEMP TRIGGER prepare_test_abort BEFORE INSERT ON escrow_milestones BEGIN SELECT RAISE(ABORT, 'test'); END"));
    try { await expect(prepareBuyerFunding(j.scopeId, prepareReads().deps)).rejects.toThrow("test"); expect(counts()).toEqual(before); }
    finally { db().run(sql.raw("DROP TRIGGER prepare_test_abort")); }
  });
  it("TX5: frozen row and marker preserve all quote, compiler and lookup fields", async () => {
    const j = seedPrepare(); const row = await prepare(j); const compiled = recompile(); const r = prepareReads().record;
    expect(row).toEqual({ id: row.id, scopeId: j.scopeId, jobId: j.jobId, jobIdHash: compiled.identity.jobIdHash,
      chainId: 84532, escrow: payload.escrow, s01RecordSha256: inputs.recordSha256, s01ScheduleId: r.scheduleId, s01ScheduleTestnetOnly: 1,
      factory: r.factory, implementation: r.implementation, usdc: r.usdc, payer: inputs.payer, operator: inputs.operator,
      termsHash: payload.typedData.message.termsHash, policyNonce: "0", prePolicyRoot: compiled.prePolicyRoot, acceptedPolicyDigest: compiled.identity.acceptedPolicyDigest,
      totalGross: "1000000", quoteSnapshot: JSON.stringify(sessionRow(j.sessionId).quote), configs: wire(payload.fund.configs), unitIds: wire(compiled.unitIds),
      expiry: Number(C + 1200n), scopeExpiresAt: j.expiresAt, finalityFS: 1800, marginMS: 300, reclaimAtEarliest: Number(C + 7200n), reclaimAtLatest: Number(C + 7200n),
      reconcileUntil: Number(C + 4500n), typedDataDigest: compiled.digest, operatorSignature: null, signatureVerifiedAt: null, signedAt: null,
      servedPayload: null, servedPayloadSha256: null, state: "pending_signature", createdAt: new Date(Number(C) * 1000).toISOString(), signatureRequestedAt: null, endedAt: null, supersededBy: null });
    for (const value of Object.values(row)) if (typeof value === "string" && /^0x/.test(value)) expect(value).toBe(value.toLowerCase());
    const escrow = marker(j); expect(escrow).toMatchObject({ version: BUYER_FUNDED_ESCROW_VERSION, status: "created", contractAddress: getAddress(payload.escrow),
      cwmId: j.cwmId, payer: inputs.payer, totalAmount: "1.00", currency: "USDC", createdAt: row.createdAt, deadline: new Date(Number(C) * 1000 + 24 * 60 * 60_000).toISOString() });
    expect(getRepos().escrows.findMilestonesByEscrow(escrow.id)).toEqual([expect.objectContaining({ escrowId: escrow.id, stepId: inputs.stepIdSource, amount: "1.00", status: "pending", bondAmount: "0.00" })]);
    expect(escrowForJob(j.jobId)).toEqual(escrow);
    for (const address of [payload.escrow, getAddress(payload.escrow)]) expect(findEscrowRowByAddress(address)).toEqual(escrow);
    expect(sessionRow(j.sessionId).escrowAddress).toBeNull();
    const lookup = Fastify({ logger: false });
    actAsJobParty(lookup); await lookup.register(escrowRoutes); await lookup.ready();
    try { for (const address of [payload.escrow, getAddress(payload.escrow)]) {
      const response = await lookup.inject({ method: "POST", url: `/api/escrow/chain/${address}/fund`, headers: { "x-admin-key": ADMIN } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "escrow_buyer_funded", message: "Buyer-funded escrows do not use gateway-key settlement writes." });
    } } finally { await lookup.close(); }
  });
});

describe("servePrepareSignature", () => {
  beforeEach(() => vi.setSystemTime(Number(C) * 1000));
  it("SIG1: operatorPrepareView serves the host wire order and stamps once", async () => {
    expect(operatorPrepareView("missing")).toEqual({ status: 404, body: { error: "no_prepare", message: "The scope has no funding prepare." } });
    const j = seedPrepare(); const row = await prepare(j); const view = operatorPrepareView(j.scopeId);
    expect(view).toEqual({ status: 200, body: prepareSigningInput(row) });
    const p = (view.body as any).policy;
    expect(Object.keys(p)).toEqual(["chainId", "factory", "implementation", "escrow", "payer", "operator", "jobIdHash", "termsHash", "policyNonce", "prePolicyRoot", "unitsRoot", "expiry", "acceptedPolicyDigest"]);
    expect([p.chainId, p.policyNonce, p.expiry]).toEqual(["84532", "0", String(row.expiry)]);
    expect(p.escrow).toBe(getAddress(row.escrow));
    for (const [key, value] of Object.entries(p)) if (key !== "escrow" && typeof value === "string" && value.startsWith("0x")) expect(value).toBe(value.toLowerCase());
    expect((view.body as any).units).toEqual(JSON.parse(row.configs)); expect((view.body as any).bindings).toEqual([]);
    const first = fundingPrepareRow(j.scopeId)!.signatureRequestedAt; vi.setSystemTime(Number(C) * 1000 + 1000);
    expect(operatorPrepareView(j.scopeId).status).toBe(200); expect(fundingPrepareRow(j.scopeId)!.signatureRequestedAt).toBe(first);
    await servePrepareSignature(j.scopeId, payload.fund.acceptance.operatorSignature);
    expect(operatorPrepareView(j.scopeId)).toEqual({ status: 409, body: { error: "already_signed", message: "The prepare has already been signed." } });
    const other = seedPrepare({ jobId: "expired-view" }); const pending = await prepare(other);
    vi.setSystemTime((pending.expiry - 600) * 1000 + 1);
    expect(operatorPrepareView(other.scopeId)).toEqual({ status: 410, body: { error: "prepare_expired", message: "The funding prepare has expired." } });
  });
  it("SIG2: a valid signature freezes the exact served bytes and timestamps", async () => {
    const j = seedPrepare(); await prepare(j);
    const answer = await servePrepareSignature(j.scopeId, payload.fund.acceptance.operatorSignature); const row = fundingPrepareRow(j.scopeId)!;
    expect(answer).toEqual({ status: 200, body: row.servedPayload, contentType: "application/json; charset=utf-8" });
    expect(prepareRowAnswer(row, Number(C) * 1000)).toEqual(answer);
    expect(row).toMatchObject({ state: "served", operatorSignature: payload.fund.acceptance.operatorSignature.toLowerCase(), signatureVerifiedAt: new Date().toISOString(), signedAt: new Date().toISOString(),
      servedPayloadSha256: createHash("sha256").update(row.servedPayload!).digest("hex") });
  });
  it("SIG8: servePrepareSignature lowercases the first posted signature and served bytes", async () => {
    const j = seedPrepare(); await prepare(j);
    const sig = payload.fund.acceptance.operatorSignature;
    const answer = await servePrepareSignature(j.scopeId, "0x" + sig.slice(2).toUpperCase());
    const row = fundingPrepareRow(j.scopeId)!;
    expect(answer.status).toBe(200); expect(answer.body).toEqual(row.servedPayload);
    expect(answer.body).toEqual(Buffer.from(JSON.stringify(payload), "utf8"));
    expect(row.operatorSignature).toBe(sig.toLowerCase());
    expect(JSON.parse(row.servedPayload!.toString("utf8")).fund.acceptance.operatorSignature).toBe(sig.toLowerCase());
  });
  it("SIG3: repeat signatures compare case-free and preserve the served row", async () => {
    const j = seedPrepare(); const row = await signed(j);
    const upper = `0x${payload.fund.acceptance.operatorSignature.slice(2).toUpperCase()}`;
    expect(await servePrepareSignature(j.scopeId, upper)).toEqual(prepareRowAnswer(row, Date.now()));
    expect(fundingPrepareRow(j.scopeId)).toEqual(row);
    const other = await privateKeyToAccount(generatePrivateKey()).sign({ hash: row.typedDataDigest as Hex });
    expect(await servePrepareSignature(j.scopeId, other)).toEqual({ status: 409, body: { error: "already_signed", message: "The prepare has already been signed." } });
  });
  const good = payload.fund.acceptance.operatorSignature;
  for (const [label, signature] of [["64 bytes", `0x${"11".repeat(64)}`], ["66 bytes", `0x${"11".repeat(66)}`], ["nonhex", `0x${"zz".repeat(65)}`],
    ...[0, 1, 29].map(v => [`v=${v}`, good.slice(0, -2) + v.toString(16).padStart(2, "0")]),
    ["high s", good.slice(0, 66) + (0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n + 1n).toString(16).padStart(64, "0") + "1b"]]) {
    it(`SIG4: eoa signature rejects ${label}`, async () => {
      const j = seedPrepare(); await prepare(j); const row = fundingPrepareRow(j.scopeId);
      expect(await servePrepareSignature(j.scopeId, signature)).toEqual({ status: 400, body: { error: "signature_malformed", message: "The signature must be a canonical EOA signature." } });
      expect(fundingPrepareRow(j.scopeId)).toEqual(row);
    });
  }
  it("SIG5: another signer cannot serve the policy", async () => {
    const j = seedPrepare(); const row = await prepare(j); const signature = await privateKeyToAccount(generatePrivateKey()).sign({ hash: row.typedDataDigest as Hex });
    expect(await servePrepareSignature(j.scopeId, signature)).toEqual({ status: 400, body: { error: "signature_not_operator", message: "The signature is not from the operator." } });
    expect(fundingPrepareRow(j.scopeId)).toEqual(row);
  });
  for (const kind of ["revoked", "stopped", "funded", "expired", "window", "version"]) it(`SIG6: signing rechecks ${kind}`, async () => {
    const j = seedPrepare(); const row = await prepare(j);
    if (kind === "revoked") updateScope(j.scopeId, { status: "revoked" });
    if (kind === "stopped") setPolicy(KERNEL, { ...basePolicy(), emergencyStop: true });
    if (kind === "funded") setEscrow(marker(j).id, { status: "funded" });
    if (kind === "version") db().update(schema.escrows).set({ version: "v2" }).where(eq(schema.escrows.id, marker(j).id)).run();
    if (kind === "expired") vi.setSystemTime((row.expiry - 600) * 1000 + 1);
    if (kind === "window") updateScope(j.scopeId, { expiresAt: new Date().toISOString() });
    const answer = await servePrepareSignature(j.scopeId, good);
    const code = kind === "revoked" ? "scope_not_awaiting_funding" : kind === "stopped" ? "kernel_emergency_stopped" : (kind === "funded" || kind === "version") ? "escrow_not_created" : kind === "window" ? "scope_expired" : "prepare_expired";
    expect(answer).toEqual({ status: kind === "expired" ? 410 : 409, body: kind === "stopped" ? { error: code } : { error: code, message: kind === "revoked" ? "The scope is not awaiting funding." : (kind === "funded" || kind === "version") ? "The marker escrow is not created." : kind === "window" ? "The execution scope has expired." : "The funding prepare has expired." } });
    expect(fundingPrepareRow(j.scopeId)!.state).toBe(kind === "expired" ? "expired" : "pending_signature");
    if (kind === "expired") expect(fundingPrepareRow(j.scopeId)!.endedAt).toBe(new Date().toISOString());
    if (kind === "version") expect(fundingPrepareRow(j.scopeId)).toMatchObject({ operatorSignature: null, servedPayload: null, signatureVerifiedAt: null });
  });
  it("SIG7: prepareRowAnswer includes the exact serving margin edge", async () => {
    const j = seedPrepare(); const row = await prepare(j); const edge = (row.expiry - 600) * 1000;
    expect(prepareRowAnswer(row, edge)).toEqual({ status: 202, body: pendingBody });
    expect(prepareRowAnswer(row, edge + 1)).toEqual({ status: 410, body: { error: "prepare_expired", message: "The funding prepare has expired." } });
  });
});

describe("servedPrepareTtlMs", () => {
  beforeEach(() => vi.setSystemTime(Number(C) * 1000));
  it("TTL1: absent, pending and expired prepares supply no TTL", async () => {
    const j = seedPrepare(); expect(preparedActivationTtlMs(scopeRow(j.scopeId))).toBeNull();
    const row = await prepare(j); expect(preparedActivationTtlMs(scopeRow(j.scopeId))).toBeNull();
    prepareRowAnswer(row, (row.expiry - 600) * 1000 + 1); expect(preparedActivationTtlMs(scopeRow(j.scopeId))).toBeNull();
  });
  it("TTL2: preparedActivationTtlMs reads the served golden TTL", async () => {
    const j = seedPrepare(); await signed(j); expect(preparedActivationTtlMs(scopeRow(j.scopeId))).toBe(900000);
  });
  it("TTL3: closed store answers null", () => { closeStore(); expect(servedPrepareTtlMs("missing")).toBeNull(); });
  it("TTL4: a directly inserted served row with zero TTL answers null", async () => {
    const j = seedPrepare(); const row = await signed(j);
    const other = seedPrepare({ jobId: "zero-ttl", scopeExp: BigInt(row.reconcileUntil) });
    db().insert(schema.fundingPrepares).values({ ...row, id: "zero-ttl-prepare", scopeId: other.scopeId, jobId: other.jobId,
      escrow: BUYER, scopeExpiresAt: other.expiresAt }).run();
    expect(servedPrepareTtlMs(other.scopeId)).toBeNull();
  });
});
for (const key of ["PCC_VNEXT_RECORD_NETWORK", "PCC_VNEXT_RPC_URL"]) it(`INERT1: missing ${key} builds no chain client`, async () => {
  vi.setSystemTime(Number(C) * 1000); const j = seedPrepare(); const r = prepareReads(); const before = counts();
  vi.stubEnv(key, undefined);
  expect(await prepareBuyerFunding(j.scopeId, r.deps)).toEqual({ kind: "refused", code: "buyer_funding_unavailable" });
  expect(r.calls).toEqual([]); expect(transportRequests).toEqual([]); expect(counts()).toEqual(before);
});
it("MC1a: __setBuyerFundingTestUnitForTest refuses non-test processes", () => {
  const entry = { ...buyerFundingUnitEntry(DRY_RUN_UNIT_ID)!, id: "probe-test-unit" }; selectUnit(entry.id);
  vi.stubEnv("NODE_ENV", "production"); expect(() => __setBuyerFundingTestUnitForTest(entry)).toThrow("buyer-funding test unit: test processes only");
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VITEST", ""); expect(() => __setBuyerFundingTestUnitForTest(entry)).toThrow("buyer-funding test unit: test processes only");
  vi.stubEnv("VITEST", "true"); expect(buyerFundingSelection(KERNEL, "prepare")).toBeNull();
  __setBuyerFundingTestUnitForTest(entry); expect(buyerFundingSelection(KERNEL, "prepare")).toBe(entry.id);
  expect(() => __setBuyerFundingTestUnitForTest({ ...entry, id: DRY_RUN_UNIT_ID })).toThrow();
});
it("MC7a: frozen prepare lifecycle keeps sweep identities and ISO sort order", async () => {
  vi.setSystemTime(Number(C) * 1000); const j = seedPrepare(); await signed(j);
  vi.setSystemTime(Number(C) * 1000 + 1000); const other = seedPrepare({ jobId: "expired-sort" }); const row = await prepare(other, { ...prepareReads(), deps: { ...prepareReads().deps, now: () => new Date() } });
  prepareRowAnswer(row, (row.expiry - 600) * 1000 + 1);
  const rows = db().select().from(schema.fundingPrepares).all();
  for (const r of rows) { expect(r.scopeId).toBeTruthy(); expect(r.jobId).toBeTruthy(); expect(r.createdAt).toBe(new Date(Date.parse(r.createdAt)).toISOString()); expect(["pending_signature", "served", "expired"]).toContain(r.state); }
  expect([...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(r => r.id)).toEqual([...rows].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(r => r.id));
});
it("MC9a: prepare and escrow timestamps use the first deps.now read", async () => {
  vi.setSystemTime(Number(C) * 1000 + 1000); const j = seedPrepare(); const r = prepareReads(); const now = vi.fn(() => new Date(Number(C) * 1000 + 500)).mockImplementationOnce(() => new Date(Number(C) * 1000));
  const answer = await prepareBuyerFunding(j.scopeId, { ...r.deps, now }); expect(answer.kind).toBe("answer");
  expect(now).toHaveBeenCalledTimes(2); expect(fundingPrepareRow(j.scopeId)!.createdAt).toBe(new Date(Number(C) * 1000).toISOString());
  expect(marker(j).createdAt).toBe(new Date(Number(C) * 1000).toISOString());
});
it("MC5c: fundingPrepares has one bounded production writer", () => {
  const root = fileURLToPath(new URL("../../../..", import.meta.url)); const files: string[] = [];
  function walk(dir: string) { for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "__tests__"].includes(e.name)) continue; const path = join(dir, e.name);
    if (e.isDirectory()) walk(path); else if (!/\.test\./.test(e.name)) files.push(path);
  } }
  for (const group of ["packages", "apps"]) for (const e of readdirSync(join(root, group), { withFileTypes: true })) if (e.isDirectory()) {
    try { walk(join(root, group, e.name, "src")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const names = files.filter(p => /\bfundingPrepares\b|\bfunding_prepares\b/.test(readFileSync(p, "utf8")));
  expect(names.map(p => relative(root, p)).sort()).toEqual([
    "packages/db/src/migrate.ts", "packages/db/src/migrations/0007_buyer_funding.sql", "packages/db/src/schema/buyer-funding.ts",
    "packages/gateway/src/readmodels/funding-status.ts", "packages/gateway/src/readmodels/recorded-deployment.ts",
    "packages/gateway/src/services/buyer-funding-sweep.ts", "packages/gateway/src/services/buyer-funding-verifier.ts",
    "packages/gateway/src/services/paid-scope-activation-terms.ts", "packages/gateway/src/services/buyer-funding-prepare.ts",
    "packages/gateway/src/services/funding-prepare-ttl.ts",
  ].sort());
  const writers = names.filter(p => /(?:insert|update)\(\s*(?:schema\.)?fundingPrepares\b|(?:INSERT\s+INTO|UPDATE)\s+funding_prepares\b/i.test(readFileSync(p, "utf8")));
  expect(writers.map(p => relative(root, p))).toEqual(["packages/gateway/src/services/buyer-funding-prepare.ts"]);
});
