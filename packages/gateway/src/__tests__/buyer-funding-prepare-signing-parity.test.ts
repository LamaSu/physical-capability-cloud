import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { custom, decodeFunctionData, encodeFunctionResult, hashTypedData, toHex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI, policySalt, predictEscrow } from "@pcc/contracts/vnext";
import { DRY_RUN_UNIT_TESTNET_V1 } from "@pcc/spec/funding";
import { loadJobPolicyInput } from "../../../print-host/src/policy-json.js";
import { computeJobPolicyCommitments, prepareJobPolicyAcceptance, validateHostTerms } from "../../../print-host/src/operator-signing.js";
import { buyerFundingRoutes } from "../routes/buyer-funding.js";
import { operatorRoutes } from "../routes/operator.js";
import { __setVNextTransportForTest } from "../services/vnext-rpc-client.js";
import { __setBuyerFundingTestUnitForTest, fundingPrepareRow } from "../services/buyer-funding-prepare.js";
import { configuredVNextDeploymentRecord } from "../services/paid-scope-activation-terms.js";
import { actAsJobParty } from "./helpers/job-read-party.js";
import { setUpFixture, tearDownFixture, asKey, type Fixture } from "./helpers/paid-scope-fixture.js";
import { C, inputs, configure, seedPrepare, pendingBody } from "./helpers/buyer-funding-prepare-fixture.js";
import { hash } from "./helpers/buyer-funding-fixture.js";

let f: Fixture, app: FastifyInstance, directory: string | undefined;
let requests: unknown[];
beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:"); f = await setUpFixture();
  configure(); vi.setSystemTime(Number(C) * 1000);
  const record = configuredVNextDeploymentRecord()!;
  const abi = [...VNextSettlementEscrowABI, ...VNextSettlementEscrowFactoryABI]; requests = [];
  __setVNextTransportForTest(custom({ request: async ({ method, params = [] }: any) => {
    requests.push({ method, params });
    if (method === "eth_chainId") return toHex(84532);
    if (method === "eth_getBlockByNumber" && params[0] === "latest") return { number: toHex(100), hash: hash(100), timestamp: toHex(C), transactions: [] };
    if (method === "eth_getCode") return "0x6000";
    if (method !== "eth_call") throw new Error("unexpected read");
    const decoded = decodeFunctionData({ abi, data: params[0].data });
    const values: Record<string, unknown> = { implementation: record.implementation, USDC: record.usdc, fundedEscrowOf: zeroAddress, policyNonceFloor: 0n };
    const result = decoded.functionName === "predictEscrow"
      ? predictEscrow({ factory: record.factory, implementation: record.implementation, salt: policySalt(decoded.args![0] as never) }) : values[decoded.functionName];
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result: result as never });
  } }, { retryCount: 0 }));
  app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.addHook("onRequest", async req => { if (typeof req.headers["x-test-key"] === "string") req.operatorId = req.headers["x-test-key"]; });
  actAsJobParty(app); await app.register(buyerFundingRoutes); await app.register(operatorRoutes); await app.ready();
});
afterEach(async () => {
  if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined;
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VITEST", "true");
  __setVNextTransportForTest(null); __setBuyerFundingTestUnitForTest(null);
  await app?.close(); await tearDownFixture(f); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
it("PHP1: loadJobPolicyInput and prepareJobPolicyAcceptance accept the operator route input", async () => {
  const operator = privateKeyToAccount(generatePrivateKey());
  const j = seedPrepare({ operator: operator.address });
  const prepared = await app.inject({ method: "POST", url: `/api/buyer-funding/scopes/${j.scopeId}/prepare`, headers: asKey(inputs.payer) });
  expect(prepared.statusCode).toBe(202); expect(prepared.json()).toEqual(pendingBody);
  const row = fundingPrepareRow(j.scopeId)!;
  const response = await app.inject({ url: `/api/operator/scopes/${j.scopeId}/funding-prepare`, headers: asKey(operator.address) });
  expect(response.statusCode).toBe(200);
  directory = mkdtempSync(join(tmpdir(), "prepare-host-")); const path = join(directory, "input.json");
  writeFileSync(path, response.body, { mode: 0o600 });
  const input = await loadJobPolicyInput(path);
  expect(computeJobPolicyCommitments(input).acceptedPolicyDigest).toBe(row.acceptedPolicyDigest);
  const record = configuredVNextDeploymentRecord()!, unit = DRY_RUN_UNIT_TESTNET_V1;
  const terms = validateHostTerms({ chainId: 84532, factory: record.factory, implementation: record.implementation,
    operatorPayoutRecipient: operator.address, settlementToken: record.usdc,
    subjectPins: { committedProgramHash: unit.committedProgramHash, ...unit.zeroSubjectFields, integrityGrade: unit.integrityGrade },
    maxPassThrough: unit.g, minG: unit.g, allowedRequiredTiers: [unit.requiredTier],
    reclaimMinSeconds: Number(record.minReclaimDelaySec), reclaimMaxSeconds: Number(record.maxReclaimDelaySec),
    maxFeeBps: unit.feeBps, allowedFeeRecipients: [unit.feeRecipient], allowedPayoutRecipients: [operator.address],
    maxUnits: 1, maxAcceptanceSeconds: Number(unit.maxAcceptanceSeconds) });
  const typedData = prepareJobPolicyAcceptance(input, 84532, operator.address, terms, () => new Date(Number(C) * 1000));
  expect(hashTypedData(typedData)).toBe(row.typedDataDigest);
  const signature = await operator.signTypedData(typedData);
  const signed = await app.inject({ method: "POST", url: `/api/operator/scopes/${j.scopeId}/funding-prepare/signature`,
    headers: asKey(operator.address), payload: { signature } });
  expect(signed.statusCode, signed.body).toBe(200); expect(fundingPrepareRow(j.scopeId)!.state).toBe("served");
  expect(signed.rawPayload).toEqual(fundingPrepareRow(j.scopeId)!.servedPayload);
  expect(requests.length).toBeGreaterThan(0);
});
