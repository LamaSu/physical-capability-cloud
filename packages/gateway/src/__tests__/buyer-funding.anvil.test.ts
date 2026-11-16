/** Opt-in only: the lane runs these real-contract cells on Spark. No production keys are used. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, schema } from "@pcc/store";
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash,
  type Address, type Chain, type Hex, type PrivateKeyAccount, type PublicClient, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildUnitConfig, compileVNextPolicy, jobIdHashOf, VNextSettlementEscrowFactoryABI, type CompiledVNextPolicy } from "@pcc/contracts/vnext";
import { FUNDING_PREPARE_SCHEMA, prepareFunding, approveAndFund, ensureEscrow } from "@pcc/spec/funding";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { BUYER_FUNDED_ESCROW_VERSION } from "../services/buyer-funded-escrow.js";
import { __setFundingRecordStoreForTest } from "../services/funding-record-port.js";
import { SqliteFundingRecordStore } from "../services/sqlite-funding-record-store.js";
import { __setPaidScopeActivationTermsForTest, VNEXT_SCHEDULE_TUPLES, type VNextDeploymentRecord } from "../services/paid-scope-activation-terms.js";
import { createVNextChainReads, type VNextChainReads } from "../services/vnext-rpc-client.js";
import { runBuyerFundingSweepOnce } from "../services/buyer-funding-sweep.js";
import { __setBuyerFundingTestUnitForTest, buyerFundingUnitEntry, DRY_RUN_UNIT_ID, prepareBuyerFunding, servePrepareSignature, fundingPrepareRow } from "../services/buyer-funding-prepare.js";
import { __setVNextTransportForTest } from "../services/vnext-rpc-client.js";
import { servedPrepareTtlMs } from "../services/funding-prepare-ttl.js";
import { scopeExpiryMs } from "../services/scope-expiry.js";

const RUN = process.env.VNEXT_ANVIL_E2E === "1";
const ROOT = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const FIXTURE = join(ROOT, "test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol") + ":PreflightAnvilFixture";
const ANVIL_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DAY = 86400n;
function bin(name: string) {
  const path = join(process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin"), name);
  return existsSync(path) ? path : name;
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port")));
    });
  });
}
const TOKEN_ABI = parseAbi(["function mint(address,uint256)", "function transfer(address,uint256) returns (bool)"]);
const wire = (value: unknown): any => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
type Deployment = { FACTORY: Address; IMPL: Address; TOKEN: Address };
type Job = { label: string; jobId: string; compiled: CompiledVNextPolicy; payer: PrivateKeyAccount; actual: Deployment; createdAt: string; operatorSignature: Hex };

describe.skipIf(!RUN)("buyer funding verifier against real anvil contracts", () => {
  let anvil: ChildProcess | undefined, rpc = "";
  let chain: Chain, pub: PublicClient, testClient: ReturnType<typeof createTestClient>;
  let deployed: Deployment, buyer: PrivateKeyAccount, operator: PrivateKeyAccount, other: PrivateKeyAccount;
  let lag = 0n;
  const db = () => getStore().db;
  const records = () => db().select().from(schema.escrowFunding).all();
  const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpc) });
  const send = async (account: PrivateKeyAccount, request: unknown): Promise<TransactionReceipt> => {
    const hash = await wallet(account).writeContract(request as never);
    const receipt = await pub.waitForTransactionReceipt({ hash }); expect(receipt.status).toBe("success"); return receipt;
  };
  function deploy(): Deployment {
    const output = execFileSync(bin("forge"), ["script", FIXTURE, "--root", ROOT, "--offline", "--rpc-url", rpc, "--broadcast", "--slow", "--unlocked", "--sender", ANVIL_SENDER],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 300000 });
    const grab = (name: string): Address => {
      const match = output.match(new RegExp(`${name} (0x[0-9a-fA-F]{40})`));
      if (!match?.[1]) throw new Error(`missing fixture address ${name}`); return match[1] as Address;
    };
    return { FACTORY: grab("FACTORY"), IMPL: grab("IMPL"), TOKEN: grab("TOKEN") };
  }
  beforeAll(async () => {
    const port = await freePort(); rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(bin("anvil"), ["--port", String(port), "--silent"], { stdio: "ignore" });
    let spawnError: Error | undefined; anvil.on("error", error => { spawnError = error; });
    chain = { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
    pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 100 });
    testClient = createTestClient({ mode: "anvil", chain, transport: http(rpc) });
    for (let attempt = 0; ; attempt++) {
      if (spawnError) throw spawnError;
      try { await pub.getChainId(); break; }
      catch { if (attempt >= 80) throw new Error("anvil did not start"); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    deployed = deploy();
    [buyer, operator, other] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())) as [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
    for (const account of [buyer, operator, other]) await testClient.setBalance({ address: account.address, value: 10n ** 20n });
  }, 600000);
  afterAll(() => { anvil?.kill(); });
  beforeEach(() => {
    vi.stubEnv("PCC_DB_PATH", ":memory:"); vi.stubEnv("DATABASE_URL", ":memory:"); initStore({ seed: true });
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", `${buyer.address},${other.address}`);
    __setFundingRecordStoreForTest(new SqliteFundingRecordStore());
    __setPaidScopeActivationTermsForTest(() => ({ expectedChainId: 31337, postActivationTtlMs: 3600000, testnetOnly: false }));
  });
  afterEach(() => { __setFundingRecordStoreForTest(null); __setPaidScopeActivationTermsForTest(null); closeStore(); vi.unstubAllEnvs(); });
  function record(d = deployed): VNextDeploymentRecord {
    return { ...VNEXT_SCHEDULE_TUPLES[1]!, chainId: 31337, factory: d.FACTORY.toLowerCase() as Address,
      implementation: d.IMPL.toLowerCase() as Address, usdc: d.TOKEN.toLowerCase() as Address, recordSha256: "ab".repeat(32) };
  }
  async function make(label: string, actual = deployed, payer = buyer): Promise<Job> {
    expect(lag).toBeGreaterThanOrEqual(1n);
    const now = (await pub.getBlock()).timestamp, jobId = `anvil-buyer:${label}`;
    const compiled = compileVNextPolicy({ chainId: 31337n, factory: actual.FACTORY, implementation: actual.IMPL, token: actual.TOKEN,
      payer: payer.address, operator: operator.address, jobIdHash: jobIdHashOf(jobId), termsHash: keccak256(stringToHex(`${jobId}:terms`)), policyNonce: 1n,
      acceptedPolicyDigest: keccak256(stringToHex(`${jobId}:accepted`)), expiry: now + DAY, fundingTime: now,
      units: [0, 1].map(i => buildUnitConfig({ milestoneIndex: BigInt(i), stepId: keccak256(stringToHex(`${jobId}:step:${i}`)), requiredTier: i,
        g: 2000000n, feeBps: 0, feeRecipient: zeroAddress, reclaimAt: now + BigInt(30 + i) * DAY,
        compositionSchemaVersion: 0, compositionRoot: zeroHash, payouts: [{ recipient: operator.address, amount: 2000000n }] })),
    });
    const operatorSignature = await operator.sign({ hash: compiled.digest });
    // The buyer's SDK creates the clone; the gateway holds no transaction-sending key here.
    await send(payer, { address: actual.FACTORY, abi: VNextSettlementEscrowFactoryABI, functionName: "createEscrow", args: [compiled.identity] });
    // Make the created, unsealed clone visible at finalized before funding it.
    await testClient.mine({ blocks: Number(lag + 1n), interval: 1 });
    return { label, jobId, compiled, payer, actual, operatorSignature, createdAt: new Date(Number(now) * 1000).toISOString() };
  }
  async function fund(job: Job): Promise<TransactionReceipt> {
    const c = job.compiled;
    await send(job.payer, { address: job.actual.TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [job.payer.address, c.totalGross] });
    const payload = wire({ schema: FUNDING_PREPARE_SCHEMA, chainId: c.chainId, factory: c.factory, escrow: c.escrow, usdc: c.token, totalGross: c.totalGross,
      expiry: c.expiry, typedData: c.typedData, approve: { token: c.token, spender: c.escrow, amount: c.totalGross },
      fund: { configs: c.configs, acceptance: { expiry: c.expiry, payerSignature: "0x", operatorSignature: job.operatorSignature } } });
    const prepared = await prepareFunding({ payload, wallet: wallet(job.payer), publicClient: pub, quote: { maxTotalGross: c.totalGross },
      pins: { "31337": { factory: job.actual.FACTORY, usdc: job.actual.TOKEN } }, expect: { jobId: job.jobId, operator: operator.address, payees: [operator.address],
        maxFeeBps: 0, feeRecipients: [], tiers: [0, 1], latestReclaimAt: c.configs[1]!.reclaimAt, termsHash: c.identity.termsHash,
        acceptedPolicyDigest: c.identity.acceptedPolicyDigest, compositionRoots: [zeroHash] } });
    const result = await approveAndFund({ prepared, wallet: wallet(job.payer), publicClient: pub });
    expect(result.outcome).toBe("committed"); expect(result.fundTx).toBeDefined();
    return pub.getTransactionReceipt({ hash: result.fundTx! });
  }
  function rows(job: Job, opts: { record?: VNextDeploymentRecord; buyer?: Address; escrow?: Address; configs?: unknown } = {}) {
    const c = job.compiled, r = opts.record ?? record(), scopeId = `scope:${job.label}`, escrowId = `escrow:${job.label}`;
    const scopeBuyer = (opts.buyer ?? job.payer.address).toLowerCase(), escrow = (opts.escrow ?? c.escrow).toLowerCase();
    const expiresAt = new Date(Date.parse(job.createdAt) + 3600000).toISOString();
    db().insert(schema.executionScopes).values({ id: scopeId, kernelId: "kernel-nyc", jobId: job.jobId, createdBy: scopeBuyer, status: "awaiting_funding",
      allowedTools: ["ot2_run_protocol"], createdAt: job.createdAt, expiresAt }).run();
    db().insert(schema.negotiationSessions).values({ id: `session:${job.label}`, kernelId: "kernel-nyc", userAgentId: scopeBuyer, capabilityType: "liquid-handler",
      operatorConstraints: {}, jobId: job.jobId, cwmId: `cwm:${job.label}`, createdAt: job.createdAt, expiresAt }).run();
    db().insert(schema.escrows).values({ id: escrowId, cwmId: `cwm:${job.label}`, contractAddress: escrow, payer: scopeBuyer, totalAmount: "4", currency: "USDC",
      status: "created", version: BUYER_FUNDED_ESCROW_VERSION, createdAt: job.createdAt, deadline: expiresAt }).run();
    for (const [i, config] of c.configs.entries()) db().insert(schema.escrowMilestones).values({ id: `ms:${job.label}:${i}`, escrowId, stepId: config.stepId, amount: "2", status: "pending", bondAmount: "0" }).run();
    db().insert(schema.fundingPrepares).values({ id: `prepare:${job.label}`, scopeId, jobId: job.jobId, jobIdHash: c.identity.jobIdHash,
      chainId: 31337, escrow, s01RecordSha256: r.recordSha256, s01ScheduleId: r.scheduleId, s01ScheduleTestnetOnly: Number(r.scheduleTestnetOnly),
      factory: r.factory, implementation: r.implementation, usdc: r.usdc, payer: job.payer.address.toLowerCase(), operator: operator.address.toLowerCase(),
      termsHash: c.identity.termsHash, policyNonce: c.identity.policyNonce.toString(), prePolicyRoot: c.prePolicyRoot, acceptedPolicyDigest: c.identity.acceptedPolicyDigest,
      totalGross: c.totalGross.toString(), quoteSnapshot: "{}", configs: JSON.stringify(wire(opts.configs ?? c.configs)), unitIds: JSON.stringify(c.unitIds),
      expiry: Number(c.expiry), scopeExpiresAt: expiresAt, finalityFS: Number(lag + 120n), marginMS: 300,
      reclaimAtEarliest: Number(c.configs[0]!.reclaimAt - 300n), reclaimAtLatest: Number(c.configs[1]!.reclaimAt + 300n), reconcileUntil: Math.floor(Date.parse(expiresAt) / 1000),
      typedDataDigest: c.digest, operatorSignature: job.operatorSignature.toLowerCase(), signatureVerifiedAt: job.createdAt, signedAt: job.createdAt,
      servedPayload: Buffer.from(JSON.stringify(wire(c.typedData))), servedPayloadSha256: "cd".repeat(32), state: "served", createdAt: job.createdAt }).run();
    return { scopeId, escrowId, record: r };
  }
  const finalized = () => testClient.mine({ blocks: Number(lag + 2n), interval: 1 });
  const sweep = (r: VNextDeploymentRecord = record(), over: { reads?: VNextChainReads; gatewaySigner?: () => Address | null } = {}) =>
    runBuyerFundingSweepOnce({ record: r, reads: createVNextChainReads(rpc), gatewaySigner: () => null, ...over });
  function unchanged(row: ReturnType<typeof rows>) {
    expect(records()).toEqual([]); expect(getRepos().escrows.findById(row.escrowId)!.status).toBe("created");
    expect(getRepos().escrows.findMilestonesByEscrow(row.escrowId).every(m => m.status === "pending")).toBe(true);
    expect(db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, row.scopeId)).get()!.status).toBe("awaiting_funding");
  }
  async function refused(row: ReturnType<typeof rows>, code: string, over: Parameters<typeof sweep>[1] = {}) {
    expect(await sweep(row.record, over)).toEqual({ passA: {}, passB: { [code]: 1 } }); unchanged(row);
  }

  it("A0: records the anvil version and measured latest minus finalized lag", async () => {
    console.log("buyer-funding anvil version", execFileSync(bin("anvil"), ["--version"], { encoding: "utf8" }).trim());
    // Two-second blocks also put created_at minus 120 seconds after genesis for the later search.
    await testClient.mine({ blocks: 100, interval: 2 });
    const latest = await pub.getBlock({ blockTag: "latest" }), block = await pub.getBlock({ blockTag: "finalized" });
    lag = latest.number! - block.number!; console.log("buyer-funding finalized lag", lag.toString()); expect(lag).toBeGreaterThanOrEqual(1n);
  });
  it("A1: only finalized funding records and activates, then a third run writes nothing", async () => {
    const job = await make("A1"), row = rows(job), receipt = await fund(job);
    const before = await pub.getBlock({ blockTag: "finalized" }); expect(before.number!).toBeLessThan(receipt.blockNumber);
    await refused(row, "not_funded_at_finalized");
    await finalized(); expect(await sweep()).toEqual({ passA: {}, passB: { recorded: 1 } });
    const kept = records(); expect(kept).toHaveLength(1); expect(kept[0]!.fundingBlockNumber).toBe(receipt.blockNumber.toString()); expect(kept[0]!.fundingBlockHash).toBe(receipt.blockHash);
    expect(kept[0]!.fundedAt).toBe(Number((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp));
    expect(getRepos().escrows.findById(row.escrowId)!.status).toBe("funded"); expect(getRepos().escrows.findMilestonesByEscrow(row.escrowId).every(m => m.status === "funded")).toBe(true);
    const active = db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, row.scopeId)).get()!; expect(active.status).toBe("active");
    expect(await sweep()).toEqual({ passA: {}, passB: {} }); expect(records()).toEqual(kept);
    expect(db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, row.scopeId)).get()).toEqual(active);
  }, 120000);
  it("A2: token transfer to a created clone is not funding", async () => {
    const job = await make("A2"), row = rows(job);
    await send(buyer, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [buyer.address, job.compiled.totalGross] });
    await send(buyer, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "transfer", args: [job.compiled.escrow, job.compiled.totalGross] });
    await finalized(); await refused(row, "not_funded_at_finalized");
  }, 120000);
  it("A3: funding a rival factory clone cannot satisfy the pinned factory", async () => {
    const rival = deploy(), job = await make("A3", rival); await fund(job); await finalized(); await refused(rows(job), "escrow_not_predicted");
  }, 300000);
  it("A4: a reorg after check one refuses before any local commit", async () => {
    const job = await make("A4"), row = rows(job), snapshot = await testClient.snapshot();
    await fund(job); await finalized(); const base = createVNextChainReads(rpc), pin = await base.finalizedBlock(); let reverted = false;
    const reads: VNextChainReads = { ...base, call: async (...args) => {
      if (!reverted && args[2] === "payer") {
        reverted = true; const previous = await pub.getBlock(); await testClient.revert({ id: snapshot });
        await testClient.setNextBlockTimestamp({ timestamp: previous.timestamp + 1000n });
        const head = await pub.getBlockNumber({ cacheTime: 0 }); await testClient.mine({ blocks: Number(pin.number - head + lag + 2n), interval: 1 });
      }
      return base.call(...args);
    } };
    await refused(row, "pinned_block_reorged", { reads }); expect(reverted).toBe(true);
  }, 120000);
  it("A5: prepared and record token pins cannot replace the escrow token", async () => {
    const rival = deploy(), job = await make("A5"); await fund(job); await finalized();
    await refused(rows(job, { record: { ...record(), usdc: rival.TOKEN.toLowerCase() as Address } }), "token_not_pinned");
  }, 300000);
  it("A6: the verified payer must not be the configured gateway signer", async () => {
    const job = await make("A6"); await fund(job); await finalized(); await refused(rows(job), "payer_is_gateway_signer", { gatewaySigner: () => buyer.address });
  }, 120000);
  it("A7: one funded config differs from the signed row with its root kept", async () => {
    const job = await make("A7"); await fund(job); await finalized(); const configs = wire(job.compiled.configs); configs[0].reclaimAt = (BigInt(configs[0].reclaimAt) + 1n).toString();
    await refused(rows(job, { configs }), "unit_configs_unverified");
  }, 120000);
  it("A8: a prepare for one job cannot name another job's funded clone", async () => {
    const first = await make("A8-first"), second = await make("A8-second"); await fund(second); await finalized(); await refused(rows(first, { escrow: second.compiled.escrow }), "escrow_not_predicted");
  }, 120000);
  it("A9: another EOA's funded clone cannot pay for this buyer's scope", async () => {
    const job = await make("A9", deployed, other); await fund(job); await finalized(); await refused(rows(job, { buyer: buyer.address }), "prepare_not_scope");
  }, 120000);

  it("ANV1: prepareBuyerFunding serves an operator signature that the buyer funds and the sweep activates", async () => {
    const c = (await pub.getBlock({ blockTag: "latest" })).timestamp;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Number(c) * 1000);
    try {
      __setBuyerFundingTestUnitForTest({ ...buyerFundingUnitEntry(DRY_RUN_UNIT_ID)!, id: "anvil-test-unit-v1",
        chainId: 31337, scheduleId: "vnext-mainnet-v1", scheduleTestnetOnly: false,
        usdc: deployed.TOKEN.toLowerCase() as Address, reclaimDelaySeconds: 866100n });
      vi.stubEnv("PCC_VNEXT_RPC_URL", rpc);
      const scopeId = "scope:prepared-anvil", jobId = "job:prepared-anvil", cwmId = "cwm:prepared-anvil";
      const createdAt = new Date(Number(c) * 1000).toISOString(), expiresAt = new Date(Number(c + 3600n) * 1000).toISOString();
      db().update(schema.shopKernels).set({ operatorAddress: operator.address }).where(eq(schema.shopKernels.id, "kernel-nyc")).run();
      db().update(schema.operatorPolicies).set({ policy: { version: 1, emergencyStop: false, vnextBuyerFunding: "anvil-test-unit-v1" } as never })
        .where(eq(schema.operatorPolicies.kernelId, "kernel-nyc")).run();
      db().insert(schema.negotiationSessions).values({ id: "session:prepared-anvil", kernelId: "kernel-nyc", userAgentId: buyer.address,
        capabilityType: "liquid-handler", status: "committed", operatorConstraints: {}, selections: {}, transitions: [], jobId, cwmId,
        quote: { totalPrice: "1.00", currency: "USDC" }, contractTerms: {}, createdAt, expiresAt }).run();
      getRepos().jobs.insert({ ...getRepos().jobs.findAll()[0]!, id: jobId, kernelId: "kernel-nyc", cwmId, stepId: "prepared-anvil", assuranceTier: 1 });
      db().insert(schema.executionScopes).values({ id: scopeId, kernelId: "kernel-nyc", jobId, createdBy: buyer.address,
        status: "awaiting_funding", allowedTools: [], createdAt, expiresAt }).run();
      const result = await prepareBuyerFunding(scopeId, { record: record(), reads: createVNextChainReads(rpc), now: () => new Date(Number(c) * 1000) });
      expect(result.kind).toBe("answer"); if (result.kind !== "answer") throw new Error(result.code);
      const signature = await operator.sign({ hash: result.row.typedDataDigest as Hex });
      const served = await servePrepareSignature(scopeId, signature);
      expect(served.status).toBe(200); expect(Buffer.isBuffer(served.body)).toBe(true);
      const text = (served.body as Buffer).toString("utf8"), payload = JSON.parse(text);
      await send(buyer, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "mint", args: [buyer.address, BigInt(payload.totalGross)] });
      const prepared = await prepareFunding({ payload, wallet: wallet(buyer), publicClient: pub,
        quote: { maxTotalGross: BigInt(payload.totalGross) }, pins: { "31337": { factory: deployed.FACTORY, usdc: deployed.TOKEN } },
        expect: { jobId, operator: operator.address, payees: [operator.address], maxFeeBps: 0, feeRecipients: [], tiers: [1],
          latestReclaimAt: c + 866100n, termsHash: result.row.termsHash as Hex, acceptedPolicyDigest: result.row.acceptedPolicyDigest as Hex,
          compositionRoots: [zeroHash] } });
      await ensureEscrow({ prepared, wallet: wallet(buyer), publicClient: pub });
      expect((await approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub })).outcome).toBe("committed");
      await finalized();
      expect(await sweep()).toEqual({ passA: {}, passB: { recorded: 1 } });
      expect(getRepos().escrows.findByCwm(cwmId)!.status).toBe("funded");
      expect(db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, scopeId)).get()!.status).toBe("active");
      const row = fundingPrepareRow(scopeId)!;
      expect(servedPrepareTtlMs(scopeId)).toBe(row.reconcileUntil * 1000 - scopeExpiryMs(row.scopeExpiresAt));
    } finally {
      __setBuyerFundingTestUnitForTest(null); __setVNextTransportForTest(null);
      vi.restoreAllMocks(); vi.useRealTimers();
    }
  }, 120000);
});
