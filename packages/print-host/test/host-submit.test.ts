import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, getAddress, keccak256,
  numberToHex, parseAbi, parseTransaction, toBytes, toHex, type Hex,
} from "viem";
import { settlementUnitId } from "@pcc/contracts/vnext";
import { createEvidenceBroadcaster, type EvidenceBroadcaster, type EvidenceSubmission } from "../src/chain.js";
import type { HostConfig } from "../src/config.js";
import type { GwResult, PollJobsValue, RelayEvidenceBundle } from "../src/gateway-client.js";
import { createHost, HOST_LOG_CODES, type HostDeps, type HostLogCode } from "../src/host.js";
import type { JobInputs } from "../src/job-inputs.js";
import { createJobJournal, type JournalRecord, type JournalState, type SignedMilestonePackage } from "../src/journal.js";
import { generateHostKeys } from "../src/keygen.js";
import { loadDeviceKey, loadOperatorKey } from "../src/keys.js";
import { computePackageDigest } from "../src/package-builder.js";
import { FakeMachineAdapter } from "../src/testing/fake-machine-adapter.js";

const jobId = "job:host-submit";
const cleanups: Array<() => Promise<void>> = [];
const word = (): Hex => toHex(randomBytes(32));
const functions = parseAbi([
  "function evidenceBundleHashOf(bytes32 unitId) view returns (bytes32)",
  "function submitEvidence(bytes32 unitId, bytes32 packageDigest)",
]);
const errors = parseAbi(["error EvidenceNotCommitted()"]);
const completedStates = ["claimed", "in_progress_reported", "printing", "printed", "bundle_saved",
  "evidence_stored", "package_built", "submit_attempted", "submitted"];

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
  const config: HostConfig = {
    kernelId: "kernel:submit", deviceId: "device:submit", printer: { uri: "ipp://localhost/ipp/print" },
    chain: { chainId: 31337, rpcUrlFile, receiptTimeoutMs: 50, pollingIntervalMs: 1,
      ...(options.caps === false ? {} : { maxFeePerGasCap: "100", maxPriorityFeePerGasCap: "20", gasCap: "100000" }) },
    gateway: { baseUrl: "https://gateway.example.test", apiKeyFile: "/unused/api-key" },
    keys: generated.paths, dataDir: directory,
  };
  const journal = createJobJournal(directory, () => now.getTime());
  async function diskRecords(): Promise<JournalRecord[]> {
    const text = await readFile(journal.journalPath(jobId), "utf8");
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
  const adapter = new FakeMachineAdapter(config.deviceId, config.kernelId);
  adapter.source.simulated = options.simulated ?? false;
  cleanups.push(() => adapter.dispose());
  const gateway = {
    heartbeat: vi.fn(async () => ({ ok: true as const, value: null })),
    pollJobs: vi.fn(async (): Promise<GwResult<PollJobsValue>> => ({ ok: true,
      value: { stop: { proceed: true }, jobs: [{ jobId, status: "queued" }], foreignJobsDropped: 0, truncated: false } })),
    reportInProgress: vi.fn(async () => ({ ok: true as const, value: { updated: true as const } })),
    postRelayEvidence: vi.fn(async (id: string, bundle: RelayEvidenceBundle): Promise<GwResult<{ jobId: string;
      contentHash: string; hashModel: "event_bundle_hash" }>> => ({ ok: true,
      value: { jobId: id, contentHash: bundle.bundleHash, hashModel: "event_bundle_hash" } })),
    toJSON: () => ({ baseUrl: "https://gateway.example.test", kernelId: config.kernelId }),
    toString: () => "gateway",
    [inspect.custom]: () => ({ baseUrl: "https://gateway.example.test", kernelId: config.kernelId }),
  };
  const fake: { initial: "absent" | "matching" | "conflict"; send: "ok" | "throw_after_commit" | "throw_absent";
    readFailure: boolean; stored?: Hex } = { initial: "absent", send: "ok", readFailure: false };
  const calls: Array<{ method: string; params: unknown }> = [];
  const sendStates: JournalState[][] = [];
  const sentData: Hex[] = [];
  let txHash = word();
  const serverText = `${rpcUrl} private-server-${randomBytes(24).toString("base64url")}`;
  const transport = custom({ request: async ({ method, params }) => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId": return "0x7a69";
      case "eth_call": {
        if (fake.readFailure) throw { code: -32603, message: serverText };
        const decoded = decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data });
        // Record wrong targets as a conflict, instead of allowing a read to pass accidentally.
        if (decoded.functionName !== "evidenceBundleHashOf" || decoded.args[0] !== unitId) return word();
        if (fake.stored !== undefined) return fake.stored;
        if (fake.initial === "matching") return commitment(submission(await diskPackage()));
        if (fake.initial === "conflict") return word();
        throw { code: 3, message: serverText, data: encodeErrorResult({ abi: errors, errorName: "EvidenceNotCommitted" }) };
      }
      case "eth_getTransactionCount": return "0x7";
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
        if (fake.send !== "throw_absent") fake.stored = commitment({ escrow: getAddress(tx.to!),
          unitId: decoded.args[0], packageDigest: decoded.args[1],
          compositionSchemaVersion: inputs.unit.compositionSchemaVersion ?? 0 });
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
  return { directory, config, journal, diskRecords, diskPackage, inputs, inputSource, adapter, gateway, fake, calls,
    sendStates, sentData, d1States, operatorKey, deviceKey, broadcaster, newBroadcaster, logs, deps, host, rpcUrl, serverText };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
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
function restart(setup: Fixture, overrides: Partial<HostDeps> = {}) {
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
    const recovered = restart(setup);
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
    const recovered = restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submit_indeterminate" });
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submit_indeterminate" });
    expect(recovered.broadcaster.readBack).toHaveBeenCalledTimes(2);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
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
    const recovered = restart(setup);
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
    const recovered = restart(setup);
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
    expect((await states(setup)).slice(-2)).toEqual(["submit_attempted", "already_committed"]);
    expect(setup.operatorKey.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(0);
    const recovered = restart(setup);
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
    const recovered = restart(setup);
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
    const recovered = restart(setup);
    await recovered.host.runOnce();
    noSubmitSignatures(setup);
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
  });

  it("simulated evidence in real mode never posts, builds, signs or submits", async () => {
    const setup = await fixture({ simulated: true });
    await finish(setup);
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
    const recovered = restart(setup);
    await recovered.host.runOnce();
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(recovered.broadcaster.readBack).not.toHaveBeenCalled();
  });

  it("a read-back RPC failure leaves an attempted unit indeterminate with a closed code", async () => {
    const setup = await fixture();
    setup.fake.send = "throw_absent";
    expect(await finish(setup)).toMatchObject({ state: "submit_indeterminate" });
    setup.fake.readFailure = true;
    const recovered = restart(setup);
    expect(await recovered.host.runOnce()).toMatchObject({ state: "submit_indeterminate" });
    expect((await setup.journal.read(jobId)).at(-1)).toMatchObject({ state: "submit_indeterminate", code: "submit_rpc_unavailable" });
    expect(recovered.broadcaster.submit).not.toHaveBeenCalled();
    expect(setup.sentData).toHaveLength(1);
    expect(JSON.stringify(setup.logs)).not.toContain(setup.rpcUrl);
    expect(JSON.stringify(setup.logs)).not.toContain(setup.serverText);
    expect(setup.logs.every((code) => HOST_LOG_CODES.includes(code))).toBe(true);
  });
});
