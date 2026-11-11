import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, getAddress, keccak256,
  numberToHex, parseAbi, parseTransaction, toBytes, toHex, type Hex,
} from "viem";
import { settlementUnitId } from "@pcc/contracts/vnext";
import { hashBundle } from "@pcc/spec";
import { createEvidenceBroadcaster, type EvidenceBroadcaster, type EvidenceSubmission } from "../src/chain.js";
import type { HostConfig } from "../src/config.js";
import type { GwResult, PollJobsValue, RelayEvidenceBundle, ReceiptEnvelope } from "../src/gateway-client.js";
import type { JobFunding } from "../src/gateway-client.js";
import { createHost, HOST_LOG_CODES, type HostDeps, type HostLogCode, type HostTimers } from "../src/host.js";
import type { JobInputs } from "../src/job-inputs.js";
import { createJobJournal, type JournalRecord, type JournalState, type SignedMilestonePackage } from "../src/journal.js";
import type { ClaimFunding } from "../src/journal.js";
import { generateHostKeys } from "../src/keygen.js";
import { loadDeviceKey, loadOperatorKey } from "../src/keys.js";
import { computePackageDigest } from "../src/package-builder.js";
import { FakeMachineAdapter } from "../src/testing/fake-machine-adapter.js";

const jobId = "job:host-submit";
const cleanups: Array<() => Promise<void>> = [];
const word = (): Hex => toHex(randomBytes(32));
const functions = parseAbi([
  "function unitTerms(bytes32 unitId) view returns (uint256 milestoneIndex_, bytes32 stepId_, uint8 requestedTier_, uint256 reclaimAt_, bytes32 payoutConfigHash_, uint16 compositionSchemaVersion_, bool evidenceCommitted_)",
  "function jobIdHash() view returns (bytes32)",
  "function evidenceBundleHashOf(bytes32 unitId) view returns (bytes32)",
  "function submitEvidence(bytes32 unitId, bytes32 packageDigest)",
]);
const errors = parseAbi(["error EvidenceNotCommitted()", "error NotActive()"]);
const completedStates = ["claimed", "in_progress_reported", "printing", "printed", "bundle_saved",
  "evidence_stored", "package_built", "receipt_stored", "submit_attempted", "submitted"];

// Independently spell the escrow commitment ABI, including its format version.
function commitment(input: EvidenceSubmission): Hex {
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
    { type: "uint16" }, { type: "uint8" }, { type: "bytes32" },
  ], [keccak256(toBytes("PCC:vnext:evidence-commitment:v1")), 31337n, input.escrow,
    input.unitId, input.compositionSchemaVersion, 1, input.packageDigest]));
}

function submission(value: SignedMilestonePackage): EvidenceSubmission {
  return { escrow: getAddress(value.body.unitBinding.escrow), unitId: value.body.unitBinding.settlementUnitId as Hex,
    packageDigest: value.packageDigest, compositionSchemaVersion: Number(value.body.compositionSchemaVersion) };
}

async function fixture(options: {
  caps?: boolean;
  missingInputs?: boolean;
  simulated?: boolean;
  realMode?: boolean;
  fundingSource?: "gateway" | "manifest";
  print?: HostDeps["print"];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ph4-host-submit-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const now = new Date("2026-10-13T12:00:00.000Z");
  const generated = await generateHostKeys(join(directory, "keys"), { now });
  const loadedOperator = await loadOperatorKey(generated.paths.operatorKeyFile, 31337, { now });
  const loadedDevice = await loadDeviceKey(generated.paths.deviceKeyFile, {
    now, delegationBinding: { chainId: 31337, operator: loadedOperator.address },
  });
  const rpcUrl = `https://rpc.example.test/${randomBytes(24).toString("base64url")}`;
  const rpcUrlFile = join(directory, "rpc-url");
  await writeFile(rpcUrlFile, `${rpcUrl}\n`, { mode: 0o600 });
  const fundingSource = options.fundingSource ?? (options.missingInputs ? "manifest" : "gateway");
  const config: HostConfig = {
    kernelId: "kernel:submit", deviceId: "device:submit", printer: { uri: "ipp://localhost/ipp/print" },
    chain: { chainId: 31337, rpcUrlFile, receiptTimeoutMs: 50, pollingIntervalMs: 1,
      ...(options.caps === false ? {} : { maxFeePerGasCap: "100", maxPriorityFeePerGasCap: "20", gasCap: "100000" }) },
    gateway: { baseUrl: "https://gateway.example.test", apiKeyFile: "/unused/api-key" },
    funding: { source: fundingSource },
    keys: generated.paths, dataDir: directory,
  };
  const journal = createJobJournal(directory, () => now.getTime());
  async function diskRecords(): Promise<JournalRecord[]> {
    const text = await readFile(journal.journalPath(jobId), "utf8").catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    if (!text) return [];
    return text.trimEnd().split("\n").map((line) => JSON.parse(line) as JournalRecord);
  }
  async function diskPackage(): Promise<SignedMilestonePackage> {
    return JSON.parse(await readFile(journal.packagePath(jobId), "utf8")) as SignedMilestonePackage;
  }
  const d1States: JournalState[][] = [];
  const operatorKey = { address: loadedOperator.address,
    signD1: vi.fn(async (input: Parameters<typeof loadedOperator.signD1>[0]) => {
      d1States.push((await diskRecords()).map((record) => record.state));
      return loadedOperator.signD1(input);
    }),
    signSubmitEvidenceTx: vi.fn(loadedOperator.signSubmitEvidenceTx),
  };
  const deviceKey = { ...loadedDevice, signDelegation: vi.fn(loadedDevice.signDelegation), signD2: vi.fn(loadedDevice.signD2) };
  const fundedAt = Math.floor(Date.UTC(2026, 9, 9) / 1000) - 60;
  const reclaimAt = Math.floor(now.getTime() / 1000) + 3 * 86400;
  const packageUnit = { chainId: 31337 as const, escrow: getAddress(toHex(randomBytes(20))),
    jobIdHash: keccak256(toBytes(jobId)), milestoneIndex: 7, stepId: word(), compositionRoot: word(),
    acceptedEnvelopeHash: word(), compositionSchemaVersion: 1, tChallengeRef: "challenge:host-submit",
    evidenceTimeBounds: { start: String(fundedAt), end: String(reclaimAt) } };
  const unitId = settlementUnitId({ ...packageUnit, chainId: 31337n, milestoneIndex: 7n });
  const inputs: JobInputs = {
    documentData: Buffer.from("%PDF-1.7\nprint fixture"), jobName: "buyer.pdf", totalPages: 2,
    unit: { settlementUnitId: unitId, challengeNonce: word(), fundedAt, reclaimAt,
      ...(options.missingInputs ? {} : packageUnit) },
    ...(options.missingInputs ? {} : { program: { programHash: word(), attestationSetRoot: word(), workProductRoot: word() } }),
  };
  const inputSource = vi.fn(async () => ({ ok: true as const, value: inputs }));
  const funding: Extract<JobFunding, { ok: true }> = {
    ok: true, fundedAt, operator: loadedOperator.address.toLowerCase(),
    escrowAddress: packageUnit.escrow.toLowerCase(), chainId: 31337,
    fundingBlockNumber: "9007199254740993", fundingBlockHash: word(),
  };
  const { operator, escrowAddress, chainId, fundingBlockNumber, fundingBlockHash } = funding;
  const gatewayClaim: ClaimFunding = { source: "gateway", fundedAt, operator, escrowAddress, chainId, fundingBlockNumber, fundingBlockHash };
  const adapter = new FakeMachineAdapter(config.deviceId, config.kernelId);
  adapter.source.simulated = options.simulated ?? false;
  cleanups.push(() => adapter.dispose());
  const receiptValue = (): ReceiptEnvelope => ({ receipt: { chainId: 31337, escrow: packageUnit.escrow.toLowerCase() as Hex,
    settlementUnitId: unitId, packageDigest: word(), receivedAt: Math.floor(now.getTime() / 1000) },
    signatureHex: toHex(randomBytes(64)), receiptDigest: word(), kid: "gateway-test" });
  const receipts = new Map<Hex, ReceiptEnvelope>();
  const gateway = {
    heartbeat: vi.fn(async () => ({ ok: true as const, value: null })),
    pollJobs: vi.fn(async (): Promise<GwResult<PollJobsValue>> => ({ ok: true,
      value: { stop: { proceed: true }, jobs: [{ jobId, status: "queued", funding }], foreignJobsDropped: 0, truncated: false } })),
    reportInProgress: vi.fn(async () => ({ ok: true as const, value: { updated: true as const } })),
    postRelayEvidence: vi.fn(async (id: string, bundle: RelayEvidenceBundle): Promise<GwResult<{ jobId: string;
      contentHash: string; hashModel: "event_bundle_hash" }>> => ({ ok: true,
      value: { jobId: id, contentHash: bundle.bundleHash, hashModel: "event_bundle_hash" } })),
    postReceipt: vi.fn(async (_id: string, envelope: { body: SignedMilestonePackage["body"]; signatures: SignedMilestonePackage["signatures"] }): Promise<GwResult<ReceiptEnvelope>> => {
      const digest = computePackageDigest(envelope.body, envelope.signatures);
      let value = receipts.get(digest);
      if (!value) {
        const fresh = receiptValue();
        value = { ...fresh, receipt: { ...fresh.receipt, packageDigest: digest } };
        receipts.set(digest, value);
      }
      return { ok: true, value };
    }),
    toJSON: () => ({ baseUrl: "https://gateway.example.test", kernelId: config.kernelId }),
    toString: () => "gateway",
    [inspect.custom]: () => ({ baseUrl: "https://gateway.example.test", kernelId: config.kernelId }),
  };
  const fake: { initial: "absent" | "matching" | "conflict"; send: "ok" | "throw_after_commit" | "throw_absent" | "reject_absent";
    readFailure: boolean; stored?: Hex; storedVersion?: number; failOnce?: string; latestNonce?: number; pendingNonce?: number } = { initial: "absent", send: "ok", readFailure: false };
  const terms = new Map<Hex, { milestoneIndex: bigint; stepId: Hex; version: number }>([[unitId, { milestoneIndex: 7n, stepId: packageUnit.stepId, version: 1 }]]);
  const calls: Array<{ method: string; params: unknown }> = [];
  const sendStates: JournalState[][] = [];
  const sentData: Hex[] = [];
  let txHash = word();
  const serverText = `${rpcUrl} private-server-${randomBytes(24).toString("base64url")}`;
  const transport = custom({ request: async ({ method, params }) => {
    calls.push({ method, params });
    const callName = method === "eth_call" ? decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data }).functionName : undefined;
    const point = callName ? `eth_call:${callName}` : method === "eth_getTransactionCount" ? `${method}:${(params as unknown[])[1]}` : method;
    if (fake.failOnce === point) { fake.failOnce = undefined; throw { code: -32603, message: serverText }; }
    switch (method) {
      case "eth_chainId": return "0x7a69";
      case "eth_call": {
        if (fake.readFailure) throw { code: -32603, message: serverText };
        const decoded = decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data });
        if (decoded.functionName === "jobIdHash") return packageUnit.jobIdHash;
        if (decoded.functionName === "unitTerms") {
          const t = terms.get(decoded.args[0]);
          if (!t) throw new Error("unknown unit");
          return encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint256" },
            { type: "bytes32" }, { type: "uint16" }, { type: "bool" }],
            [t.milestoneIndex, t.stepId, 1, BigInt(reclaimAt), word(), fake.storedVersion ?? t.version, false]);
        }
        // Record wrong targets as a conflict, instead of allowing a read to pass accidentally.
        if (decoded.functionName !== "evidenceBundleHashOf" || !terms.has(decoded.args[0])) return word();
        if (fake.stored !== undefined) return fake.stored;
        if (fake.initial === "matching") return commitment(submission(await diskPackage()));
        if (fake.initial === "conflict") return word();
        throw { code: 3, message: serverText, data: encodeErrorResult({ abi: errors, errorName: "EvidenceNotCommitted" }) };
      }
      case "eth_getTransactionCount": return numberToHex((params as unknown[])[1] === "latest" ? fake.latestNonce ?? 7 : fake.pendingNonce ?? 7);
      case "eth_getBlockByNumber": return { number: "0x1", hash: word(), parentHash: word(), timestamp: "0x1",
        baseFeePerGas: "0xa", gasLimit: "0xffffff", gasUsed: "0x0", transactions: [] };
      case "eth_maxPriorityFeePerGas": return "0x2";
      case "eth_estimateGas": return numberToHex(50_000);
      case "eth_sendRawTransaction": {
        sendStates.push((await diskRecords()).map((record) => record.state));
        const raw = (params as [Hex])[0];
        const tx = parseTransaction(raw);
        sentData.push(tx.data!);
        txHash = keccak256(raw);
        const decoded = decodeFunctionData({ abi: functions, data: tx.data! });
        if (decoded.functionName !== "submitEvidence") throw new Error("wrong function");
        if (fake.send !== "throw_absent" && fake.send !== "reject_absent") fake.stored = commitment({ escrow: getAddress(tx.to!),
          unitId: decoded.args[0], packageDigest: decoded.args[1],
          compositionSchemaVersion: fake.storedVersion ?? 1 });
        if (fake.send === "reject_absent") throw { code: 3, message: serverText, data: encodeErrorResult({ abi: errors, errorName: "NotActive" }) };
        // A crash also prevents F2's immediate read-back from observing the commit;
        // the next process can reconcile it without sending again.
        if (fake.send === "throw_after_commit") fake.failOnce = "eth_call:evidenceBundleHashOf";
        if (fake.send !== "ok") throw { code: -32603, message: serverText };
        return txHash;
      }
      case "eth_getTransactionReceipt": return { transactionHash: txHash, blockHash: word(), blockNumber: "0x1",
        transactionIndex: "0x0", from: operatorKey.address, to: packageUnit.escrow, cumulativeGasUsed: "0xc350",
        gasUsed: "0xc350", contractAddress: null, logs: [], logsBloom: "0x", status: "0x1", effectiveGasPrice: "0xe", type: "0x2" };
      case "eth_blockNumber": return "0x2";
      default: throw new Error(serverText);
    }
  } });
  function newBroadcaster() {
    const real = createEvidenceBroadcaster(config, operatorKey, { transport });
    return { submit: vi.fn(real.submit), readBack: vi.fn(real.readBack) } satisfies EvidenceBroadcaster;
  }
  const broadcaster = newBroadcaster();
  const logs: HostLogCode[] = [];
  const deps: HostDeps = { config, gateway, inputSource, journal, adapter, deviceKey,
    operatorAddress: operatorKey.address, operatorKey, broadcaster, clock: () => now.getTime(),
    logger: (code) => { logs.push(code); }, timeoutMs: 500, cancelWindowMs: 100,
    ...(options.print ? { print: options.print } : {}), ...(options.realMode === undefined ? {} : { realMode: options.realMode }) };
  const host = createHost(deps);
  return { directory, config, journal, diskRecords, diskPackage, inputs, inputSource, funding, gatewayClaim, adapter, gateway, fake, calls,
    sendStates, sentData, d1States, operatorKey, deviceKey, broadcaster, newBroadcaster, logs, deps, host, rpcUrl, serverText, terms, receiptValue, advance: (ms = 60_000) => now.setTime(now.getTime() + ms) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rewriteClaim(setup: Fixture, funding: ClaimFunding | undefined) {
  await setup.journal.close();
  const path = setup.journal.journalPath(jobId);
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const claim = JSON.parse(lines[0]) as JournalRecord;
  if (funding === undefined) delete claim.funding;
  else claim.funding = funding;
  lines[0] = JSON.stringify(claim);
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function finish(setup: Fixture, failed = false) {
  setup.adapter.scriptStart({ outcome: "success", jobId: 101 });
  const started = setup.adapter.started();
  const tick = setup.host.runOnce();
  await started;
  setup.adapter.emit("execution_started", { ippJobId: 101 });
  if (failed) setup.adapter.emit("execution_failed", { ippJobId: 101, state: "canceled", origin: "device" });
  else setup.adapter.emit("execution_completed", { ippJobId: 101, totalPages: 2 });
  return tick;
}
async function restart(setup: Fixture, overrides: Partial<HostDeps> = {}) {
  await setup.journal.close();
  const broadcaster = setup.newBroadcaster();
  const journal = createJobJournal(setup.directory, setup.deps.clock);
  return { broadcaster, journal, host: createHost({ ...setup.deps, journal, broadcaster, ...overrides }) };
}
async function states(setup: Fixture) { return (await setup.journal.read(jobId)).map((record) => record.state); }
function noSubmitSignatures(setup: Fixture) {
  expect(setup.operatorKey.signD1).not.toHaveBeenCalled();
  expect(setup.deviceKey.signD2).not.toHaveBeenCalled();
  expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
  expect(setup.broadcaster.submit).not.toHaveBeenCalled();
  expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
}

function evidenceHoldTimers(setup: Fixture, options: { fire?: boolean; onWait?: () => void } = {}) {
  const waits: number[] = [];
  const timers: HostTimers = {
    setTimeout(callback, ms) {
      if (setup.gateway.postRelayEvidence.mock.calls.length === 0) return setTimeout(callback, ms);
      waits.push(ms);
      options.onWait?.();
      if (options.fire === false) return undefined;
      return setTimeout(callback, 0);
    },
    clearTimeout(handle) {
      if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  return { waits, timers };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("host package and crash-safe submitEvidence", () => {
  it("journals evidence_stored and package_built before a durable submit_attempted, then sends exact calldata and verifies read-back", async () => {
    const setup = await fixture();
    expect(await finish(setup)).toMatchObject({ kind: "job", state: "submitted" });
    expect(await states(setup)).toEqual(completedStates);
    expect(setup.sendStates).toEqual([completedStates.slice(0, -1)]);
    expect(setup.d1States).toEqual([completedStates.slice(0, 6)]);
    const pkg = await setup.diskPackage();
    expect((await setup.journal.read(jobId))[6]).toEqual({ at: "2026-10-13T12:00:00.000Z", jobId,
      state: "package_built", packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    expect(pkg.packageDigest).toBe(computePackageDigest(pkg.body, pkg.signatures));
    expect(setup.sentData).toHaveLength(1);
    expect(decodeFunctionData({ abi: functions, data: setup.sentData[0] })).toEqual({
      functionName: "submitEvidence", args: [setup.inputs.unit.settlementUnitId, pkg.packageDigest] });
    const attempt = (await setup.journal.read(jobId)).find((record) => record.state === "submit_attempted")!;
    expect(attempt.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(await setup.journal.readReceipt(jobId)).toMatchObject({ receipt: { packageDigest: pkg.packageDigest } });
    expect(setup.fake.stored).toBe(commitment(submission(pkg)));
    expect(await setup.broadcaster.readBack(submission(pkg))).toEqual({ code: "already_committed" });
    expect(setup.operatorKey.signD1).toHaveBeenCalledTimes(1);
    expect(setup.deviceKey.signD2).toHaveBeenCalledTimes(1);
    expect(setup.operatorKey.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.logs.every((code) => HOST_LOG_CODES.includes(code))).toBe(true);
    expect(JSON.stringify(setup.logs)).not.toContain(setup.rpcUrl);
    expect(JSON.stringify(setup.logs)).not.toContain(setup.serverText);
  });

  it("verifies the run-loop D1 with the gateway verifier and the run-loop D2 over raw32", async () => {
    const setup = await fixture();
    expect(await finish(setup)).toMatchObject({ state: "submitted" });
    const pkg = await setup.diskPackage();
    const verifierPath = "../../gateway/src/settlement/operator-signature-verifier.ts";
    const gatewayVerifier = await import(verifierPath) as { createEip712OperatorVerifier(deps: { operatorForUnit: () => string }): {
      verifyOperatorSignature(input: { unitBinding: typeof pkg.body.unitBinding; packageBodyHash: Hex;
        operatorPrincipalId: string; signer: string; sig: string }): Promise<boolean> } };
    const d1 = pkg.signatures.find((signature) => signature.scheme === "secp256k1-eip712")!;
    const d2 = pkg.signatures.find((signature) => signature.scheme === "ed25519-raw32")!;
    const verifier = gatewayVerifier.createEip712OperatorVerifier({ operatorForUnit: () => setup.operatorKey.address });
    expect(await verifier.verifyOperatorSignature({ unitBinding: pkg.body.unitBinding, packageBodyHash: pkg.packageBodyHash,
      operatorPrincipalId: pkg.body.producer.operatorPrincipalId, signer: d1.signer, sig: d1.sig })).toBe(true);
    expect(setup.deviceKey.signD2.mock.calls[0][0]).toEqual(toBytes(pkg.packageBodyHash));
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(setup.deviceKey.publicKeyHex, "hex")]), format: "der", type: "spki" });
    expect(verify(null, toBytes(pkg.packageBodyHash), publicKey, toBytes(d2.sig as Hex))).toBe(true);
    expect(verify(null, Buffer.from(`sha256:${pkg.packageBodyHash.slice(2)}`), publicKey, toBytes(d2.sig as Hex))).toBe(false);
    expect(pkg.signatures).toHaveLength(2);
    expect(setup.deviceKey.signDelegation).toHaveBeenCalledTimes(1);
  });

  it("reconciles a crash after sendRawTransaction by read-back and never sends a second time", async () => {
    const setup = await fixture();
    setup.fake.send = "throw_after_commit";
    expect(await finish(setup)).toMatchObject({ state: "submit_indeterminate" });
    expect(setup.sendStates).toEqual([completedStates.slice(0, -1)]);
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "already_committed" });
    expect(recovered.broadcaster.readBack).toHaveBeenCalledTimes(1);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(1);
    expect(setup.operatorKey.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect((await states(setup)).slice(-2)).toEqual(["submit_indeterminate", "already_committed"]);
    await recovered.host.runOnce();
    expect(setup.sentData).toHaveLength(1);
  });

  it("a durable submit_attempted crash before sending stays indeterminate after confirmed absence and never re-sends", async () => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === "submit_attempted") throw new Error("simulated process loss");
    });
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    expect(await states(setup)).toEqual(completedStates.slice(0, -1));
    expect(setup.sentData).toHaveLength(0);
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submit_indeterminate" });
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submit_indeterminate" });
    expect(recovered.broadcaster.readBack).toHaveBeenCalledTimes(2);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    expect(setup.operatorKey.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect((await recovered.journal.read(jobId)).at(-1)).toMatchObject({ state: "submit_indeterminate", code: "submit_absent" });
  });

  it("recovery uses the persisted package binding even when the source manifest changes", async () => {
    const setup = await fixture();
    setup.fake.send = "throw_absent";
    expect(await finish(setup)).toMatchObject({ state: "submit_indeterminate" });
    const pkg = await setup.diskPackage();
    setup.inputs.unit.settlementUnitId = word();
    setup.inputs.unit.escrow = getAddress(toHex(randomBytes(20)));
    setup.inputSource.mockClear();
    setup.fake.stored = commitment(submission(pkg));
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "already_committed" });
    expect(recovered.broadcaster.readBack).toHaveBeenCalledWith(submission(pkg));
    expect(setup.inputSource).not.toHaveBeenCalled();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(1);
  });

  it("recovers a durable package_built crash without repeating D1 or D2", async () => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === "package_built") throw new Error("simulated process loss");
    });
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    expect((await states(setup)).at(-1)).toBe("package_built");
    expect(setup.sentData).toHaveLength(0);
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(await states(setup)).toEqual(completedStates);
    expect(setup.operatorKey.signD1).toHaveBeenCalledTimes(1);
    expect(setup.deviceKey.signD2).toHaveBeenCalledTimes(1);
    expect(setup.sentData).toHaveLength(1);
  });

  it("a pre-existing matching commitment finishes already_committed without transaction signing or sending", async () => {
    const setup = await fixture();
    setup.fake.initial = "matching";
    expect(await finish(setup)).toMatchObject({ state: "already_committed" });
    expect((await states(setup)).slice(-2)).toEqual(["receipt_stored", "already_committed"]);
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.readBack).not.toHaveBeenCalled();
  });

  it("a conflicting commitment halts the job on this process and after restart", async () => {
    const setup = await fixture();
    setup.fake.initial = "conflict";
    expect(await finish(setup)).toMatchObject({ state: "conflict" });
    expect((await states(setup)).at(-1)).toBe("conflict");
    const firstRecords = await setup.journal.read(jobId);
    setup.fake.initial = "absent";
    await setup.host.runOnce();
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    await recovered.host.runOnce();
    expect(await setup.journal.read(jobId)).toEqual(firstRecords);
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.broadcaster.submit).toHaveBeenCalledTimes(1);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.readBack).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
  });

  it("a failed-print negative control is packaged and submitted as the unit's evidence", async () => {
    const setup = await fixture();
    expect(await finish(setup, true)).toMatchObject({ state: "submitted" });
    expect(await states(setup)).toEqual(completedStates.map((state) => state === "printed" ? "print_failed" : state));
    const posted = setup.gateway.postRelayEvidence.mock.calls[0][1];
    expect(posted.events.map((event) => event.type)).toEqual(["execution_started", "execution_failed"]);
    const pkg = await setup.diskPackage();
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect((await setup.journal.readReceipt(jobId))?.receipt.packageDigest).toBe(pkg.packageDigest);
    expect(pkg.evidenceBlock.kernelSignedEventsRoot).toBe(`0x${posted.bundleHash.slice(7)}`);
    expect(pkg.signatures).toHaveLength(2);
    expect(decodeFunctionData({ abi: functions, data: setup.sentData[0] }).args).toEqual([
      setup.inputs.unit.settlementUnitId, pkg.packageDigest]);
    expect(setup.fake.stored).toBe(commitment(submission(pkg)));
  });

  it("missing package inputs still prints and posts evidence, journals package_inputs_missing, and never signs a package", async () => {
    const setup = await fixture({ missingInputs: true });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_stored", code: "package_inputs_missing" });
    expect(await setup.journal.readPackage(jobId)).toBeUndefined();
    noSubmitSignatures(setup);
  });

  it("omitted caps journal submit_disabled after storing evidence and never sign or send", async () => {
    const setup = await fixture({ caps: false });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
    expect(await setup.journal.readPackage(jobId)).toBeUndefined();
    noSubmitSignatures(setup);
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    noSubmitSignatures(setup);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["T1: a sending restart keeps a --no-submit unit forfeited and claims a new job", false],
    ["T2: a missing old manifest never stalls a sending restart after --no-submit", true],
  ] as const)("%s", async (_name, oldInputsMissing) => {
    const setup = await fixture();
    setup.host = createHost({ ...setup.deps, noSubmit: true });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    const before = await setup.journal.read(jobId);
    expect(before.at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
    expect(before.map((record) => record.state)).toContain("printed");
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
    noSubmitSignatures(setup);

    const newJob = "job:after-no-submit";
    const jobIdHash = keccak256(toBytes(newJob));
    const newInputs: JobInputs = { ...setup.inputs, jobName: "new-job.pdf",
      documentData: Buffer.from("%PDF-1.7\nnew queued job"),
      unit: { ...setup.inputs.unit, jobIdHash, challengeNonce: word(),
        settlementUnitId: settlementUnitId({ chainId: 31337n, escrow: setup.inputs.unit.escrow!,
          jobIdHash, milestoneIndex: 7n, stepId: setup.inputs.unit.stepId! }) } };
    const inputSource = vi.fn<Parameters<HostDeps["inputSource"]>, ReturnType<HostDeps["inputSource"]>>(async (id) => {
      if (id === jobId && !oldInputsMissing) return { ok: true, value: setup.inputs };
      if (id === newJob) return { ok: true, value: newInputs };
      return { ok: false, code: "job_inputs_not_found" };
    });
    setup.gateway.pollJobs.mockClear();
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true },
      jobs: [{ jobId, status: "queued" }, { jobId: newJob, status: "queued", funding: setup.funding }], foreignJobsDropped: 0, truncated: false } });
    // Hold the new job before printing so only the old unit could reach settlement.
    const recovered = await restart(setup, { noSubmit: false, inputSource,
      gateway: { ...setup.gateway, reportInProgress: async () => ({ ok: false, code: "network", status: null }) } });
    for (let tick = 0; tick < 5; tick++) {
      setup.advance();
      await recovered.host.runOnce();
    }
    expect(await recovered.journal.read(jobId)).toEqual(before);
    await expect(readFile(recovered.journal.packagePath(jobId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(setup.gateway.postReceipt).not.toHaveBeenCalled();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    expect(setup.gateway.pollJobs.mock.calls.length).toBeGreaterThan(0);
    expect(inputSource).toHaveBeenCalledWith(newJob);
    expect(inputSource).not.toHaveBeenCalledWith(jobId);
    expect((await recovered.journal.read(newJob)).map((record) => record.state)).toContain("claimed");
  });

  it("T3: a sending restart keeps a package_inputs_missing unit forfeited and claims a new job", async () => {
    const setup = await fixture({ missingInputs: true });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    const before = await setup.journal.read(jobId);
    expect(before.at(-1)).toMatchObject({ state: "evidence_stored", code: "package_inputs_missing" });
    const newJob = "job:after-missing-inputs";
    const newInputs: JobInputs = { ...setup.inputs, documentData: Buffer.from("%PDF-1.7\nnew queued job"),
      unit: { ...setup.inputs.unit, settlementUnitId: word(), challengeNonce: word() } };
    const inputSource = vi.fn<Parameters<HostDeps["inputSource"]>, ReturnType<HostDeps["inputSource"]>>(async (id) => {
      if (id === jobId) return { ok: true, value: setup.inputs };
      if (id === newJob) return { ok: true, value: newInputs };
      return { ok: false, code: "job_inputs_not_found" };
    });
    setup.gateway.pollJobs.mockClear();
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true },
      jobs: [{ jobId, status: "queued" }, { jobId: newJob, status: "queued" }], foreignJobsDropped: 0, truncated: false } });
    // Hold the new job before printing so only the old unit could reach settlement.
    const recovered = await restart(setup, { inputSource,
      gateway: { ...setup.gateway, reportInProgress: async () => ({ ok: false, code: "network", status: null }) } });
    for (let tick = 0; tick < 5; tick++) {
      setup.advance();
      await recovered.host.runOnce();
    }
    expect(await recovered.journal.read(jobId)).toEqual(before);
    expect(setup.gateway.pollJobs.mock.calls.length).toBeGreaterThan(0);
    expect(inputSource).not.toHaveBeenCalledWith(jobId);
    expect((await recovered.journal.read(newJob)).map((record) => record.state)).toContain("claimed");
    expect(setup.gateway.postReceipt).not.toHaveBeenCalled();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
  });

  it("simulated evidence in real mode never posts, builds, signs or submits", async () => {
    const setup = await fixture();
    setup.adapter.scriptStart({ outcome: "success", jobId: 101 });
    const started = setup.adapter.started();
    const tick = setup.host.runOnce();
    await started;
    // Start as a genuine adapter, then emit fabricated events after startup.
    setup.adapter.source.simulated = true;
    setup.adapter.emit("execution_started", { ippJobId: 101 });
    setup.adapter.emit("execution_completed", { ippJobId: 101, totalPages: 2 });
    await tick;
    expect((await states(setup)).at(-1)).toBe("simulated_refused");
    expect(setup.gateway.postRelayEvidence).not.toHaveBeenCalled();
    noSubmitSignatures(setup);
  });

  it("explicit simulated rehearsals may relay evidence but never build, sign or submit", async () => {
    const setup = await fixture({ simulated: true, realMode: false });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
    expect(await setup.journal.readPackage(jobId)).toBeUndefined();
    noSubmitSignatures(setup);
  });

  it("an empty-event job never posts, builds a package, signs or sends", async () => {
    const setup = await fixture({ print: async () => ({ success: false, events: [], durationMs: 0 }) });
    expect(await setup.host.runOnce()).toMatchObject({ state: "print_failed" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "print_failed", code: "no_bundle" });
    expect(setup.gateway.postRelayEvidence).not.toHaveBeenCalled();
    noSubmitSignatures(setup);
  });

  it("a busy job never posts, builds a package, signs or sends", async () => {
    const setup = await fixture();
    setup.adapter.scriptStart({ outcome: "busy" });
    expect(await setup.host.runOnce()).toMatchObject({ state: "busy" });
    expect(setup.gateway.postRelayEvidence).not.toHaveBeenCalled();
    noSubmitSignatures(setup);
  });

  it.each(["not_stored", "indeterminate"] as const)("a relay %s outcome never builds, signs or submits", async (code) => {
    const setup = await fixture();
    setup.gateway.postRelayEvidence.mockResolvedValue({ ok: false, code, status: null });
    expect(await finish(setup)).toMatchObject({ state: code === "indeterminate" ? "evidence_indeterminate" : "evidence_refused" });
    expect(await states(setup)).not.toContain("evidence_stored");
    expect(await setup.journal.readPackage(jobId)).toBeUndefined();
    noSubmitSignatures(setup);
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.readBack).not.toHaveBeenCalled();
  });

  it("a read-back RPC failure leaves an attempted unit indeterminate with a closed code", async () => {
    const setup = await fixture();
    setup.fake.send = "throw_absent";
    expect(await finish(setup)).toMatchObject({ state: "submit_indeterminate" });
    setup.fake.readFailure = true;
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submit_indeterminate" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "submit_indeterminate", code: "submit_rpc_unavailable" });
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(1);
    expect(JSON.stringify(setup.logs)).not.toContain(setup.rpcUrl);
    expect(JSON.stringify(setup.logs)).not.toContain(setup.serverText);
    expect(setup.logs.every((code) => HOST_LOG_CODES.includes(code))).toBe(true);
  });
});

describe("pre-send retries and gateway receipts", () => {
  it.each([
    "eth_chainId", "eth_call:unitTerms", "eth_call:jobIdHash", "eth_call:evidenceBundleHashOf",
    "eth_getTransactionCount:pending", "eth_getBlockByNumber", "eth_maxPriorityFeePerGas", "eth_estimateGas", "rpc_file",
  ])("a one-shot %s failure writes no attempt and the next healthy tick sends exactly once", async (point) => {
    const setup = await fixture();
    if (point === "rpc_file") await unlink(setup.config.chain.rpcUrlFile);
    else setup.fake.failOnce = point;
    expect(await finish(setup)).toMatchObject({ state: "receipt_stored", waitMs: 5_000 });
    expect(await states(setup)).not.toContain("submit_attempted");
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    expect(setup.logs).toContain("submit_rpc_unavailable");
    expect(await setup.host.runOnce()).toMatchObject({ kind: "idle", waitMs: 5_000 });
    if (point === "rpc_file") await writeFile(setup.config.chain.rpcUrlFile, `${setup.rpcUrl}\n`, { mode: 0o600 });
    setup.advance(5_000);
    expect(await setup.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.sentData).toHaveLength(1);
    expect(setup.operatorKey.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(await states(setup)).toEqual(completedStates);
  });

  it("a latest-nonce RPC failure with an unsettled attempt retries without signing the new unit", async () => {
    const setup = await fixture();
    const stepId = word();
    const otherId = settlementUnitId({ chainId: 31337n, escrow: setup.inputs.unit.escrow!,
      jobIdHash: setup.inputs.unit.jobIdHash!, milestoneIndex: 8n, stepId });
    setup.terms.set(otherId, { milestoneIndex: 8n, stepId, version: 1 });
    setup.fake.send = "throw_absent";
    expect(await setup.broadcaster.submit({ escrow: setup.inputs.unit.escrow!, unitId: otherId,
      packageDigest: word(), compositionSchemaVersion: 1 })).toMatchObject({ code: "indeterminate" });
    setup.sentData.length = 0;
    setup.sendStates.length = 0;
    setup.operatorKey.signSubmitEvidenceTx.mockClear();
    setup.fake.send = "ok";
    setup.fake.failOnce = "eth_getTransactionCount:latest";
    expect(await finish(setup)).toMatchObject({ state: "receipt_stored" });
    expect(await states(setup)).not.toContain("submit_attempted");
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    setup.fake.latestNonce = 8;
    setup.fake.pendingNonce = 8;
    setup.advance();
    expect(await setup.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.sentData).toHaveLength(1);
    expect(setup.operatorKey.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
  });

  it("a clean beforeSend journal failure sends nothing, halts, and a restart sends exactly once", async () => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      if (args[1] === "submit_attempted") throw new Error("injected journal failure");
      await original(...args);
    });
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    expect(await states(setup)).not.toContain("submit_attempted");
    expect(setup.sentData).toHaveLength(0);
    expect(setup.operatorKey.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.sentData).toHaveLength(1);
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
  });

  it("unreconciled_transaction remains retryable, then sends once", async () => {
    const setup = await fixture();
    setup.broadcaster.submit.mockResolvedValueOnce({ code: "refused", reason: "unreconciled_transaction" });
    expect(await finish(setup)).toMatchObject({ state: "receipt_stored" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "receipt_stored" });
    expect(await states(setup)).not.toContain("submit_attempted");
    expect(setup.logs).toContain("submit_unreconciled");
    setup.advance();
    expect(await setup.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.sentData).toHaveLength(1);
  });

  it("fee caps and unexpected pre-hook exceptions back off repeatedly without an attempt", async () => {
    const setup = await fixture();
    setup.broadcaster.submit.mockResolvedValueOnce({ code: "caps_exceeded", cap: "gasCap" })
      .mockRejectedValueOnce(new Error(setup.serverText));
    expect(await finish(setup)).toMatchObject({ state: "receipt_stored", waitMs: 5_000 });
    setup.advance(5_000);
    expect(await setup.host.runOnce()).toMatchObject({ state: "receipt_stored", waitMs: 10_000 });
    expect(await setup.host.runOnce()).toMatchObject({ kind: "idle", waitMs: 5_000 });
    expect(await states(setup)).not.toContain("submit_attempted");
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(JSON.stringify(setup.logs)).not.toContain(setup.serverText);
    setup.advance(10_000);
    expect(await setup.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.sentData).toHaveLength(1);
  });

  it("a manifest version different from the stored unit version is terminal before transaction signing", async () => {
    const setup = await fixture();
    setup.fake.storedVersion = 2;
    expect(await finish(setup)).toMatchObject({ state: "refused" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "refused", code: "submit_refused" });
    expect(await states(setup)).not.toContain("submit_attempted");
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
  });

  it("a decoded rejected send with uncommitted read-back journals terminal refusal after its attempt", async () => {
    const setup = await fixture();
    setup.fake.send = "reject_absent";
    expect(await finish(setup)).toMatchObject({ state: "refused" });
    expect((await states(setup)).slice(-2)).toEqual(["submit_attempted", "refused"]);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ code: "submit_refused" });
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(1);
  });

  it.each(["receipt_exists"] as const)("a 409 %s receipt conflict is terminal and never submits across ticks or restart", async (code) => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code, status: 409 });
    expect(await finish(setup)).toMatchObject({ state: "refused" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ code: "receipt_conflict" });
    setup.advance();
    await setup.host.runOnce();
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(setup.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
  });

  it.each(["kernel_emergency_stopped", "route_unavailable", "bad_request"] as const)(
    "a 409 %s keeps the package retryable and never submits until a successful receipt", async (code) => {
      const setup = await fixture();
      setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code, status: 409 });
      expect(await finish(setup)).toMatchObject({ state: "package_built", waitMs: 5_000 });
      expect((await setup.journal.read(jobId)).at(-1)?.state).toBe("package_built");
      expect(await states(setup)).not.toContain("refused");
      expect(await states(setup)).not.toContain("submit_attempted");
      expect(setup.broadcaster.submit).not.toHaveBeenCalled();
      expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
      expect(setup.sentData).toHaveLength(0);
      expect(setup.logs).toContain(code);
      expect(await setup.host.runOnce()).toMatchObject({ kind: "idle", waitMs: 5_000 });
      expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
      const recovered = await restart(setup);
      expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
      expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(2);
      expect(recovered.broadcaster.submit).toHaveBeenCalledTimes(1);
      expect(setup.sentData).toHaveLength(1);
      expect(await states(setup)).toEqual(completedStates);
    },
  );

  it.each(["package_built", "receipt_stored"] as const)(
    "disabled sending preserves %s across polls and e-stop checks, then submits on an enabled run", async (boundary) => {
      for (const disabled of ["no_submit", "real_mode", "caps", "broadcaster"] as const) {
        const setup = await fixture();
        const original = setup.journal.append;
        vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
          await original(...args);
          if (args[1] === boundary) throw new Error("crash after durable package");
        });
        expect(await finish(setup)).toMatchObject({ kind: "halted" });
        const before = await setup.diskRecords();
        const pkg = await setup.diskPackage();
        const receiptPosts = setup.gateway.postReceipt.mock.calls.length;
        const overrides: Partial<HostDeps> = disabled === "no_submit" ? { noSubmit: true }
          : disabled === "real_mode" ? { realMode: false }
          : disabled === "caps" ? { config: { ...setup.config, chain: { ...setup.config.chain,
            maxFeePerGasCap: undefined, maxPriorityFeePerGasCap: undefined, gasCap: undefined } } }
          : { broadcaster: undefined };
        const recovered = await restart(setup, overrides);
        setup.gateway.pollJobs.mockResolvedValueOnce({ ok: true, value: { jobs: [], stop: { proceed: false, why: "stopped" }, foreignJobsDropped: 0, truncated: false } });
        expect(await recovered.host.runOnce()).toEqual({ kind: "blocked", waitMs: 5_000 });
        expect(await recovered.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
        expect(await setup.diskRecords()).toEqual(before);
        expect(await setup.diskPackage()).toEqual(pkg);
        expect(setup.logs).toContain("submit_disabled");
        expect(setup.logs).toContain("stopped");
        expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(receiptPosts);
        expect(setup.gateway.reportInProgress).toHaveBeenCalledTimes(1);
        expect(setup.adapter.commands).toHaveLength(1);
        expect(setup.broadcaster.submit).not.toHaveBeenCalled();
        expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
        expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
        expect(setup.sentData).toHaveLength(0);
        await recovered.journal.close();
        const enabled = await restart(setup);
        expect(await enabled.host.runOnce()).toMatchObject({ state: "submitted" });
        expect(enabled.broadcaster.submit).toHaveBeenCalledTimes(1);
        expect(setup.operatorKey.signD1).toHaveBeenCalledTimes(1);
        expect(setup.deviceKey.signD2).toHaveBeenCalledTimes(1);
        expect(setup.sentData).toHaveLength(1);
        await enabled.journal.close();
      }
    },
  );

  it("--no-submit recovery does not starve a new claim on a different funded unit", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code: "kernel_emergency_stopped", status: 409 });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const before = await setup.diskRecords();
    const newJob = "job:new-funded-unit";
    const newInputs = { ...setup.inputs, unit: { ...setup.inputs.unit, settlementUnitId: word() } };
    setup.inputSource.mockResolvedValue({ ok: true, value: newInputs });
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { jobs: [{ jobId: newJob, status: "queued", funding: setup.funding }], stop: { proceed: true }, foreignJobsDropped: 0, truncated: false } });
    const print = vi.fn(async () => ({ success: false, events: [], durationMs: 0 }));
    const recovered = await restart(setup, { noSubmit: true, print });
    expect(await recovered.host.runOnce()).toMatchObject({ jobId: newJob, state: "print_failed" });
    expect(setup.gateway.reportInProgress).toHaveBeenCalledWith(newJob);
    expect(print).toHaveBeenCalledTimes(1);
    expect(await setup.diskRecords()).toEqual(before);
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    await recovered.journal.close();
  });

  it.each(["chainId", "escrow", "settlementUnitId", "packageDigest"] as const)("a receipt with mismatched %s is terminal and never submits", async (field) => {
    const setup = await fixture();
    const receipt = setup.receiptValue();
    const original = setup.gateway.postReceipt.getMockImplementation()!;
    setup.gateway.postReceipt.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (!result.ok) throw new Error("fixture");
      return { ok: true, value: { ...result.value, receipt: { ...result.value.receipt,
        [field]: field === "chainId" ? 31338 : field === "escrow" ? getAddress(toHex(randomBytes(20))).toLowerCase() : receipt.receiptDigest } } };
    });
    expect(await finish(setup)).toMatchObject({ state: "refused" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ code: "receipt_mismatch" });
    expect(setup.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    expect(await states(setup)).not.toContain("receipt_stored");
  });

  it("a 503 receipt signer outage retries a 200, then sends exactly once", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code: "receipt_signer_unavailable", status: 503 });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "package_built" });
    expect(setup.broadcaster.submit).not.toHaveBeenCalled();
    expect(await setup.host.runOnce()).toMatchObject({ kind: "idle", waitMs: 5_000 });
    setup.advance();
    expect(await setup.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(2);
    expect(setup.sentData).toHaveLength(1);
    expect(await states(setup)).toEqual(completedStates);
  });

  it.each(["save", "record"] as const)("a crash after successful receipt POST before durable %s re-POSTs and sends exactly once", async (point) => {
    const setup = await fixture();
    if (point === "save") vi.spyOn(setup.journal, "saveReceipt").mockRejectedValueOnce(new Error("crash"));
    else {
      const original = setup.journal.append.bind(setup.journal);
      vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
        if (args[1] === "receipt_stored") throw new Error("crash");
        await original(...args);
      });
    }
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    expect((await states(setup)).at(-1)).toBe("package_built");
    expect(setup.sentData).toHaveLength(0);
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(2);
    expect(setup.sentData).toHaveLength(1);
  });

  it("a crash after receipt_stored restarts without POST and sends exactly once", async () => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === "receipt_stored") throw new Error("crash");
    });
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(setup.sentData).toHaveLength(1);
  });

  it.each(["missing", "malformed", "mismatch"] as const)("a %s stored receipt halts without submitting", async (damage) => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === "receipt_stored") throw new Error("crash");
    });
    await finish(setup);
    if (damage === "missing") await unlink(setup.journal.receiptPath(jobId));
    else {
      const value = await setup.journal.readReceipt(jobId);
      await writeFile(setup.journal.receiptPath(jobId), damage === "malformed" ? '{"receipt":' : JSON.stringify({ ...value,
        receipt: { ...value!.receipt, packageDigest: word() } }));
    }
    const recovered = await restart(setup);
    const records = await setup.diskRecords();
    expect(await recovered.host.runOnce()).toMatchObject({ kind: "halted" });
    expect(await setup.diskRecords()).toEqual(records);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(setup.sentData).toHaveLength(0);
  });
});

describe("restart artifact and recovery guards", () => {
  it("an unavailable input source after evidence storage retries without package_inputs_missing (P3)", async () => {
    const setup = await fixture();
    vi.spyOn(setup.journal, "savePackage").mockRejectedValueOnce(new Error("crash"));
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    expect((await states(setup)).at(-1)).toBe("evidence_stored");
    const recovered = await restart(setup, { inputSource: async () => ({ ok: false, code: "job_inputs_not_found" }) });
    expect(await recovered.host.runOnce()).toMatchObject({ state: "evidence_stored" });
    expect((await setup.diskRecords()).at(-1)).toMatchObject({ state: "evidence_stored" });
    expect((await setup.diskRecords()).at(-1)?.code).toBeUndefined();
    expect(setup.logs).toContain("job_inputs_not_found");
    await recovered.journal.close();
    const healthy = await restart(setup);
    expect(await healthy.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.sentData).toHaveLength(1);
  });

  it("a partial leftover temporary package never blocks restart, which saves and sends once (P5)", async () => {
    const setup = await fixture();
    vi.spyOn(setup.journal, "savePackage").mockRejectedValueOnce(new Error("crash"));
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    await writeFile(`${setup.journal.packagePath(jobId)}.tmp-orphan`, '{"body":', { mode: 0o600 });
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.sentData).toHaveLength(1);
    expect(await recovered.journal.readPackage(jobId)).toBeDefined();
  });

  it("read-back for indeterminate A precedes package-built B and never submits B (RV1)", async () => {
    const setup = await fixture();
    setup.fake.send = "throw_absent";
    await finish(setup);
    const otherJob = "a:package-built";
    const pkg = await setup.diskPackage();
    await setup.journal.append(otherJob, "evidence_stored");
    await setup.journal.savePackage(otherJob, pkg);
    await setup.journal.append(otherJob, "package_built", undefined, {
      packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ jobId, state: "submit_indeterminate" });
    expect(recovered.broadcaster.readBack).toHaveBeenCalledTimes(1);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(setup.sentData).toHaveLength(1);
  });

  it.each(["package_built", "submit_attempted"] as const)("a missing package after %s halts without a new journal line (RV2)", async (boundary) => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === boundary) throw new Error("crash");
    });
    await finish(setup);
    await unlink(setup.journal.packagePath(jobId));
    const before = await setup.diskRecords();
    const recovered = await restart(setup, { inputSource: async () => ({ ok: true, value: { ...setup.inputs, program: undefined } }) });
    expect(await recovered.host.runOnce()).toMatchObject({ kind: "halted" });
    expect(await setup.diskRecords()).toEqual(before);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.readBack).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
  });

  it("a valid persisted package differing from package_built hashes halts (RV3)", async () => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === "package_built") throw new Error("crash");
    });
    await finish(setup);
    const pkg = await setup.diskPackage();
    pkg.signatures[0]!.sig = toHex(randomBytes(65));
    pkg.packageDigest = computePackageDigest(pkg.body, pkg.signatures);
    await writeFile(setup.journal.packagePath(jobId), JSON.stringify(pkg));
    const before = await setup.diskRecords();
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ kind: "halted" });
    expect(await setup.diskRecords()).toEqual(before);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
  });
});

describe("r5d evidence hold-and-retry (R3)", () => {
  it("R3 probe H: one stored-nothing 503, then a stored 200, ends evidence_stored after exactly 2 POSTs and 1 print", async () => {
    const setup = await fixture({ caps: false });
    setup.gateway.postRelayEvidence.mockResolvedValueOnce({ ok: false, code: "unavailable", status: 503 });
    const { waits, timers } = evidenceHoldTimers(setup);
    setup.host = createHost({ ...setup.deps, timers });
    expect(await finish(setup)).toMatchObject({ kind: "job", jobId, state: "evidence_stored" });
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(2);
    expect(setup.gateway.postRelayEvidence.mock.calls[0][1]).toBe(setup.gateway.postRelayEvidence.mock.calls[1][1]);
    expect(waits).toEqual([5_000]);
    expect(await states(setup)).toEqual(["claimed", "in_progress_reported", "printing", "printed", "bundle_saved", "evidence_stored"]);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
    expect(setup.adapter.commands.map((command) => command.type)).toEqual(["start"]);
    expect(setup.logs.filter((code) => code === "unavailable")).toHaveLength(1);
  });

  it("R3: five stored-nothing refusals post the same bundle five times on the 5, 20, 60 and 120 s schedule, then end evidence_refused with the last code", async () => {
    const setup = await fixture();
    setup.gateway.postRelayEvidence.mockResolvedValueOnce({ ok: false, code: "server_error", status: 500 })
      .mockResolvedValueOnce({ ok: false, code: "server_error", status: 500 })
      .mockResolvedValueOnce({ ok: false, code: "server_error", status: 500 })
      .mockResolvedValueOnce({ ok: false, code: "server_error", status: 500 })
      .mockResolvedValueOnce({ ok: false, code: "unavailable", status: 503 });
    const { waits, timers } = evidenceHoldTimers(setup);
    setup.host = createHost({ ...setup.deps, timers });
    expect(await finish(setup)).toMatchObject({ kind: "job", jobId, state: "evidence_refused" });
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(5);
    const posted = setup.gateway.postRelayEvidence.mock.calls[0][1];
    for (const [, bundle] of setup.gateway.postRelayEvidence.mock.calls) expect(bundle).toBe(posted);
    expect(posted).toEqual(await setup.journal.readBundle(jobId));
    expect(waits).toEqual([5_000, 20_000, 60_000, 120_000]);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_refused", code: "unavailable" });
    expect(await states(setup)).not.toContain("evidence_stored");
    expect(setup.logs.filter((code) => code === "server_error")).toHaveLength(4);
    expect(setup.logs.filter((code) => code === "unavailable")).toHaveLength(1);
    noSubmitSignatures(setup);
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(5);
  });

  it.each([[2, 5_000], [90, 90_000], [3_600, 300_000]] as const)(
    "R3: a 429 with Retry-After %i s waits %i ms before the one re-post", async (retryAfterS, expected) => {
      const setup = await fixture({ caps: false });
      setup.gateway.postRelayEvidence.mockResolvedValueOnce({ ok: false, code: "rate_limited", status: 429, retryAfterS });
      const { waits, timers } = evidenceHoldTimers(setup);
      setup.host = createHost({ ...setup.deps, timers });
      expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
      expect(waits).toEqual([expected]);
      expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(2);
      expect(setup.logs.filter((code) => code === "rate_limited")).toHaveLength(1);
    },
  );

  it.each(["run", "stopSignal"] as const)(
    "R3: a host stop through %s ends the evidence hold with no new record, and a restart never re-posts", async (stopMode) => {
      const setup = await fixture();
      const stop = new AbortController();
      setup.gateway.postRelayEvidence.mockResolvedValueOnce({ ok: false, code: "unavailable", status: 503 });
      const { waits, timers } = evidenceHoldTimers(setup, { fire: false, onWait: () => stop.abort() });
      setup.host = createHost({ ...setup.deps, timers, ...(stopMode === "stopSignal" ? { stopSignal: stop.signal } : {}) });
      if (stopMode === "stopSignal") {
        expect(await finish(setup)).toEqual({ kind: "blocked", jobId, waitMs: 5_000 });
      } else {
        setup.adapter.scriptStart({ outcome: "success", jobId: 101 });
        const started = setup.adapter.started();
        const running = setup.host.run(stop.signal);
        await started;
        setup.adapter.emit("execution_started", { ippJobId: 101 });
        setup.adapter.emit("execution_completed", { ippJobId: 101, totalPages: 2 });
        await running;
      }
      expect(waits).toEqual([5_000]);
      expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
      expect((await setup.journal.read(jobId)).at(-1)?.state).toBe("bundle_saved");
      const recovered = await restart(setup);
      await recovered.host.runOnce();
      await recovered.host.runOnce();
      expect((await recovered.journal.read(jobId)).map((r) => r.state).slice(-2)).toEqual(["bundle_saved", "interrupted"]);
      expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
      noSubmitSignatures(setup);
    },
  );

  it.each(["run", "stopSignal"] as const)(
    "R3 round 2: an asynchronous host stop through %s clears a pending evidence timer before it fires, and a restart never re-posts", async (stopMode) => {
      const setup = await fixture();
      const stop = new AbortController();
      setup.gateway.postRelayEvidence.mockResolvedValueOnce({ ok: false, code: "unavailable", status: 503 });
      const waits: number[] = [];
      const holdHandle = {};
      const clearHold = vi.fn();
      let fireHold: (() => void) | undefined;
      let timerFired = false;
      let reachedHold!: () => void;
      const holdStarted = new Promise<void>((resolve) => { reachedHold = resolve; });
      const timers: HostTimers = {
        setTimeout(callback, ms) {
          if (setup.gateway.postRelayEvidence.mock.calls.length === 0) return setTimeout(callback, ms);
          waits.push(ms);
          fireHold = () => { timerFired = true; callback(); };
          reachedHold();
          return holdHandle;
        },
        clearTimeout(handle) {
          if (handle === holdHandle) clearHold();
          else if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      };
      setup.host = createHost({ ...setup.deps, timers, ...(stopMode === "stopSignal" ? { stopSignal: stop.signal } : {}) });
      setup.adapter.scriptStart({ outcome: "success", jobId: 101 });
      const started = setup.adapter.started();
      const running = stopMode === "run" ? setup.host.run(stop.signal) : setup.host.runOnce();
      try {
        await started;
        setup.adapter.emit("execution_started", { ippJobId: 101 });
        setup.adapter.emit("execution_completed", { ippJobId: 101, totalPages: 2 });
        // Resuming here happens after setTimeout returns and the synchronous
        // stopped check has run; only the pending hold's abort can release it.
        await holdStarted;
        expect(waits).toEqual([5_000]);
        expect(stop.signal.aborted).toBe(false);
        expect(clearHold).not.toHaveBeenCalled();
        const before = await setup.diskRecords();
        expect(before.at(-1)?.state).toBe("bundle_saved");
        stop.abort();
        expect(clearHold).toHaveBeenCalledTimes(1);
        expect(timerFired).toBe(false);
        if (stopMode === "stopSignal") {
          expect(await running).toEqual({ kind: "blocked", jobId, waitMs: 5_000 });
        } else await running;
        expect(timerFired).toBe(false);
        expect(await setup.diskRecords()).toEqual(before);
        expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
      } finally {
        stop.abort();
        // Drain a mutant that failed to abort the hold after the assertion
        // above has failed, without leaving the run pending until test timeout.
        if (clearHold.mock.calls.length === 0) fireHold?.();
        await running;
      }
      const recovered = await restart(setup);
      await recovered.host.runOnce();
      await recovered.host.runOnce();
      expect((await recovered.journal.read(jobId)).map((r) => r.state).slice(-2)).toEqual(["bundle_saved", "interrupted"]);
      expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
      noSubmitSignatures(setup);
    },
  );

  it.each([
    ["indeterminate", 503, "evidence_indeterminate"],
    ["operator_proof_required", 403, "evidence_refused"],
    ["not_stored", 200, "evidence_refused"],
  ] as const)("R3: a %s evidence reply is posted exactly once and never held", async (code, status, state) => {
    const setup = await fixture();
    setup.gateway.postRelayEvidence.mockResolvedValue({ ok: false, code, status });
    const { waits, timers } = evidenceHoldTimers(setup);
    setup.host = createHost({ ...setup.deps, timers });
    expect(await finish(setup)).toMatchObject({ state });
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect((await setup.journal.read(jobId)).at(-1)?.state).toBe(state);
  });
});

describe("r5d receipt refusals and non-blocking recovery (R4, A3)", () => {
  it.each([
    ["receipt_kernel_mismatch", 409, undefined, "receipt_kernel_mismatch"],
    ["receipt_refused", 400, "invalid_package_body", "receipt_invalid_package_body"],
    ["receipt_refused", 422, "invalid_package_signatures", "receipt_invalid_package_signatures"],
    ["receipt_refused", 400, "invalid_settlement_unit", "receipt_invalid_settlement_unit"],
  ] as const)("R4/A3: a receipt %s %s is terminal refused/%s, never submits, and the next tick polls", async (code, status, sub, journalCode) => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code, status, ...(sub === undefined ? {} : { sub }) });
    expect(await finish(setup)).toMatchObject({ state: "refused" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "refused", code: journalCode });
    const polls = setup.gateway.pollJobs.mock.calls.length;
    setup.advance();
    expect(await setup.host.runOnce()).toMatchObject({ kind: "idle", waitMs: 5_000 });
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls + 1);
    const recovered = await restart(setup);
    await recovered.host.runOnce();
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(1);
    expect(setup.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toEqual([]);
  });

  it.each([
    [404, "job_not_found"], [422, "package_challenge_refused"], [422, "package_registry_refused"],
    [422, "package_operator_refused"], [503, "receipt_storage_unavailable"],
  ] as const)("A3: a receipt %s %s keeps the package retryable under its own log code, then submits after a successful receipt", async (status, sub) => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code: "receipt_refused", status, sub });
    expect(await finish(setup)).toMatchObject({ state: "package_built", waitMs: 5_000 });
    expect(setup.logs).toContain(sub);
    expect(setup.logs).not.toContain("route_unavailable");
    expect(setup.logs).not.toContain("malformed_response");
    expect(await states(setup)).not.toContain("refused");
    expect(setup.broadcaster.submit).not.toHaveBeenCalled();
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(2);
    expect(setup.sentData).toHaveLength(1);
    expect(await states(setup)).toEqual(completedStates);
  });

  it("A3 (r5a P2 flipped): a persistent 422 package_challenge_refused retries under its own code while every backing-off tick polls", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValue({ ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const before = await setup.diskRecords();
    const polls = setup.gateway.pollJobs.mock.calls.length;
    for (let tick = 0; tick < 20; tick++) {
      setup.advance(1_000);
      await setup.host.runOnce();
    }
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(3);
    expect(setup.gateway.pollJobs.mock.calls.length - polls).toBe(18);
    expect(setup.logs.filter((code) => code === "package_challenge_refused")).toHaveLength(3);
    expect(setup.logs).not.toContain("route_unavailable");
    expect(await setup.diskRecords()).toEqual(before);
    expect(setup.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toEqual([]);
  });

  it("A3: a crash-window evidence_stored unit whose inputs are not found keeps retrying while every backing-off tick polls", async () => {
    const setup = await fixture();
    vi.spyOn(setup.journal, "savePackage").mockRejectedValueOnce(new Error("crash"));
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_stored" });
    const inputSource = vi.fn<Parameters<HostDeps["inputSource"]>, ReturnType<HostDeps["inputSource"]>>(
      async () => ({ ok: false, code: "job_inputs_not_found" }));
    const recovered = await restart(setup, { inputSource });
    const before = await setup.diskRecords();
    const polls = setup.gateway.pollJobs.mock.calls.length;
    for (let tick = 0; tick < 20; tick++) {
      setup.advance(1_000);
      await recovered.host.runOnce();
    }
    expect(inputSource).toHaveBeenCalledTimes(3);
    expect(setup.gateway.pollJobs.mock.calls.length - polls).toBe(17);
    expect(setup.logs.filter((code) => code === "job_inputs_not_found")).toHaveLength(3);
    expect(await setup.diskRecords()).toEqual(before);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toEqual([]);
  });

  it("A3: a submit_attempted unit still blocks polling and claiming on every tick", async () => {
    const setup = await fixture();
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === "submit_attempted") throw new Error("crash");
    });
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    const recovered = await restart(setup);
    const polls = setup.gateway.pollJobs.mock.calls.length;
    for (let tick = 0; tick < 3; tick++) {
      setup.advance(1_000);
      expect(await recovered.host.runOnce()).toMatchObject({ kind: "job", jobId, state: "submit_indeterminate" });
    }
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls);
    expect(recovered.broadcaster.readBack).toHaveBeenCalledTimes(3);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
  });

  it("A3: a persistent caps_exceeded still stalls polling and claiming on every backing-off tick, and retries once per backoff", async () => {
    const setup = await fixture();
    setup.broadcaster.submit.mockResolvedValue({ code: "caps_exceeded", cap: "gasCap" });
    expect(await finish(setup)).toMatchObject({ state: "receipt_stored", waitMs: 5_000 });
    const before = await setup.diskRecords();
    const polls = setup.gateway.pollJobs.mock.calls.length;
    setup.advance(1_000);
    expect(await setup.host.runOnce()).toEqual({ kind: "backoff", jobId, waitMs: 4_000 });
    for (let tick = 0; tick < 19; tick++) {
      setup.advance(1_000);
      await setup.host.runOnce();
    }
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls);
    expect(setup.broadcaster.submit).toHaveBeenCalledTimes(3);
    expect(setup.logs.filter((code) => code === "submit_caps_exceeded")).toHaveLength(3);
    expect(await setup.diskRecords()).toEqual(before);
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.sentData).toEqual([]);
  });

  it("A3: while the first recovered unit backs off on a refusal that never passes, the next ready unit gets its attempt and is submitted", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code: "unavailable", status: 503 });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const otherJob = "a:package-built";
    const pkg = await setup.diskPackage();
    await setup.journal.append(otherJob, "claimed", undefined, { funding: setup.gatewayClaim });
    await setup.journal.append(otherJob, "evidence_stored");
    await setup.journal.savePackage(otherJob, pkg);
    await setup.journal.append(otherJob, "package_built", undefined, {
      packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    const original = setup.gateway.postReceipt.getMockImplementation()!;
    let mainRetries = 0;
    setup.gateway.postReceipt.mockImplementation(async (...args) => {
      const [id] = args;
      if (id === otherJob) return { ok: false as const, code: "receipt_refused" as const, status: 422, sub: "package_challenge_refused" as const };
      if (id === jobId && mainRetries++ === 0) return { ok: false as const, code: "unavailable" as const, status: 503 };
      return original(...args);
    });
    const recovered = await restart(setup);
    for (let tick = 0; tick < 10; tick++) {
      setup.advance(1_000);
      await recovered.host.runOnce();
    }
    expect(await states(setup)).toEqual(completedStates);
    expect(setup.sentData).toHaveLength(1);
    expect((await recovered.journal.read(otherJob)).map((entry) => entry.state)).toEqual(["claimed", "evidence_stored", "package_built"]);
    expect(setup.gateway.postReceipt.mock.calls.filter(([id]) => id === otherJob)).toHaveLength(2);
    expect(setup.gateway.postReceipt.mock.calls.filter(([id]) => id === jobId)).toHaveLength(3);
    expect(recovered.broadcaster.submit).toHaveBeenCalledTimes(1);
    expect(setup.logs).toContain("package_challenge_refused");
  });
});

describe("rehearsal envelope and restart promises (r5d F3)", () => {
  it("P1 a rehearsal relays an unsigned tagged envelope, never delegates, and journals only a public open record", async () => {
    const setup = await fixture({ simulated: true, realMode: false });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    const posted = setup.gateway.postRelayEvidence.mock.calls[0][1];
    expect(Object.keys(posted).sort()).toEqual(["bundleHash", "events"]);
    expect(posted.events.length).toBeGreaterThan(0);
    expect(posted.events.every((event) => event.source.simulated === true)).toBe(true);
    expect(posted.bundleHash).toBe(await hashBundle(posted.events));
    expect(await setup.journal.readBundle(jobId)).toEqual(posted);
    expect(setup.deviceKey.signDelegation).not.toHaveBeenCalled();
    noSubmitSignatures(setup);
    const dir = setup.journal.sessionDirectory(jobId);
    const files = await readdir(dir);
    expect(files).toEqual(["00000000.json"]);
    const record = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
    expect(record.record.kind).toBe("open");
    expect(Object.keys(record.record.binding).sort()).toEqual(
      ["challengeNonce", "devicePublicKey", "expiresAt", "fundedAt", "jobId", "parentAgentId", "settlementUnitId"]);
  });

  it("P2 a later real-mode sending run never packages, posts a receipt for, reads back or submits the rehearsal unit", async () => {
    const setup = await fixture({ simulated: true, realMode: false });
    await finish(setup);
    const before = await setup.journal.read(jobId);
    expect(before.at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
    setup.adapter.source.simulated = false;
    const recovered = await restart(setup, { realMode: true });
    expect(await recovered.host.runOnce()).toMatchObject({ kind: "idle" });
    expect(await recovered.host.runOnce()).toMatchObject({ kind: "idle" });
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.readBack).not.toHaveBeenCalled();
    expect(setup.gateway.postReceipt).not.toHaveBeenCalled();
    expect(setup.operatorKey.signD1).not.toHaveBeenCalled();
    expect(setup.inputSource).toHaveBeenCalledTimes(1);
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(1);
    expect(await recovered.journal.read(jobId)).toEqual(before);
  });

  it("P2b an unfinalized rehearsal session does not block a later job on another unit in a real-mode restart", async () => {
    const setup = await fixture({ simulated: true, realMode: false });
    await finish(setup);
    const before = await setup.journal.read(jobId);
    const sessionFiles = await readdir(setup.journal.sessionDirectory(jobId));
    const newJob = "job:after-rehearsal";
    const newInputs = { ...setup.inputs, unit: { ...setup.inputs.unit, settlementUnitId: word() } };
    setup.inputSource.mockResolvedValue({ ok: true, value: newInputs });
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { jobs: [{ jobId: newJob, status: "queued", funding: setup.funding }], stop: { proceed: true }, foreignJobsDropped: 0, truncated: false } });
    const print = vi.fn(async () => ({ success: false, events: [], durationMs: 0 }));
    setup.adapter.source.simulated = false;
    const recovered = await restart(setup, { realMode: true, print });
    expect(await recovered.host.runOnce()).toMatchObject({ jobId: newJob, state: "print_failed" });
    expect(print).toHaveBeenCalledTimes(1);
    expect(await recovered.journal.read(jobId)).toEqual(before);
    expect(await readdir(recovered.journal.sessionDirectory(jobId))).toEqual(sessionFiles);
    expect((await readdir(recovered.journal.sessionDirectory(newJob))).length).toBe(1);
  });

  it.each([true, false])("P3 a rehearsal lost after bundle_saved is interrupted on restart (realMode %s) and never re-posted or submitted", async (realMode) => {
    const setup = await fixture({ simulated: true, realMode: false });
    const original = setup.journal.append.bind(setup.journal);
    vi.spyOn(setup.journal, "append").mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === "bundle_saved") throw new Error("simulated process loss");
    });
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    expect((await states(setup)).at(-1)).toBe("bundle_saved");
    if (realMode) setup.adapter.source.simulated = false;
    const recovered = await restart(setup, { realMode });
    await recovered.host.runOnce();
    await recovered.host.runOnce();
    expect((await recovered.journal.read(jobId)).map((r) => r.state).slice(-2)).toEqual(["bundle_saved", "interrupted"]);
    expect(setup.gateway.postRelayEvidence).not.toHaveBeenCalled();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.readBack).not.toHaveBeenCalled();
    expect(setup.operatorKey.signD1).not.toHaveBeenCalled();
  });
});

describe("REVIEW A3 liveness under run() (repro)", () => {
  it("four recovered units on a retried refusal still let run() poll, and each unit gets attempts", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValue({ ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const pkg = await setup.diskPackage();
    const stuck = ["a1:package-built", "a2:package-built", "a3:package-built", jobId];
    for (const other of stuck.slice(0, 3)) {
      await setup.journal.append(other, "claimed", undefined, { funding: setup.gatewayClaim });
      await setup.journal.append(other, "evidence_stored");
      await setup.journal.savePackage(other, pkg);
      await setup.journal.append(other, "package_built", undefined, { packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    }
    // Each gateway call takes simulated time; run()'s waits advance the frozen clock.
    setup.gateway.postReceipt.mockImplementation(async () => {
      setup.advance(200);
      return { ok: false as const, code: "receipt_refused" as const, status: 422, sub: "package_challenge_refused" as const };
    });
    setup.gateway.heartbeat.mockImplementation(async () => { setup.advance(50); return { ok: true as const, value: null }; });
    const start = setup.deps.clock!();
    const pollTimes: number[] = [];
    setup.gateway.pollJobs.mockImplementation(async () => {
      pollTimes.push(setup.deps.clock!() - start);
      setup.advance(100);
      return { ok: true, value: { stop: { proceed: true }, jobs: [{ jobId, status: "queued" }], foreignJobsDropped: 0, truncated: false } };
    });
    const stop = new AbortController();
    const timers: HostTimers = {
      setTimeout(callback, ms) {
        setup.advance(ms + 1);
        if (setup.deps.clock!() - start >= 30 * 60_000) stop.abort();
        return setTimeout(callback, 0);
      },
      clearTimeout(handle) { if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>); },
    };
    const recovered = await restart(setup, { timers });
    const before = setup.gateway.postReceipt.mock.calls.length;
    await recovered.host.run(stop.signal);
    const attempted = setup.gateway.postReceipt.mock.calls.slice(before).map(([id]) => id);
    expect(pollTimes.filter((t) => t >= 20 * 60_000).length).toBeGreaterThan(0);
    for (const id of stuck) expect(attempted.filter((x) => x === id).length).toBeGreaterThan(0);
  });

  it.each([2, 3, 5, 6])("round 3: run() keeps polling and shares retries across %i stuck units", async (count) => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValue({ ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const pkg = await setup.diskPackage();
    const stuck = [...Array.from({ length: count - 1 }, (_, index) => `a${index}:package-built`), jobId];
    for (const other of stuck.slice(0, -1)) {
      await setup.journal.append(other, "claimed", undefined, { funding: setup.gatewayClaim });
      await setup.journal.append(other, "evidence_stored");
      await setup.journal.savePackage(other, pkg);
      await setup.journal.append(other, "package_built", undefined, { packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    }
    const start = setup.deps.clock!();
    const attempts: Array<{ id: string; at: number }> = [];
    setup.gateway.postReceipt.mockImplementation(async (id) => {
      attempts.push({ id, at: setup.deps.clock!() - start });
      setup.advance(200);
      return { ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" };
    });
    setup.gateway.heartbeat.mockImplementation(async () => { setup.advance(50); return { ok: true, value: null }; });
    const pollTimes: number[] = [];
    setup.gateway.pollJobs.mockImplementation(async () => {
      pollTimes.push(setup.deps.clock!() - start);
      setup.advance(100);
      return { ok: true, value: { stop: { proceed: true }, jobs: [{ jobId, status: "queued" }], foreignJobsDropped: 0, truncated: false } };
    });
    const stop = new AbortController();
    const timers: HostTimers = {
      setTimeout(callback, ms) {
        setup.advance(ms + 1);
        if (setup.deps.clock!() - start >= 30 * 60_000) stop.abort();
        return setTimeout(callback, 0);
      },
      clearTimeout(handle) { if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>); },
    };
    const recovered = await restart(setup, { timers });
    await recovered.host.run(stop.signal);
    expect(pollTimes.filter((at) => at >= 20 * 60_000).length).toBeGreaterThan(0);
    const counts = stuck.map((id) => attempts.filter((attempt) => attempt.id === id && attempt.at >= 20 * 60_000).length);
    for (const attempts of counts) expect(attempts).toBeGreaterThan(0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(setup.sentData).toEqual([]);
  });

  it("round 3: ready recovery prefers the oldest retry time, with never-attempted units first", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValue({ ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const pkg = await setup.diskPackage();
    async function addRecovery(id: string) {
      await setup.journal.append(id, "claimed", undefined, { funding: setup.gatewayClaim });
      await setup.journal.append(id, "evidence_stored");
      await setup.journal.savePackage(id, pkg);
      await setup.journal.append(id, "package_built", undefined, { packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    }
    await addRecovery("a:package-built");
    setup.advance(1_000);
    expect(await setup.host.runOnce()).toMatchObject({ jobId: "a:package-built", state: "package_built" });
    setup.advance(5_000);
    expect(await setup.host.runOnce()).toMatchObject({ kind: "idle" });
    // Both are ready: jobId's retry was due at +5 s, the earlier journal's at +6 s.
    expect(await setup.host.runOnce()).toMatchObject({ jobId, state: "package_built" });
    await addRecovery("z:package-built");
    expect(await setup.host.runOnce()).toMatchObject({ kind: "idle" });
    expect(await setup.host.runOnce()).toMatchObject({ jobId: "z:package-built", state: "package_built" });
  });

  it("round 3: recovery continues during poll backoff and yields when the poll becomes due", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValue({ ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const other = "a:package-built";
    const pkg = await setup.diskPackage();
    await setup.journal.append(other, "claimed", undefined, { funding: setup.gatewayClaim });
    await setup.journal.append(other, "evidence_stored");
    await setup.journal.savePackage(other, pkg);
    await setup.journal.append(other, "package_built", undefined, { packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    setup.advance(1_000);
    expect(await setup.host.runOnce()).toMatchObject({ jobId: other, state: "package_built" });
    setup.gateway.pollJobs.mockResolvedValueOnce({ ok: false, code: "rate_limited", status: 429, retryAfterS: 60 });
    expect(await setup.host.runOnce()).toEqual({ kind: "backoff", waitMs: 60_000 });
    const polls = setup.gateway.pollJobs.mock.calls.length;
    setup.advance(5_000);
    expect(await setup.host.runOnce()).toMatchObject({ jobId, state: "package_built" });
    expect(await setup.host.runOnce()).toMatchObject({ jobId: other, state: "package_built" });
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls);
    setup.advance(55_000);
    expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls + 1);
  });
});

describe("REVIEW r3 caps stall under run()", () => {
  it.each([0, 2])("a persistent caps_exceeded keeps run() from polling, with %i recovered refusal units", async (others) => {
    const setup = await fixture();
    let sim = false;
    let start = 0;
    const stop = new AbortController();
    const timers: HostTimers = {
      setTimeout(callback, ms) {
        if (!sim) return setTimeout(callback, ms);
        setup.advance(ms + 1);
        if (setup.deps.clock!() - start >= 10 * 60_000) stop.abort();
        return setTimeout(callback, 0);
      },
      clearTimeout(handle) { if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>); },
    };
    setup.host = createHost({ ...setup.deps, timers });
    setup.broadcaster.submit.mockResolvedValue({ code: "caps_exceeded", cap: "gasCap" });
    expect(await finish(setup)).toMatchObject({ state: "receipt_stored", waitMs: 5_000 });
    const pkg = await setup.diskPackage();
    for (let i = 0; i < others; i++) {
      const other = `a${i}:package-built`;
      await setup.journal.append(other, "claimed", undefined, { funding: setup.gatewayClaim });
      await setup.journal.append(other, "evidence_stored");
      await setup.journal.savePackage(other, pkg);
      await setup.journal.append(other, "package_built", undefined, { packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    }
    setup.gateway.postReceipt.mockResolvedValue({ ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" });
    const polls = setup.gateway.pollJobs.mock.calls.length;
    const submits = setup.broadcaster.submit.mock.calls.length;
    start = setup.deps.clock!();
    sim = true;
    await setup.host.run(stop.signal);
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls);
    expect(setup.broadcaster.submit.mock.calls.length - submits).toBeGreaterThan(1);
    expect(setup.sentData).toEqual([]);
  });

  it("other recovered units keep their retries during a caps stall", async () => {
    const setup = await fixture();
    let sim = false;
    let start = 0;
    const stop = new AbortController();
    const timers: HostTimers = {
      setTimeout(callback, ms) {
        if (!sim) return setTimeout(callback, ms);
        setup.advance(ms + 1);
        if (setup.deps.clock!() - start >= 10 * 60_000) stop.abort();
        return setTimeout(callback, 0);
      },
      clearTimeout(handle) { if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>); },
    };
    setup.host = createHost({ ...setup.deps, timers });
    setup.broadcaster.submit.mockResolvedValue({ code: "caps_exceeded", cap: "gasCap" });
    expect(await finish(setup)).toMatchObject({ state: "receipt_stored", waitMs: 5_000 });
    const pkg = await setup.diskPackage();
    const others = ["a0:package-built", "a1:package-built"];
    for (const other of others) {
      await setup.journal.append(other, "claimed", undefined, { funding: setup.gatewayClaim });
      await setup.journal.append(other, "evidence_stored");
      await setup.journal.savePackage(other, pkg);
      await setup.journal.append(other, "package_built", undefined, { packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    }
    setup.gateway.postReceipt.mockResolvedValue({ ok: false, code: "receipt_refused", status: 422, sub: "package_challenge_refused" });
    const polls = setup.gateway.pollJobs.mock.calls.length;
    const submits = setup.broadcaster.submit.mock.calls.length;
    const receiptPosts = others.map((other) => setup.gateway.postReceipt.mock.calls.filter(([id]) => id === other).length);
    start = setup.deps.clock!();
    sim = true;
    await setup.host.run(stop.signal);
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls);
    // The capped unit keeps its own retry cadence: 12 retries in these 10 minutes.
    expect(setup.broadcaster.submit.mock.calls.length - submits).toBeGreaterThanOrEqual(10);
    for (const [index, other] of others.entries()) {
      expect(setup.gateway.postReceipt.mock.calls.filter(([id]) => id === other).length - receiptPosts[index]).toBeGreaterThanOrEqual(3);
    }
    expect(setup.sentData).toEqual([]);
  });
});

describe("CODE #41 gateway funding (D2-D6, D4, A1)", () => {
  it.each(["absent", "equal"] as const)(
    "gateway mode claims a verified job whose manifest fundedAt is %s and opens the session at the verified fundedAt", async (manifestTime) => {
      const setup = await fixture();
      if (manifestTime === "absent") {
        const { fundedAt: _fundedAt, ...unit } = setup.inputs.unit;
        setup.inputSource.mockResolvedValue({ ok: true, value: { ...setup.inputs, unit } });
      }
      expect(await finish(setup)).toMatchObject({ state: "submitted" });
      const claim = { at: "2026-10-13T12:00:00.000Z", jobId, state: "claimed", funding: setup.gatewayClaim };
      expect((await setup.journal.read(jobId))[0]).toEqual(claim);
      expect((await setup.diskRecords())[0].funding).toMatchObject({ fundingBlockNumber: "9007199254740993" });
      const open = JSON.parse(await readFile(join(setup.journal.sessionDirectory(jobId), "00000000.json"), "utf8"));
      expect(open.record.binding.fundedAt).toBe(setup.funding.fundedAt);
      expect(setup.deviceKey.signDelegation).toHaveBeenCalledTimes(1);
      expect(setup.deviceKey.signDelegation.mock.calls[0][0].fundedAt).toBe(setup.funding.fundedAt);
    },
  );

  it.each(["funding_absent", "funding_read_failed", "funding_unverified", "funding_ambiguous"] as const)(
    "gateway funding %s claims nothing, loads no inputs and journals nothing", async (code) => {
      const setup = await fixture();
      const funding = code === "funding_absent" ? {} : { funding: { ok: false as const, code } };
      setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true },
        jobs: [{ jobId, status: "queued", ...funding }], foreignJobsDropped: 0, truncated: false } });
      expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
      expect(setup.inputSource).not.toHaveBeenCalled();
      expect(setup.gateway.reportInProgress).not.toHaveBeenCalled();
      expect(await setup.journal.has(jobId)).toBe(false);
      expect(setup.logs.filter((entry) => entry === code)).toHaveLength(1);
    },
  );

  it.each([
    ["operator", "funding_operator_mismatch"],
    ["escrow", "funding_escrow_mismatch"],
    ["manifest with no unit.escrow", "funding_escrow_mismatch"],
    ["chain", "funding_chain_mismatch"],
    ["fundedAt below the protocol range", "funding_bad_time"],
    ["fundedAt at 2^32", "funding_bad_time"],
    ["fundedAt equal to reclaimAt", "funding_bad_time"],
    ["fundedAt ahead of the host clock", "funding_bad_time"],
    ["reclaimAt at or before the host clock", "unit_expired"],
    ["manifest fundedAt", "funding_mismatch"],
  ] as const)("a verified funding whose %s does not match claims nothing and reserves no unit", async (field, code) => {
    const setup = await fixture();
    const funding = { ...setup.funding };
    const inputs = { ...setup.inputs, unit: { ...setup.inputs.unit } };
    if (field === "operator") funding.operator = `0x${"1".repeat(40)}`;
    else if (field === "escrow") funding.escrowAddress = `0x${"2".repeat(40)}`;
    else if (field === "manifest with no unit.escrow") delete inputs.unit.escrow;
    else if (field === "chain") funding.chainId = 84532;
    else if (field === "fundedAt below the protocol range") funding.fundedAt = 1_599_999_999;
    else if (field === "fundedAt at 2^32") funding.fundedAt = 2 ** 32;
    else if (field === "fundedAt equal to reclaimAt") funding.fundedAt = inputs.unit.reclaimAt;
    else if (field === "fundedAt ahead of the host clock") {
      // The fake printer's events start at this fixed time.
      setup.advance(Date.UTC(2026, 9, 9) - 3_600_000 - setup.deps.clock!());
      funding.fundedAt = Math.floor(setup.deps.clock!() / 1_000) + 3_600;
      delete inputs.unit.fundedAt;
      expect(funding.fundedAt).toBeLessThan(inputs.unit.reclaimAt);
    }
    else if (field === "reclaimAt at or before the host clock") {
      inputs.unit.reclaimAt = Math.floor(setup.deps.clock!() / 1_000);
      expect(funding.fundedAt).toBeLessThan(inputs.unit.reclaimAt);
    }
    else inputs.unit.fundedAt = setup.funding.fundedAt - 1;
    setup.inputSource.mockResolvedValue({ ok: true, value: inputs });
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true },
      jobs: [{ jobId, status: "queued", funding }], foreignJobsDropped: 0, truncated: false } });
    const reserve = vi.spyOn(setup.journal, "reserveUnit");
    expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
    expect(reserve).not.toHaveBeenCalled();
    expect(setup.gateway.reportInProgress).not.toHaveBeenCalled();
    expect(await setup.journal.has(jobId)).toBe(false);
    expect(setup.logs.filter((entry) => entry === code)).toHaveLength(1);
    if (field === "reclaimAt at or before the host clock") {
      setup.advance(999);
      expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
      expect(reserve).not.toHaveBeenCalled();
      expect(setup.gateway.reportInProgress).not.toHaveBeenCalled();
      expect(await setup.journal.has(jobId)).toBe(false);
      expect(setup.logs.filter((entry) => entry === code)).toHaveLength(1);
    }
    if (field === "fundedAt ahead of the host clock") {
      setup.advance(3_599_999);
      expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
      expect(reserve).not.toHaveBeenCalled();
      expect(setup.gateway.reportInProgress).not.toHaveBeenCalled();
      expect(await setup.journal.has(jobId)).toBe(false);
      expect(setup.logs.filter((entry) => entry === code)).toHaveLength(1);
      expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(2);
      setup.advance(1);
      expect(await finish(setup)).toMatchObject({ jobId, state: "submitted" });
      expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(4);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(setup.gateway.reportInProgress).toHaveBeenCalledTimes(1);
      expect((await setup.journal.read(jobId))[0]).toMatchObject({ state: "claimed",
        funding: { ...setup.gatewayClaim, fundedAt: funding.fundedAt } });
      expect(setup.deviceKey.signDelegation.mock.calls[0][0].fundedAt).toBe(funding.fundedAt);
      expect(setup.logs.filter((entry) => entry === code)).toHaveLength(1);
    }
  });

  it("a refused job never blocks a later verified job in the same poll", async () => {
    const setup = await fixture();
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true }, jobs: [
      { jobId: "a:unfunded", status: "queued", funding: { ok: false, code: "funding_unverified" } },
      { jobId, status: "queued", funding: setup.funding },
    ], foreignJobsDropped: 0, truncated: false } });
    expect(await finish(setup)).toMatchObject({ jobId, state: "submitted" });
    expect(await setup.journal.has("a:unfunded")).toBe(false);
    expect(setup.inputSource).toHaveBeenCalledTimes(1);
    expect(setup.inputSource).toHaveBeenCalledWith(jobId);
    expect(setup.logs.filter((entry) => entry === "funding_unverified")).toHaveLength(1);
  });

  it("logs each job's funding code once until it changes, and again after the job leaves the queued list", async () => {
    const setup = await fixture();
    const a = (code: "funding_unverified" | "funding_read_failed") => ({ jobId: "job:A", status: "queued", funding: { ok: false as const, code } });
    const b = { jobId: "job:B", status: "queued", funding: { ok: false as const, code: "funding_unverified" as const } };
    const polls = [[a("funding_unverified")], [a("funding_unverified")], [a("funding_unverified")],
      [a("funding_read_failed")], [a("funding_unverified"), b], [], [a("funding_unverified")]];
    for (const jobs of polls) setup.gateway.pollJobs.mockResolvedValueOnce({ ok: true, value: {
      stop: { proceed: true }, jobs, foreignJobsDropped: 0, truncated: false,
    } });
    for (let tick = 1; tick <= 7; tick++) {
      expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
      if (tick === 3) expect(setup.logs.filter((code) => code === "funding_unverified")).toHaveLength(1);
      if (tick === 5) expect(setup.logs.filter((code) => code === "funding_unverified")).toHaveLength(3);
      if (tick === 7) expect(setup.logs.filter((code) => code === "funding_unverified")).toHaveLength(4);
      setup.advance();
    }
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(7);
    expect(setup.logs.filter((code) => code === "funding_read_failed")).toHaveLength(1);
    expect(setup.inputSource).not.toHaveBeenCalled();
  });

  it("manifest mode: reclaimAt at or before the host clock claims nothing and reserves no unit", async () => {
    const setup = await fixture({ fundingSource: "manifest" });
    setup.host = createHost({ ...setup.deps, noSubmit: true });
    const inputs = { ...setup.inputs, unit: { ...setup.inputs.unit,
      reclaimAt: Math.floor(setup.deps.clock!() / 1_000) } };
    expect(inputs.unit.fundedAt).toBeDefined();
    expect(inputs.unit.fundedAt!).toBeLessThan(inputs.unit.reclaimAt);
    setup.inputSource.mockResolvedValue({ ok: true, value: inputs });
    const reserve = vi.spyOn(setup.journal, "reserveUnit");
    expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
    expect(reserve).not.toHaveBeenCalled();
    expect(setup.gateway.reportInProgress).not.toHaveBeenCalled();
    expect(await setup.journal.has(jobId)).toBe(false);
    expect(setup.logs.filter((code) => code === "unit_expired")).toHaveLength(1);
    setup.advance(999);
    expect(await setup.host.runOnce()).toEqual({ kind: "idle", waitMs: 5_000 });
    expect(reserve).not.toHaveBeenCalled();
    expect(setup.gateway.reportInProgress).not.toHaveBeenCalled();
    expect(await setup.journal.has(jobId)).toBe(false);
    expect(setup.logs.filter((code) => code === "unit_expired")).toHaveLength(1);
  });

  it.each(["gateway", "manifest"] as const)(
    "review r3 A1: in %s mode a unit whose reclaimAt is one second after the host clock's second is still claimed", async (mode) => {
      const setup = await fixture({ fundingSource: mode });
      setup.host = createHost({ ...setup.deps, noSubmit: true });
      // 999 ms into the second, so a ceil or round of the clock differs from its floor.
      setup.advance(999);
      const inputs = { ...setup.inputs, unit: { ...setup.inputs.unit,
        reclaimAt: Math.floor(setup.deps.clock!() / 1_000) + 1 } };
      setup.inputSource.mockResolvedValue({ ok: true, value: inputs });
      // A terminal report ends the claimed job at once, so no print is needed.
      setup.gateway.reportInProgress.mockResolvedValueOnce({ ok: false, code: "job_not_found", status: 404 } as never);
      const reserve = vi.spyOn(setup.journal, "reserveUnit");
      expect(await setup.host.runOnce()).toEqual({ kind: "job", jobId, state: "abandoned", waitMs: 5_000 });
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(await states(setup)).toEqual(["claimed", "abandoned"]);
      expect(setup.logs).not.toContain("unit_expired");
    },
  );

  it("review r3 A2: a unit whose reclaimAt has passed never blocks a later job in the same poll", async () => {
    const setup = await fixture();
    const expired = { ...setup.inputs, unit: { ...setup.inputs.unit, settlementUnitId: word(),
      reclaimAt: Math.floor(setup.deps.clock!() / 1_000) } };
    setup.inputSource.mockResolvedValueOnce({ ok: true, value: expired })
      .mockResolvedValueOnce({ ok: true, value: setup.inputs });
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true }, jobs: [
      { jobId: "a:expired", status: "queued", funding: setup.funding },
      { jobId, status: "queued", funding: setup.funding },
    ], foreignJobsDropped: 0, truncated: false } });
    setup.gateway.reportInProgress.mockResolvedValueOnce({ ok: false, code: "job_not_found", status: 404 } as never);
    expect(await setup.host.runOnce()).toEqual({ kind: "job", jobId, state: "abandoned", waitMs: 5_000 });
    expect(setup.inputSource).toHaveBeenCalledTimes(2);
    expect(setup.inputSource).toHaveBeenNthCalledWith(1, "a:expired");
    expect(setup.inputSource).toHaveBeenNthCalledWith(2, jobId);
    expect(await setup.journal.has("a:expired")).toBe(false);
    expect(setup.logs.filter((code) => code === "unit_expired")).toHaveLength(1);
  });

  it("manifest mode journals source manifest and never reads the poll's funding", async () => {
    const setup = await fixture({ fundingSource: "manifest" });
    setup.host = createHost({ ...setup.deps, noSubmit: true });
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true },
      jobs: [{ jobId, status: "queued", funding: { ok: false, code: "funding_unverified" } }], foreignJobsDropped: 0, truncated: false } });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    expect((await setup.journal.read(jobId))[0].funding).toEqual({ source: "manifest" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
    expect(setup.logs.some((code) => code.startsWith("funding_"))).toBe(false);
  });

  it("a restart resumes a gateway claim from the journal, never reads funding again, and sends once", async () => {
    const setup = await fixture();
    vi.spyOn(setup.journal, "savePackage").mockRejectedValueOnce(new Error("crash"));
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    const claim = (await setup.diskRecords())[0];
    const { fundedAt: _fundedAt, ...unit } = setup.inputs.unit;
    const inputSource = vi.fn(async () => ({ ok: true as const, value: { ...setup.inputs, unit } }));
    setup.gateway.pollJobs.mockResolvedValue({ ok: true, value: { stop: { proceed: true },
      jobs: [{ jobId, status: "queued", funding: { ok: false, code: "funding_read_failed" } }], foreignJobsDropped: 0, truncated: false } });
    const recovered = await restart(setup, { inputSource });
    const polls = setup.gateway.pollJobs.mock.calls.length;
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submitted" });
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls);
    expect(await recovered.host.runOnce()).toMatchObject({ kind: "idle" });
    expect(setup.gateway.pollJobs).toHaveBeenCalledTimes(polls + 1);
    expect((await recovered.journal.read(jobId))[0]).toEqual(claim);
    expect(setup.logs.some((code) => code.startsWith("funding_"))).toBe(false);
    expect(inputSource).toHaveBeenCalledTimes(1);
    expect(setup.sentData).toHaveLength(1);
  });

  it("A1: a unit claimed under manifest with --no-submit is never submitted after a restart in gateway mode with submit on", async () => {
    const setup = await fixture({ fundingSource: "manifest" });
    setup.host = createHost({ ...setup.deps, noSubmit: true });
    expect(await finish(setup)).toMatchObject({ state: "evidence_stored" });
    const before = await setup.diskRecords();
    expect(before.at(-1)).toMatchObject({ code: "submit_disabled" });
    const recovered = await restart(setup, { config: { ...setup.config, funding: { source: "gateway" } }, noSubmit: false });
    for (let tick = 0; tick < 3; tick++) {
      setup.advance();
      await recovered.host.runOnce();
    }
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.gateway.postReceipt).not.toHaveBeenCalled();
    expect(setup.operatorKey.signD1).not.toHaveBeenCalled();
    expect(await setup.diskRecords()).toEqual(before);
    expect(setup.sentData).toEqual([]);
  });

  it.each(["evidence_stored", "receipt_stored"] as const)(
    "A1: a sendable %s unit whose claim record says manifest ends refused funding_source_manifest and is never sent", async (boundary) => {
      const setup = await fixture();
      if (boundary === "evidence_stored") {
        vi.spyOn(setup.journal, "savePackage").mockRejectedValueOnce(new Error("crash"));
        expect(await finish(setup)).toMatchObject({ kind: "halted" });
      } else {
        setup.broadcaster.submit.mockResolvedValueOnce({ code: "caps_exceeded", cap: "gasCap" });
        expect(await finish(setup)).toMatchObject({ state: "receipt_stored" });
      }
      await rewriteClaim(setup, { source: "manifest" });
      const receiptPosts = setup.gateway.postReceipt.mock.calls.length;
      const recovered = await restart(setup);
      expect(await recovered.host.runOnce()).toMatchObject({ state: "refused" });
      expect((await recovered.journal.read(jobId)).at(-1)).toMatchObject({ state: "refused", code: "funding_source_manifest" });
      expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
      expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(receiptPosts);
      expect(setup.sentData).toEqual([]);
      expect(setup.logs.filter((code) => code === "funding_source_manifest")).toHaveLength(1);
      const before = await setup.diskRecords();
      await recovered.host.runOnce();
      expect(await setup.diskRecords()).toEqual(before);
    },
  );

  it("A1: a sendable unit whose claim record has no funding source (an older host) ends refused funding_source_manifest", async () => {
    const setup = await fixture();
    vi.spyOn(setup.journal, "savePackage").mockRejectedValueOnce(new Error("crash"));
    expect(await finish(setup)).toMatchObject({ kind: "halted" });
    await rewriteClaim(setup, undefined);
    const receiptPosts = setup.gateway.postReceipt.mock.calls.length;
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "refused" });
    expect((await recovered.journal.read(jobId)).at(-1)).toMatchObject({ state: "refused", code: "funding_source_manifest" });
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.gateway.postReceipt).toHaveBeenCalledTimes(receiptPosts);
    expect(setup.sentData).toEqual([]);
    expect(setup.logs.filter((code) => code === "funding_source_manifest")).toHaveLength(1);
    const before = await setup.diskRecords();
    await recovered.host.runOnce();
    expect(await setup.diskRecords()).toEqual(before);
  });

  it("A1: a recovered sendable unit with no claim record at all ends refused funding_source_manifest and is never sent", async () => {
    const setup = await fixture();
    setup.gateway.postReceipt.mockResolvedValueOnce({ ok: false, code: "unavailable", status: 503 });
    expect(await finish(setup)).toMatchObject({ state: "package_built" });
    const recoveredJob = "a:no-claim";
    const pkg = await setup.diskPackage();
    await setup.journal.append(recoveredJob, "evidence_stored");
    await setup.journal.savePackage(recoveredJob, pkg);
    await setup.journal.append(recoveredJob, "package_built", undefined, {
      packageDigest: pkg.packageDigest, evidenceBlockHash: pkg.evidenceBlockHash });
    expect((await setup.journal.read(recoveredJob)).map((entry) => entry.state)).toEqual(["evidence_stored", "package_built"]);
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ jobId: recoveredJob, state: "refused" });
    expect((await recovered.journal.read(recoveredJob)).at(-1)).toMatchObject({ state: "refused", code: "funding_source_manifest" });
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.gateway.postReceipt.mock.calls.filter(([id]) => id === recoveredJob)).toHaveLength(0);
    expect(setup.sentData).toEqual([]);
    expect(setup.logs.filter((code) => code === "funding_source_manifest")).toHaveLength(1);
  });

  it("A1: a submit_indeterminate unit whose claim record says manifest keeps its read-back and is never re-sent", async () => {
    const setup = await fixture();
    setup.fake.send = "throw_after_commit";
    expect(await finish(setup)).toMatchObject({ state: "submit_indeterminate" });
    await rewriteClaim(setup, { source: "manifest" });
    const recovered = await restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "already_committed" });
    expect(recovered.broadcaster.readBack).toHaveBeenCalledTimes(1);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(1);
    expect(setup.logs).not.toContain("funding_source_manifest");
  });

  it.each([401, null])("R3 with D1: an unauthenticated evidence refusal with status %s is held and posted again", async (status) => {
    const setup = await fixture({ caps: false });
    setup.gateway.postRelayEvidence.mockResolvedValueOnce({ ok: false, code: "unauthenticated", status });
    const { waits, timers } = evidenceHoldTimers(setup);
    setup.host = createHost({ ...setup.deps, timers });
    expect(await finish(setup)).toMatchObject({ kind: "job", jobId, state: "evidence_stored" });
    expect(setup.gateway.postRelayEvidence).toHaveBeenCalledTimes(2);
    expect(setup.gateway.postRelayEvidence.mock.calls[0][1]).toBe(setup.gateway.postRelayEvidence.mock.calls[1][1]);
    expect(waits).toEqual([5_000]);
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
    expect(setup.adapter.commands.map((command) => command.type)).toEqual(["start"]);
  });
});
