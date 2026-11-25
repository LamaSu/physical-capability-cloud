/** Opt-in local-chain rehearsal of the kept settlement proof. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, schema } from "@pcc/store";
import { hashEvent, type EvidenceEvent } from "@pcc/spec";
import { approveAndFund, ensureEscrow, prepareFunding } from "@pcc/spec/funding";
import { evidenceCommitment, VNextSettlementEscrowABI } from "@pcc/contracts/vnext";
import {
  createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseAbi,
  parseEventLogs, zeroHash, type Address, type Chain, type Hex, type PrivateKeyAccount,
  type PublicClient, type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildMilestonePackage, signMilestonePackage } from "../../../print-host/src/package-builder.js";
import { loadDeviceKey, loadOperatorKey } from "../../../print-host/src/keys.js";
import { openUnitEvidenceSession } from "../../../print-host/src/unit-session.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos, getStore } from "../db.js";
import {
  __setBuyerFundingTestUnitForTest, buyerFundingUnitEntry, DRY_RUN_UNIT_ID,
  fundingPrepareRow, prepareBuyerFunding, servePrepareSignature,
} from "../services/buyer-funding-prepare.js";
import { runBuyerFundingSweepOnce } from "../services/buyer-funding-sweep.js";
import { __setFundingRecordStoreForTest } from "../services/funding-record-port.js";
import {
  __setPaidScopeActivationTermsForTest, VNEXT_SCHEDULE_TUPLES, type VNextDeploymentRecord,
} from "../services/paid-scope-activation-terms.js";
import { SqliteFundingRecordStore } from "../services/sqlite-funding-record-store.js";
import { createVNextChainReads } from "../services/vnext-rpc-client.js";

const RUN = process.env.VNEXT_ANVIL_E2E === "1";
const ROOT = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const FIXTURE = join(ROOT, "test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol") + ":PreflightAnvilFixture";
const ANVIL_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADMIN = "cp4-local-rehearsal-admin";
const KERNEL = "kernel-nyc";
const TOKEN_ABI = parseAbi(["function mint(address,uint256)"]);
const FUNDED_ABI = parseAbi(["event UnitFunded(bytes32 indexed unitId,uint256 g,uint256 f,uint256 n)"]);
const MIRROR_ABI = parseAbi([
  "event O5Mirrored(bytes32 indexed settlementUnitId,bytes32 indexed assertionId,bytes32 indexed easUid,uint64 cohort,address escrow,bytes32 verdictHash,uint256 escrowUnitState)",
]);
const ASSERTION_ABI = parseAbi([
  "function assertionOf(bytes32) view returns ((bytes32 assertionId,bytes32 feeScheduleHash,bytes32 compositionRoot,bytes32 evidenceBundleHash,address escrow,uint64 assertedAt,uint8 achievedTier,uint8 requestedTier,uint8 decision,address feeRecipient,uint64 oracleAuthEpoch,uint16 feeBps))",
]);
const ESCROW_READ_ABI = [...VNextSettlementEscrowABI, ...parseAbi([
  "function feeBpsOf(bytes32) view returns (uint16)",
  "function feeRecipientOf(bytes32) view returns (address)",
  "function requiredTierOf(bytes32) view returns (uint8)",
  "function evidenceBundleHashOf(bytes32) view returns (bytes32)",
])];

function bin(name: string) {
  const path = join(process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin"), name);
  return existsSync(path) ? path : name;
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : address && typeof address === "object"
        ? resolve(address.port) : reject(new Error("no free port")));
    });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${field}: missing or not an object`);
  return value;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field}: missing or not an array`);
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field}: missing or not a string`);
  return value;
}
function json(value: string, field: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error(`${field}: invalid JSON`); }
}
function word(value: unknown, field: string): Hex {
  const s = text(value, field);
  expect(s, `${field}: expected a 0x 32-byte value`).toMatch(/^0x[0-9a-f]{64}$/);
  return s as Hex;
}
function address(value: unknown, field: string): Address {
  const s = text(value, field);
  expect(s, `${field}: expected an address`).toMatch(/^0x[0-9a-fA-F]{40}$/);
  return s as Address;
}
function uint(value: unknown, field: string): bigint {
  const s = text(value, field);
  expect(s, `${field}: expected a lossless unsigned decimal string`).toMatch(/^(0|[1-9][0-9]*)$/);
  return BigInt(s);
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}: missing or not a safe unsigned integer`);
  }
  return value;
}
const sha = (bytes: string | Uint8Array): Hex => `0x${createHash("sha256").update(bytes).digest("hex")}`;

// Independent RFC 8785 serialization: ECMAScript scalar encoding, UTF-16 key
// ordering, no whitespace, and rejection of non-JSON values/lone surrogates.
function jcs(value: unknown): string {
  if (typeof value === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
      throw new Error("JCS: lone surrogate");
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${jcs(key)}:${jcs(value[key])}`).join(",")}}`;
  throw new Error("JCS: non-JSON value");
}

describe.skipIf(!RUN)("CP-4 labelled anvil rehearsal", () => {
  let anvil: ChildProcess | undefined;
  let scratch: string | undefined;
  let app: FastifyInstance;
  let rpc: string, chain: Chain, pub: PublicClient;
  let testClient: ReturnType<typeof createTestClient>;
  let reads: ReturnType<typeof createVNextChainReads>;
  let deployed: { FACTORY: Address; IMPL: Address; TOKEN: Address; ORACLE: Address };
  let buyer: PrivateKeyAccount, operator: PrivateKeyAccount, outsider: PrivateKeyAccount;
  let operatorPrivateKey: Hex, bearer: string, outsiderBearer: string, buyerCookie: string;
  let lag: bigint, snapshot: Awaited<ReturnType<typeof reads.finalizedBlock>>;
  let u: Awaited<ReturnType<typeof fundUnit>>, v: Awaited<ReturnType<typeof fundUnit>>;
  let uPackage: Awaited<ReturnType<typeof buildPackage>>, vPackage: Awaited<ReturnType<typeof buildPackage>>;
  const db = () => getStore().db;
  const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpc) });
  const headers = () => ({ authorization: `Bearer ${bearer}` });
  const jobReceiptUrl = () => `/api/operator/jobs/${u.jobId}/receipt`;
  const settlementUrl = (kind: string) => `/api/settlement/units/${u.unitId}/${kind}?asOf=${snapshot.hash}`;
  const finalized = () => testClient.mine({ blocks: Number(lag + 2n), interval: 1 });

  function record(): VNextDeploymentRecord {
    return { ...VNEXT_SCHEDULE_TUPLES[1]!, chainId: 31337,
      factory: deployed.FACTORY.toLowerCase() as Address,
      implementation: deployed.IMPL.toLowerCase() as Address,
      usdc: deployed.TOKEN.toLowerCase() as Address, recordSha256: "ab".repeat(32) };
  }
  async function send(account: PrivateKeyAccount, request: unknown): Promise<TransactionReceipt> {
    const hash = await wallet(account).writeContract(request as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status, `R3 transaction ${hash} status`).toBe("success");
    return receipt;
  }
  async function fundUnit(label: string) {
    const c = (await pub.getBlock({ blockTag: "latest" })).timestamp;
    vi.setSystemTime(Number(c) * 1000);
    const jobId = `job:cp4:${label}`, scopeId = `scope:cp4:${label}`, cwmId = `cwm:cp4:${label}`;
    const createdAt = new Date(Number(c) * 1000).toISOString();
    const expiresAt = new Date(Number(c + 3600n) * 1000).toISOString();
    db().insert(schema.negotiationSessions).values({ id: `session:cp4:${label}`, kernelId: KERNEL,
      userAgentId: buyer.address, capabilityType: "liquid-handler", status: "committed", operatorConstraints: {},
      selections: {}, transitions: [], jobId, cwmId, quote: { totalPrice: "1.00", currency: "USDC" },
      contractTerms: {}, createdAt, expiresAt }).run();
    getRepos().jobs.insert({ ...getRepos().jobs.findAll()[0]!, id: jobId, kernelId: KERNEL,
      cwmId, stepId: `cp4:${label}`, assuranceTier: 1 });
    db().insert(schema.executionScopes).values({ id: scopeId, kernelId: KERNEL, jobId,
      createdBy: buyer.address, status: "awaiting_funding", allowedTools: [], createdAt, expiresAt }).run();
    const result = await prepareBuyerFunding(scopeId, { record: record(), reads,
      now: () => new Date(Number(c) * 1000) });
    expect(result.kind, `R3 ${label} prepareBuyerFunding.kind`).toBe("answer");
    if (result.kind !== "answer") throw new Error(`R3 ${label} prepareBuyerFunding: ${result.code}`);
    const signature = await operator.sign({ hash: result.row.typedDataDigest as Hex });
    const served = await servePrepareSignature(scopeId, signature);
    expect(served.status, `R3 ${label} servePrepareSignature.status`).toBe(200);
    if (!Buffer.isBuffer(served.body)) throw new Error(`R3 ${label} served payload bytes missing`);
    const servedBytes = Buffer.from(served.body);
    const payload = object(json(servedBytes.toString("utf8"), `R3 ${label} served payload`), `R3 ${label} served payload`);
    await send(buyer, { address: deployed.TOKEN, abi: TOKEN_ABI, functionName: "mint",
      args: [buyer.address, uint(payload.totalGross, `R3 ${label} totalGross`)] });
    const prepared = await prepareFunding({ payload, wallet: wallet(buyer), publicClient: pub,
      quote: { maxTotalGross: uint(payload.totalGross, `R3 ${label} totalGross`) },
      pins: { "31337": { factory: deployed.FACTORY, usdc: deployed.TOKEN } },
      expect: { jobId, operator: operator.address, payees: [operator.address], maxFeeBps: 0,
        feeRecipients: [], tiers: [1], latestReclaimAt: c + 866100n,
        termsHash: result.row.termsHash as Hex, acceptedPolicyDigest: result.row.acceptedPolicyDigest as Hex,
        compositionRoots: [zeroHash] } });
    expect((await ensureEscrow({ prepared, wallet: wallet(buyer), publicClient: pub })).outcome,
      `R3 ${label} ensureEscrow.outcome`).toBe("ready");
    const funding = await approveAndFund({ prepared, wallet: wallet(buyer), publicClient: pub });
    expect(funding.outcome, `R3 ${label} approveAndFund.outcome`).toBe("committed");
    if (!funding.fundTx) throw new Error(`R3 ${label} fundTx missing`);
    const fundReceipt = await pub.getTransactionReceipt({ hash: funding.fundTx });
    expect(fundReceipt.status, `R3 ${label} funding transaction status`).toBe("success");
    await finalized();
    expect(await runBuyerFundingSweepOnce({ record: record(), reads, gatewaySigner: () => null }),
      `R3 ${label} finalized funding sweep`).toEqual({ passA: {}, passB: { recorded: 1 } });
    const row = fundingPrepareRow(scopeId)!;
    const unitIds = array(json(row.unitIds, `R3 ${label} prepare.unitIds`), `R3 ${label} prepare.unitIds`);
    expect(unitIds, `R3 ${label} prepare.unitIds count`).toHaveLength(1);
    const unitId = word(unitIds[0], `R3 ${label} prepare.unitIds[0]`);
    expect(prepared.unitIds, `R3 ${label} SDK unitIds`).toEqual([unitId]);
    return { label, jobId, scopeId, prepared, unitId, payload, servedBytes,
      fundTx: funding.fundTx, fundReceipt, row };
  }

  async function issue(unit: typeof u) {
    const response = await app.inject({ method: "POST", url: "/api/admin/settlement-challenges",
      headers: { "x-admin-key": ADMIN }, payload: { jobId: unit.jobId, chainId: 31337,
        escrow: unit.prepared.escrow, settlementUnitId: unit.unitId } });
    expect(response.statusCode, `R4 ${unit.label} challenge status: ${response.body}`).toBe(200);
    return object(response.json<unknown>(), `R4 ${unit.label} challenge`);
  }
  async function buildPackage(unit: typeof u, challenge: Record<string, unknown>,
    operatorKey: Awaited<ReturnType<typeof loadOperatorKey>>, deviceKey: Awaited<ReturnType<typeof loadDeviceKey>>) {
    const config = unit.prepared.configs[0]!;
    const fundedAt = Number((await pub.getBlock({ blockHash: unit.fundReceipt.blockHash })).timestamp);
    const now = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
    const nonce = word(challenge.nonce, `R5 ${unit.label} challenge.nonce`);
    const session = await openUnitEvidenceSession({ settlementUnitId: unit.unitId, challengeNonce: nonce,
      jobId: unit.jobId, parentAgentId: `eip155:31337:${operator.address.toLowerCase()}`,
      fundedAt, expiresAt: Number(config.reclaimAt), deviceKey,
      journalDir: join(scratch!, `journal-${unit.label}`), now: () => now });
    // This event observes local funding, and claims no physical execution result.
    const event: Omit<EvidenceEvent, "id" | "hash"> = { type: "execution_progress",
      timestamp: new Date(fundedAt * 1000).toISOString(),
      source: { kernelId: KERNEL, deviceId: "cp4-local-chain-observer", deviceType: "gateway_bridge" },
      payload: { jobId: unit.jobId, settlementUnitId: unit.unitId, challengeNonce: nonce,
        phase: "local_funding_observed", fundingTxHash: unit.fundTx, fundingBlockHash: unit.fundReceipt.blockHash } };
    await session.addEvent({ ...event, id: `event:cp4:${unit.label}`, hash: await hashEvent(event) });
    const bundle = await session.finalize();
    const built = buildMilestonePackage(bundle, { chainId: 31337, escrow: unit.prepared.escrow,
      settlementUnitId: unit.unitId, jobIdHash: unit.prepared.identity.jobIdHash,
      milestoneIndex: config.milestoneIndex, stepId: config.stepId, compositionRoot: config.compositionRoot,
      acceptedEnvelopeHash: unit.row.acceptedPolicyDigest as Hex, challengeNonce: nonce,
      compositionSchemaVersion: config.compositionSchemaVersion, operator: operator.address, kernelId: KERNEL,
      devicePublicKey: deviceKey.signingPublicKey as Hex, tChallengeRef: text(challenge.tChallengeRef, "R5 tChallengeRef"),
      evidenceTimeBounds: { start: String(fundedAt), end: String(now) } }, {
      programHash: sha(readFileSync(fileURLToPath(import.meta.url))),
      attestationSetRoot: sha(jcs([])), workProductRoot: sha(unit.servedBytes),
    });
    return signMilestonePackage(built, operatorKey, deviceKey);
  }

  beforeAll(async () => {
    // R1: local chain and the real funding fixture, including its ORACLE pin.
    scratch = execFileSync("mktemp", ["-d", join(process.env.TMPDIR ?? tmpdir(), "cp4.XXXXXX")], { encoding: "utf8" }).trim();
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(bin("anvil"), ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
    let spawnError: Error | undefined;
    anvil.on("error", error => { spawnError = error; });
    chain = { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } } };
    pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 100 });
    testClient = createTestClient({ mode: "anvil", chain, transport: http(rpc) });
    for (let attempt = 0; ; attempt++) {
      if (spawnError) throw spawnError;
      try { await pub.getChainId(); break; }
      catch { if (attempt >= 80) throw new Error("R1 anvil did not start"); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    const output = execFileSync(bin("forge"), ["script", FIXTURE, "--root", ROOT, "--offline", "--rpc-url", rpc,
      "--broadcast", "--slow", "--unlocked", "--sender", ANVIL_SENDER], { cwd: ROOT, encoding: "utf8",
      env: { ...process.env, FOUNDRY_OUT: join(scratch, "out"), FOUNDRY_CACHE_PATH: join(scratch, "cache"),
        FOUNDRY_BROADCAST: join(scratch, "broadcast") }, maxBuffer: 64 << 20, timeout: 300000 });
    const grab = (name: string): Address => {
      const match = output.match(new RegExp(`${name} (0x[0-9a-fA-F]{40})`));
      if (!match?.[1]) throw new Error(`R1 missing fixture address ${name}`);
      return match[1] as Address;
    };
    deployed = { FACTORY: grab("FACTORY"), IMPL: grab("IMPL"), TOKEN: grab("TOKEN"), ORACLE: grab("ORACLE") };
    operatorPrivateKey = generatePrivateKey();
    operator = privateKeyToAccount(operatorPrivateKey);
    buyer = privateKeyToAccount(generatePrivateKey());
    outsider = privateKeyToAccount(generatePrivateKey());
    for (const account of [buyer, operator, outsider]) await testClient.setBalance({ address: account.address, value: 10n ** 20n });
    await testClient.mine({ blocks: 100, interval: 2 });
    lag = (await pub.getBlock({ blockTag: "latest" })).number! - (await pub.getBlock({ blockTag: "finalized" })).number!;
    expect(lag, "R1 latest minus finalized lag").toBeGreaterThanOrEqual(1n);
    reads = createVNextChainReads(rpc);

    // R2: one gateway and its store; ordinary credentials supply caller identity.
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("PCC_SEED_DATA", "true");
    vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
    vi.stubEnv("DATABASE_URL", "");
    delete process.env.DATABASE_URL;
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    vi.stubEnv("PCC_VNEXT_RPC_URL", rpc);
    vi.stubEnv("PCC_GATEWAY_RECEIPT_SEED", randomBytes(32).toString("hex"));
    vi.stubEnv("PCC_GATEWAY_RECEIPT_VALID_FROM", "0");
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    await app.ready();
    __setFundingRecordStoreForTest(new SqliteFundingRecordStore());
    __setPaidScopeActivationTermsForTest(() => ({ expectedChainId: 31337, postActivationTtlMs: 3600000, testnetOnly: false }));
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", buyer.address);
    vi.useFakeTimers({ toFake: ["Date"] });

    // R3: U then decoy V, each the sole funded unit of its own job/scope.
    __setBuyerFundingTestUnitForTest({ ...buyerFundingUnitEntry(DRY_RUN_UNIT_ID)!, id: "cp4-anvil-unit-v1",
      chainId: 31337, scheduleId: "vnext-mainnet-v1", scheduleTestnetOnly: false,
      usdc: deployed.TOKEN.toLowerCase() as Address, reclaimDelaySeconds: 866100n });
    db().update(schema.shopKernels).set({ operatorAddress: operator.address }).where(eq(schema.shopKernels.id, KERNEL)).run();
    db().update(schema.operatorPolicies).set({ policy: { version: 1, emergencyStop: false, vnextBuyerFunding: "cp4-anvil-unit-v1" } as never })
      .where(eq(schema.operatorPolicies.kernelId, KERNEL)).run();
    u = await fundUnit("U");
    v = await fundUnit("V");
    expect(v.unitId, "R3 V must differ from U").not.toBe(u.unitId);
    const now = (await pub.getBlock({ blockTag: "latest" })).timestamp;
    vi.setSystemTime(Number(now) * 1000);
    const sessionToken = randomUUID(), createdAt = new Date().toISOString();
    getRepos().sessions.insert({ id: randomUUID(), token: sessionToken, walletAddress: buyer.address.toLowerCase(),
      createdAt, lastActiveAt: createdAt, expiresAt: new Date(Number(now + 86400n) * 1000).toISOString() });
    buyerCookie = `pcc_session=${app.signCookie(sessionToken)}`;

    // R4: issue both challenges through the admin route, U then V.
    const uChallenge = await issue(u);
    const vChallenge = await issue(v);

    // R5: generate the device key, register it, and use the real host signers.
    const seed = randomBytes(32);
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der", type: "pkcs8" });
    const raw = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(12);
    const devicePublicKey = `0x${raw.toString("hex")}`;
    const common = { version: 1, purpose: "CP-4 local rehearsal", createdAt };
    const devicePath = join(scratch, "device-key.json"), operatorPath = join(scratch, "operator-key.json");
    writeFileSync(devicePath, JSON.stringify({ ...common, kind: "pcc-printhost.device-key", algorithm: "ed25519",
      publicKey: devicePublicKey, seed: seed.toString("hex") }), { mode: 0o600 });
    seed.fill(0);
    writeFileSync(operatorPath, JSON.stringify({ ...common, kind: "pcc-printhost.operator-key", algorithm: "secp256k1",
      address: operator.address, privateKey: operatorPrivateKey }), { mode: 0o600 });
    const deviceKey = await loadDeviceKey(devicePath, { delegationBinding: { chainId: 31337, operator: operator.address } });
    const operatorKey = await loadOperatorKey(operatorPath, 31337);
    db().update(schema.shopKernels).set({ signingKeyAlgorithm: "ed25519", signingKeyPublicKey: devicePublicKey,
      signingAddress: null }).where(eq(schema.shopKernels.id, KERNEL)).run();
    uPackage = await buildPackage(u, uChallenge, operatorKey, deviceKey);
    vPackage = await buildPackage(v, vChallenge, operatorKey, deviceKey);

    // R6: mint a session key through the app, then mint as the kernel's operator.
    const operatorSession = randomUUID();
    getRepos().sessions.insert({ id: randomUUID(), token: operatorSession, walletAddress: operator.address.toLowerCase(),
      createdAt, lastActiveAt: createdAt, expiresAt: new Date(Number(now + 86400n) * 1000).toISOString() });
    const keyResponse = await app.inject({ method: "POST", url: "/api/auth/session-key",
      headers: { authorization: `Bearer ${operatorSession}` } });
    expect(keyResponse.statusCode, "R6 operator session key mint status").toBe(201);
    bearer = text(object(keyResponse.json<unknown>(), "R6 operator session key").api_key, "R6 operator session key.api_key");
    outsiderBearer = provisionApiKey({ operatorId: outsider.address.toLowerCase(), name: "CP-4 no kernel", scopes: ["*"] }).rawKey;
    for (const { unit, pkg } of [{ unit: u, pkg: uPackage }, { unit: v, pkg: vPackage }]) {
      const response = await app.inject({ method: "POST", url: `/api/operator/jobs/${unit.jobId}/receipt`, headers: headers(),
        payload: { packageEnvelope: { body: pkg.body, signatures: pkg.signatures } } });
      expect(response.statusCode, `R6 ${unit.label} receipt mint status: ${response.body}`).toBe(200);
    }

    await (async () => {
      // R7: the oracle, attester and executor legs run here
    })();
    const lastBlock = (await pub.getBlock({ blockTag: "latest" })).number!;
    await finalized();
    snapshot = await reads.finalizedBlock();
    expect(snapshot.number, "R7 finalized snapshot must be past every rehearsal transaction").toBeGreaterThan(lastBlock);
  }, 600000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      anvil?.kill();
      __setBuyerFundingTestUnitForTest(null);
      __setFundingRecordStoreForTest(null);
      __setPaidScopeActivationTermsForTest(null);
      vi.useRealTimers();
      vi.unstubAllEnvs();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  });

  async function jobReceipt(cell: string) {
    const response = await app.inject({ url: jobReceiptUrl(), headers: headers() });
    expect(response.statusCode, `${cell} job receipt status: ${response.body}`).toBe(200);
    return object(response.json<unknown>(), `${cell} job receipt`);
  }
  function keptBytes(dto: Record<string, unknown>, cell: string) {
    const encoded = text(dto.packageBytes, `${cell} job receipt.packageBytes`);
    expect(encoded, `${cell} packageBytes standard padded base64`).toMatch(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    const bytes = Buffer.from(encoded, "base64");
    expect(bytes.length, `${cell} packageBytes must be nonempty`).toBeGreaterThan(0);
    expect(bytes.toString("base64"), `${cell} packageBytes base64 round trip`).toBe(encoded);
    return bytes;
  }
  async function settlement(kind: string, cell: string) {
    const response = await app.inject({ url: settlementUrl(kind), headers: headers() });
    expect(response.statusCode, `${cell} ${kind} status: ${response.body}`).toBe(200);
    const dto = object(response.json<unknown>(), `${cell} ${kind}`);
    expect(dto.asOfBlockHash, `${cell} ${kind}.asOfBlockHash`).toBe(snapshot.hash);
    expect(dto.asOfBlock, `${cell} ${kind}.asOfBlock`).toBe(snapshot.number.toString());
    expect(dto.chainId, `${cell} ${kind}.chainId`).toBe(31337);
    expect(text(dto.escrow, `${cell} ${kind}.escrow`).toLowerCase(), `${cell} ${kind}.escrow mismatch`).toBe(u.prepared.escrow.toLowerCase());
    expect(dto.unitId, `${cell} ${kind}.unitId`).toBe(u.unitId);
    return dto;
  }
  async function checkSnapshot(cell: string) {
    expect((await reads.blockByNumber(snapshot.number)).hash, `${cell} pinned H must remain canonical`).toBe(snapshot.hash);
  }

  it("C1 the job receipt read serves the kept package bytes behind the kernel gate", async () => {
    const dto = await jobReceipt("C1"), bytes = keptBytes(dto, "C1");
    const receipt = object(dto.receipt, "C1 receipt");
    expect(sha(bytes), "C1 packageBytes SHA-256 vs receipt.packageDigest").toBe(receipt.packageDigest);
    const parsed = object(json(bytes.toString("utf8"), "C1 packageBytes"), "C1 decoded package");
    expect(parsed.body, "C1 kept package body vs R6 U body").toEqual(uPackage.body);
    const signatures = array(parsed.signatures, "C1 kept signatures").map(jcs).sort();
    expect(signatures, "C1 kept signature set vs R6 U signatures").toEqual(uPackage.signatures.map(jcs).sort());
    for (const credential of [{}, { authorization: `Bearer ${outsiderBearer}` }]) {
      const refusal = await app.inject({ url: jobReceiptUrl(), headers: credential });
      expect(refusal.statusCode, "C1 kernel gate refusal must be 4xx").toBeGreaterThanOrEqual(400);
      expect(refusal.statusCode, "C1 kernel gate refusal must be below 500").toBeLessThan(500);
      expect(object(refusal.json<unknown>(), "C1 kernel gate refusal"), "C1 refused reply must omit packageBytes").not.toHaveProperty("packageBytes");
    }
  });

  it("C2 the kept bytes reproduce the package digest independently", async () => {
    const dto = await jobReceipt("C2"), bytes = keptBytes(dto, "C2");
    const parsed = json(bytes.toString("utf8"), "C2 packageBytes");
    expect(Buffer.from(jcs(parsed), "utf8"), "C2 independent JCS vs exact decoded bytes").toEqual(bytes);
    const digest = sha(bytes);
    expect(digest, "C2 independent SHA-256 vs receipt.packageDigest").toBe(object(dto.receipt, "C2 receipt").packageDigest);
    expect(digest, "C2 independent SHA-256 vs R5 U digest").toBe(uPackage.packageDigest);
  });

  it("C3 the funded commitments match the chain", async () => {
    const response = await app.inject({ url: `/api/jobs/${u.jobId}/funding`, headers: { cookie: buyerCookie } });
    expect(response.statusCode, `C3 funding read status: ${response.body}`).toBe(200);
    const scopes = array(object(response.json<unknown>(), "C3 funding read").scopes, "C3 funding.scopes");
    expect(scopes, "C3 funding.scopes must contain only U's scope").toHaveLength(1);
    const scope = object(scopes[0], "C3 funding.scopes[0]");
    expect(scope.scopeId, "C3 scopeId vs U").toBe(u.scopeId);
    expect(scope.binding, "C3 funding binding").toBe("bound");
    const verification = object(scope.verification, "C3 verification");
    expect(text(verification.escrowAddress, "C3 verification.escrowAddress").toLowerCase(), "C3 verification clone vs U").toBe(u.prepared.escrow.toLowerCase());
    expect(verification.chainId, "C3 verification.chainId").toBe(31337);
    const deployment = object(scope.deployment, "C3 deployment");
    expect(deployment.basis, "C3 deployment.basis").toBe("configured");
    expect(deployment.chainId, "C3 deployment.chainId").toBe(31337);
    expect(deployment.chainClass, "C3 deployment.chainClass").toBe("local");
    const fundingBlockNumber = uint(verification.fundingBlockNumber, "C3 fundingBlockNumber");
    const fundingBlock = await pub.getBlock({ blockNumber: fundingBlockNumber });
    expect(verification.fundingBlockHash, "C3 fundingBlockHash vs anvil block").toBe(fundingBlock.hash);
    expect(fundingBlock.transactions, "C3 funding block must hold U fundTx").toContain(u.fundTx);
    const receipt = await pub.getTransactionReceipt({ hash: u.fundTx });
    expect(receipt.blockHash, "C3 fundTx receipt blockHash").toBe(verification.fundingBlockHash);
    const logs = parseEventLogs({ abi: FUNDED_ABI, logs: receipt.logs.filter(log => log.address.toLowerCase() === u.prepared.escrow.toLowerCase()) });
    const funded = logs.filter(log => log.args.unitId === u.unitId);
    expect(funded, "C3 clone UnitFunded logs for U").toHaveLength(1);

    const payload = u.payload, approve = object(payload.approve, "C3 served approve");
    expect(text(payload.usdc, "C3 served usdc").toLowerCase(), "C3 served usdc vs fixture TOKEN").toBe(deployed.TOKEN.toLowerCase());
    expect(text(approve.token, "C3 approve.token").toLowerCase(), "C3 approve.token vs fixture TOKEN").toBe(deployed.TOKEN.toLowerCase());
    expect(text(payload.escrow, "C3 served escrow").toLowerCase(), "C3 served escrow vs U clone").toBe(u.prepared.escrow.toLowerCase());
    expect(text(approve.spender, "C3 approve.spender").toLowerCase(), "C3 approve.spender vs U clone").toBe(u.prepared.escrow.toLowerCase());
    const configs = array(object(payload.fund, "C3 served fund").configs, "C3 fund.configs");
    expect(configs, "C3 fund.configs count").toHaveLength(1);
    const config = object(configs[0], "C3 config"), gross = uint(payload.totalGross, "C3 totalGross");
    expect(uint(approve.amount, "C3 approve.amount"), "C3 approve.amount vs totalGross").toBe(gross);
    expect(uint(config.g, "C3 config.g"), "C3 config.g vs approve.amount").toBe(uint(approve.amount, "C3 approve.amount"));
    const payouts = array(config.payouts, "C3 config.payouts");
    expect(payouts, "C3 payout leg count").toHaveLength(1);
    const leg = object(payouts[0], "C3 payout leg");
    expect(text(leg.recipient, "C3 leg.recipient").toLowerCase(), "C3 payout recipient vs kernel operator").toBe(operator.address.toLowerCase());
    expect(uint(leg.amount, "C3 leg.amount"), "C3 payout amount vs config.g").toBe(uint(config.g, "C3 config.g"));
    const fundedKeys: Array<"g" | "f" | "n"> = ["g", "f", "n"];
    for (const key of fundedKeys) {
      expect(funded[0]!.args[key], `C3 UnitFunded.${key} vs served config.${key}`).toBe(uint(config[key], `C3 config.${key}`));
    }
    const pin = word(verification.blockHash, "C3 verification.blockHash");
    expect((await pub.getBlock({ blockHash: pin })).number, "C3 verification block number/hash").toBe(uint(verification.blockNumber, "C3 verification.blockNumber"));
    const call = (name: string, args: readonly unknown[]) => reads.call(u.prepared.escrow, ESCROW_READ_ABI, name, args, pin);
    expect(await call("unitCount", []), "C3 pinned unitCount").toBe(1n);
    expect(await call("unitIdAt", [0n]), "C3 pinned unitIdAt(0) vs U").toBe(u.unitId);
    expect(await call("feeBpsOf", [u.unitId]), "C3 pinned feeBpsOf vs config.feeBps").toBe(integer(config.feeBps, "C3 config.feeBps"));
    expect(text(await call("feeRecipientOf", [u.unitId]), "C3 feeRecipientOf").toLowerCase(), "C3 pinned feeRecipientOf vs config").toBe(text(config.feeRecipient, "C3 config.feeRecipient").toLowerCase());
    expect(await call("requiredTierOf", [u.unitId]), "C3 pinned requiredTierOf vs config.requiredTier").toBe(integer(config.requiredTier, "C3 config.requiredTier"));
    expect(await reads.call(deployed.TOKEN, erc20Abi, "balanceOf", [u.prepared.escrow], pin), "C3 pinned clone TOKEN balance vs totalGross").toBe(gross);
  });

  it("C4 the verdict and attestation bind the unit and the package", async () => {
    const dto = await settlement("receipt", "C4");
    expect(dto.authorizationType, "C4 receipt.authorizationType").toBe("EVIDENCE");
    const uid = word(dto.authorizationId, "C4 receipt.authorizationId");
    const evidence = word(dto.evidenceBundleHash, "C4 receipt.evidenceBundleHash");
    const verdictHash = word(dto.verdictHash, "C4 receipt.verdictHash");
    const epoch = integer(dto.oracleAuthEpoch, "C4 receipt.oracleAuthEpoch");
    const receipt = object((await jobReceipt("C4")).receipt, "C4 kept receipt");
    const config = u.prepared.configs[0]!;
    expect(evidence, "C4 evidence commitment vs U unit and kept packageDigest").toBe(evidenceCommitment({
      chainId: 31337n, escrow: u.prepared.escrow, settlementUnitId: u.unitId,
      compositionSchemaVersion: config.compositionSchemaVersion, packageDigest: word(receipt.packageDigest, "C4 packageDigest") }));
    expect(await reads.call(u.prepared.escrow, ESCROW_READ_ABI, "evidenceBundleHashOf", [u.unitId], snapshot.hash), "C4 pinned evidenceBundleHashOf").toBe(evidence);
    const oracle = address(await reads.call(u.prepared.escrow, ESCROW_READ_ABI, "authorizedOracle", [], snapshot.hash), "C4 authorizedOracle");
    expect(oracle.toLowerCase(), "C4 authorizedOracle must differ from fixture ORACLE").not.toBe(deployed.ORACLE.toLowerCase());
    const logs = await pub.getLogs({ address: oracle, event: MIRROR_ABI[0], args: { settlementUnitId: u.unitId }, fromBlock: 0n, toBlock: snapshot.number, strict: true });
    const matching = logs.filter(log => log.args.escrow.toLowerCase() === u.prepared.escrow.toLowerCase() && log.args.easUid === uid);
    expect(matching, "C4 O5Mirrored for U clone and authorizationId").toHaveLength(1);
    const mirror = matching[0]!;
    expect(mirror.address.toLowerCase(), "C4 O5Mirrored emitter vs authorizedOracle").toBe(oracle.toLowerCase());
    expect(mirror.args.verdictHash, "C4 O5Mirrored.verdictHash vs read").toBe(verdictHash);
    expect(mirror.args.cohort, "C4 O5Mirrored.cohort vs oracleAuthEpoch").toBe(BigInt(epoch));
    const assertion = object(await reads.call(oracle, ASSERTION_ABI, "assertionOf", [u.unitId], snapshot.hash), "C4 assertionOf(U)");
    expect(assertion.evidenceBundleHash, "C4 assertionOf(U).evidenceBundleHash").toBe(evidence);
    expect(assertion.oracleAuthEpoch, "C4 assertionOf(U).oracleAuthEpoch").toBe(BigInt(epoch));
    expect(assertion.assertionId, "C4 assertionOf(U).assertionId vs O5Mirrored").toBe(mirror.args.assertionId);
    await checkSnapshot("C4");
  });

  function logValue(dto: Record<string, unknown>, field: string) {
    const sourced = object(dto[field], `C5 ${field}`);
    expect(sourced.source, `C5 ${field}.source`).toBe("log");
    expect(sourced.chain, `C5 ${field}.chain`).toBe("eip155:31337");
    expect(text(sourced.contractOrRegistryId, `C5 ${field}.contractOrRegistryId`).toLowerCase(), `C5 ${field} clone`).toBe(u.prepared.escrow.toLowerCase());
    expect(sourced.blockNumber, `C5 ${field}.blockNumber`).toBe(snapshot.number.toString());
    expect(sourced.blockHash, `C5 ${field}.blockHash`).toBe(snapshot.hash);
    expect(sourced.finality, `C5 ${field}.finality`).toBe("finalized");
    expect(sourced.completeness, `C5 ${field}.completeness`).toBe("complete");
    return sourced.value;
  }
  it("C5 the transactions and payouts reconcile with the chain", async () => {
    const lifecycle = await settlement("lifecycle", "C5");
    expect(lifecycle.finalState, "C5 lifecycle.finalState").toBe("SETTLED_RELEASED");
    expect(lifecycle.isTerminal, "C5 lifecycle.isTerminal").toBe(true);
    const dto = await settlement("receipt", "C5");
    expect(dto.finalState, "C5 receipt.finalState").toBe("SETTLED_RELEASED");
    const economics = object(dto.economics, "C5 release-verified economics");
    expect(text(economics.recipient, "C5 economics.recipient").toLowerCase(), "C5 economics recipient vs kernel operator").toBe(operator.address.toLowerCase());
    expect(text(economics.token, "C5 economics.token").toLowerCase(), "C5 economics token vs fixture TOKEN").toBe(deployed.TOKEN.toLowerCase());
    const amount = uint(economics.amount, "C5 economics.amount"), fee = uint(economics.feeAmount, "C5 economics.feeAmount");
    const fundingTx = word(logValue(dto, "fundingTxHash"), "C5 fundingTxHash.value");
    expect(fundingTx, "C5 fundingTxHash vs R3 U fundTx").toBe(u.fundTx);
    const finalizedTx = word(logValue(dto, "finalizedTxHash"), "C5 finalizedTxHash.value");
    const finalizedBlock = uint(logValue(dto, "finalizedBlock"), "C5 finalizedBlock.value");
    const receipt = await pub.getTransactionReceipt({ hash: finalizedTx });
    expect(receipt.status, "C5 finalizedTxHash successful receipt").toBe("success");
    expect(receipt.blockNumber, "C5 finalizedTxHash receipt block vs finalizedBlock").toBe(finalizedBlock);
    expect(receipt.blockNumber, "C5 finalized transaction must be at or before H").toBeLessThanOrEqual(snapshot.number);
    expect((await pub.getBlock({ blockNumber: receipt.blockNumber })).hash, "C5 finalized transaction canonical blockHash").toBe(receipt.blockHash);
    const transfers = await pub.getLogs({ address: deployed.TOKEN,
      event: parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"])[0],
      args: { from: u.prepared.escrow }, fromBlock: 0n, toBlock: snapshot.number, strict: true });
    let paid = 0n, fees = 0n;
    for (const transfer of transfers) {
      if (transfer.args.to.toLowerCase() === operator.address.toLowerCase()) paid += transfer.args.value;
      else fees += transfer.args.value;
    }
    expect(paid, "C5 U clone TOKEN transfers to operator vs economics.amount").toBe(amount);
    expect(fees, "C5 U clone TOKEN transfers elsewhere vs economics.feeAmount").toBe(fee);
    await checkSnapshot("C5");
  });

  function label(dto: Record<string, unknown>, field: string) {
    const network = object(dto.network, `${field}.network`);
    expect(network.chainId, `${field}.network.chainId`).toBe(31337);
    expect(network.chainClass, `${field}.network.chainClass`).toBe("local");
    // As on the settlement receipt, the registry classification is sourced.
    const asset = object(dto.assetReality, `${field}.assetReality`);
    expect(asset.source, `${field}.assetReality.source`).toBe("registry");
    expect(["test", "unknown"], `${field}.assetReality.value must never be real`).toContain(asset.value);
  }
  it("C6 every read labels the rehearsal local and never real", async () => {
    const dto = await jobReceipt("C6");
    const receipt = object(dto.receipt, "C6 signed receipt");
    expect(receipt, "C6 network must sit outside the signed receipt").not.toHaveProperty("network");
    expect(receipt, "C6 assetReality must sit outside the signed receipt").not.toHaveProperty("assetReality");
    label(dto, "C6 job receipt beside signed receipt");
    for (const kind of ["receipt", "lifecycle", "provenance"]) label(await settlement(kind, "C6"), `C6 ${kind}`);
  });
});
