import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, getAddress, keccak256,
  numberToHex, parseAbi, stringToHex, type Hex, type Transport,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvidenceBroadcaster, EvidenceChainConfigError,
  type EvidenceSubmission,
} from "../src/chain.js";
import type { HostConfig } from "../src/config.js";
import type { SubmitEvidenceTxInput } from "../src/operator-signing.js";

const dirs: string[] = [];
const bytes32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const errorAbi = parseAbi([
  "error EvidenceNotCommitted()", "error UnitNotFound()", "error NotActive()",
  "error OnlyOperator()", "error TooLateForEvidence()", "error EvidenceAlreadyCommitted()",
]);
const functions = parseAbi([
  "function unitTerms(bytes32 unitId) view returns (uint256 milestoneIndex_, bytes32 stepId_, uint8 requestedTier_, uint256 reclaimAt_, bytes32 payoutConfigHash_, uint16 compositionSchemaVersion_, bool evidenceCommitted_)",
  "function jobIdHash() view returns (bytes32)",
  "function evidenceBundleHashOf(bytes32 unitId) view returns (bytes32)",
  "function submitEvidence(bytes32 unitId, bytes32 packageDigest)",
]);

// Independent formula from contracts/src/libraries/VNextSettlementLib.sol
// computeEvidenceCommitment, rather than the production TS helper.
function contractCommitment(input: EvidenceSubmission, chainId = 31337): Hex {
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
    { type: "uint16" }, { type: "uint8" }, { type: "bytes32" },
  ], [keccak256(stringToHex("PCC:vnext:evidence-commitment:v1")), BigInt(chainId),
    input.escrow, input.unitId, input.compositionSchemaVersion, 1, input.packageDigest]));
}

// Independent abi.encode formula from VNextSettlementLib.computeSettlementUnitId.
function contractUnitId(input: {
  chainId: number; escrow: EvidenceSubmission["escrow"]; jobIdHash: Hex;
  milestoneIndex: bigint; stepId: Hex;
}): Hex {
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
    { type: "uint256" }, { type: "bytes32" },
  ], [keccak256(stringToHex("PCC:vnext:settlement-unit:v1")), BigInt(input.chainId),
    input.escrow, input.jobIdHash, input.milestoneIndex, input.stepId]));
}

type FakeOptions = {
  chainId?: number;
  unitChainId?: number;
  storedVersion?: number;
  termsRevert?: "UnitNotFound";
  termsFailure?: boolean;
  jobIdFailure?: boolean;
  baseFee?: bigint;
  priorityFee?: bigint;
  gas?: bigint;
  commitment?: Hex;
  afterSendCommitment?: Hex | null;
  estimateRevert?: "NotActive" | "OnlyOperator" | "TooLateForEvidence" | "EvidenceAlreadyCommitted";
  sendRevert?: "NotActive" | "EvidenceAlreadyCommitted" | "unknown_revert";
  readRevert?: "UnitNotFound";
  postSendReadRevert?: "UnitNotFound";
  receiptStatus?: "success" | "reverted" | "timeout";
  failureMethod?: string;
  postSendReadFailure?: boolean;
  pendingMissesUnminedSends?: boolean;
  pendingNonce?: number;
  latestNonce?: number;
  latestFailure?: boolean;
};

async function fixture(overrides: Partial<HostConfig["chain"]> = {}, fake: FakeOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ph4-chain-"));
  dirs.push(dir);
  await chmod(dir, 0o700);
  const rpcUrl = `https://rpc.example.test/${randomBytes(24).toString("base64url")}?access=${randomBytes(24).toString("base64url")}`;
  const rpcUrlFile = join(dir, "rpc-url");
  await writeFile(rpcUrlFile, `${rpcUrl}\n`, { mode: 0o600 });
  const chain: HostConfig["chain"] = { chainId: 31337, rpcUrlFile, maxFeePerGasCap: "100",
    maxPriorityFeePerGasCap: "20", gasCap: "100000", receiptTimeoutMs: 30,
    pollingIntervalMs: 1, ...overrides };
  const escrow = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const jobIdHash = bytes32();
  const packageDigest = bytes32();
  const unitChainId = fake.unitChainId ?? chain.chainId;
  const units = new Map<Hex, { milestoneIndex: bigint; stepId: Hex }>();
  function addUnit(milestoneIndex: bigint): EvidenceSubmission {
    const terms = { milestoneIndex, stepId: bytes32() };
    const unitId = contractUnitId({ chainId: unitChainId, escrow, jobIdHash, ...terms });
    units.set(unitId, terms);
    return { escrow, unitId, packageDigest, compositionSchemaVersion: fake.storedVersion ?? 0 };
  }
  const input = addUnit(3n);
  const raw = `0x${randomBytes(128).toString("hex")}` as Hex;
  const hash = keccak256(raw);
  const calls: { method: string; params: unknown }[] = [];
  let estimatedUnit = input.unitId;
  const sentUnits = new Set<Hex>();
  let sentCount = 0;
  let minedCount = 0;
  const logs = ["log", "warn", "error", "debug", "info"].map((method) =>
    vi.spyOn(console, method as "log").mockImplementation(() => undefined));
  const serverText = `${rpcUrl} ${raw} ${randomBytes(24).toString("base64url")}`;
  const signer = { address: getAddress(`0x${randomBytes(20).toString("hex")}`),
    signSubmitEvidenceTx: vi.fn(async (value: SubmitEvidenceTxInput) => {
      calls.push({ method: "signTransaction", params: value });
      return raw;
    }) };
  function reject(errorName: typeof errorAbi[number]["name"]): never {
    throw { code: 3, message: serverText, data: encodeErrorResult({ abi: errorAbi, errorName }) };
  }
  function escrowCommitment(unitId: Hex) {
    if (!sentUnits.has(unitId)) return fake.commitment;
    if (fake.afterSendCommitment !== undefined) return fake.afterSendCommitment;
    if (fake.sendRevert !== undefined || fake.receiptStatus === "reverted" || fake.receiptStatus === "timeout") return undefined;
    return contractCommitment({ ...input, unitId, compositionSchemaVersion: fake.storedVersion ?? 0 }, unitChainId);
  }
  const transport = custom({ request: async ({ method, params }) => {
    calls.push({ method, params });
    if (fake.failureMethod === method) throw { code: -32603, message: serverText };
    switch (method) {
      case "eth_chainId": return numberToHex(fake.chainId ?? 31337);
      case "eth_call": {
        const decoded = decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data });
        if (decoded.functionName === "jobIdHash") {
          if (fake.jobIdFailure) throw { code: -32603, message: serverText };
          return encodeFunctionResult({ abi: functions, functionName: "jobIdHash", result: jobIdHash });
        }
        const unitId = decoded.args[0];
        const sent = sentUnits.has(unitId);
        if (decoded.functionName === "unitTerms") {
          if (fake.termsRevert !== undefined) reject(fake.termsRevert);
          if (fake.termsFailure) throw { code: -32603, message: serverText };
          const terms = units.get(unitId);
          if (terms === undefined) return reject("UnitNotFound");
          return encodeFunctionResult({ abi: functions, functionName: "unitTerms",
            result: [terms.milestoneIndex, terms.stepId, 0, 100n, bytes32(), fake.storedVersion ?? 0,
              escrowCommitment(unitId) != null] });
        }
        if (fake.readRevert !== undefined) reject(fake.readRevert);
        if (sent && fake.postSendReadRevert !== undefined) reject(fake.postSendReadRevert);
        if (sent && fake.postSendReadFailure) throw { code: -32603, message: serverText };
        const commitment = escrowCommitment(unitId);
        if (commitment === undefined || commitment === null) reject("EvidenceNotCommitted");
        return commitment;
      }
      case "eth_getTransactionCount": {
        const tag = (params as [Hex, string])[1];
        if (tag === "latest") {
          if (fake.latestFailure) throw { code: -32603, message: serverText };
          return numberToHex(fake.latestNonce ?? 7 + minedCount);
        }
        return numberToHex(fake.pendingNonce ?? 7 + (fake.pendingMissesUnminedSends ? minedCount : sentCount));
      }
      case "eth_getBlockByNumber": return { number: "0x1", hash: bytes32(), parentHash: bytes32(),
        timestamp: "0x1", baseFeePerGas: numberToHex(fake.baseFee ?? 10n),
        gasLimit: "0xffffff", gasUsed: "0x0", transactions: [] };
      case "eth_maxPriorityFeePerGas": return numberToHex(fake.priorityFee ?? 2n);
      case "eth_estimateGas": {
        if (fake.estimateRevert !== undefined) reject(fake.estimateRevert);
        const decoded = decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data });
        if (decoded.functionName !== "submitEvidence") throw new Error(serverText);
        estimatedUnit = decoded.args[0];
        return numberToHex(fake.gas ?? 50_000n);
      }
      case "eth_sendRawTransaction": {
        sentUnits.add(estimatedUnit);
        if (fake.sendRevert === "unknown_revert") throw { code: 3, message: serverText, data: "0xdeadbeef" };
        if (fake.sendRevert !== undefined) reject(fake.sendRevert);
        sentCount++;
        return hash;
      }
      case "eth_getTransactionReceipt":
        if (fake.receiptStatus === "timeout") return null;
        minedCount = sentCount;
        return { transactionHash: hash, blockHash: bytes32(), blockNumber: "0x1", transactionIndex: "0x0",
          from: signer.address, to: input.escrow, cumulativeGasUsed: "0xc350", gasUsed: "0xc350",
          contractAddress: null, logs: [], logsBloom: "0x", status: fake.receiptStatus === "reverted" ? "0x0" : "0x1",
          effectiveGasPrice: "0xe", type: "0x2" };
      case "eth_blockNumber": return "0x2";
      case "eth_getTransactionByHash": return null;
      default: throw new Error(serverText);
    }
  } });
  const broadcaster = createEvidenceBroadcaster({ chain }, signer, { transport });
  function expectRedacted(value: unknown) {
    const forms = [String(value), JSON.stringify(value), inspect(value, { depth: 20, showHidden: true })];
    for (const form of forms) for (const secret of [rpcUrl, raw, serverText]) expect(form).not.toContain(secret);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  }
  function contractReads(name: "unitTerms" | "jobIdHash" | "evidenceBundleHashOf") {
    return calls.filter(({ method, params }) => method === "eth_call"
      && decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data }).functionName === name);
  }
  function expectPostSendRead(after: "eth_sendRawTransaction" | "eth_getTransactionReceipt") {
    expect(calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    const reads = contractReads("evidenceBundleHashOf");
    expect(reads).toHaveLength(2);
    expect(calls.indexOf(reads[1])).toBeGreaterThan(calls.findIndex(({ method }) => method === after));
  }
  return { broadcaster, input, signer, chain, raw, hash, calls, rpcUrl, expectRedacted, fake, transport,
    addUnit, contractReads, expectPostSendRead };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("submitEvidence broadcaster", () => {
  it("signs with the pending nonce, sends exactly once, and verifies the contract-formula commitment", async () => {
    const setup = await fixture({}, { storedVersion: 4_096 });
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "submitted", transactionHash: setup.hash });
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    // Two commitment reads plus one unitTerms and one jobIdHash read per submit.
    expect(setup.calls.filter(({ method }) => method === "eth_call")).toHaveLength(4);
    expect(setup.contractReads("unitTerms")).toHaveLength(1);
    expect(setup.contractReads("jobIdHash")).toHaveLength(1);
    expect(setup.contractReads("evidenceBundleHashOf")).toHaveLength(2);
    expect(setup.calls.find(({ method }) => method === "eth_getTransactionCount")?.params).toEqual([setup.signer.address, "pending"]);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledWith({ escrow: setup.input.escrow,
      unitId: setup.input.unitId, packageDigest: setup.input.packageDigest, nonce: 7, gas: 50_000n,
      maxFeePerGas: 14n, maxPriorityFeePerGas: 2n });
    setup.expectRedacted(result);
  });

  it("awaits the durable beforeSend hook after signing and immediately before the raw send", async () => {
    const setup = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const beforeSend = vi.fn(async (sent: { transactionHash: Hex; nonce: number }) => {
      setup.calls.push({ method: "beforeSend", params: sent });
      await gate;
      setup.calls.push({ method: "beforeSendResolved", params: sent });
    });
    const pending = setup.broadcaster.submit(setup.input, { beforeSend });
    await vi.waitFor(() => expect(beforeSend).toHaveBeenCalledTimes(1));
    expect(beforeSend).toHaveBeenCalledWith({ transactionHash: setup.hash, nonce: 7 });
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    release();
    expect(await pending).toEqual({ code: "submitted", transactionHash: setup.hash });
    const order = setup.calls.map(({ method }) => method);
    expect(order.indexOf("beforeSend")).toBe(order.indexOf("signTransaction") + 1);
    expect(order.indexOf("eth_sendRawTransaction")).toBe(order.indexOf("beforeSendResolved") + 1);
    expect(order.filter((method) => method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("a rejected beforeSend hook propagates, sends nothing and leaves no same-unit latch or nonce hold", async () => {
    const setup = await fixture();
    const failure = new Error("journal_invalid");
    await expect(setup.broadcaster.submit(setup.input, {
      beforeSend: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    // The same instance can retry this provably unsent unit at the same nonce.
    expect(await setup.broadcaster.submit(setup.input)).toEqual({ code: "submitted", transactionHash: setup.hash });
    expect(setup.signer.signSubmitEvidenceTx.mock.calls.map(([input]) => input.nonce)).toEqual([7, 7]);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("a failed beforeSend hook leaves no cross-unit hold", async () => {
    const setup = await fixture();
    await expect(setup.broadcaster.submit(setup.input, {
      beforeSend: async () => { throw new Error("journal_invalid"); },
    })).rejects.toThrow("journal_invalid");
    setup.fake.latestFailure = true;
    setup.fake.pendingNonce = 7;
    expect(await setup.broadcaster.submit(setup.addUnit(4n)))
      .toEqual({ code: "submitted", transactionHash: setup.hash });
    expect(setup.signer.signSubmitEvidenceTx.mock.calls.map(([input]) => input.nonce)).toEqual([7, 7]);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    expect(setup.calls.filter(({ method, params }) => method === "eth_getTransactionCount"
      && (params as [Hex, string])[1] === "latest")).toHaveLength(0);
  });

  it.each([
    ["maxFeePerGasCap", { maxFeePerGasCap: "21" }, { baseFee: 20n }],
    ["maxPriorityFeePerGasCap", { maxPriorityFeePerGasCap: "1" }, {}],
    ["gasCap", { gasCap: "49999" }, {}],
  ] as const)("refuses %s before signing or sending", async (cap, config, fake) => {
    const setup = await fixture(config, fake);
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "caps_exceeded", cap });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    setup.expectRedacted(result);
  });

  it("omitted caps disable broadcast while preserving old configuration", async () => {
    const setup = await fixture({ maxFeePerGasCap: undefined, maxPriorityFeePerGasCap: undefined, gasCap: undefined });
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "caps_exceeded", cap: "maxFeePerGasCap" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    setup.expectRedacted(result);
  });

  it("allows estimates equal to all caps", async () => {
    const setup = await fixture({ maxFeePerGasCap: "14", maxPriorityFeePerGasCap: "2", gasCap: "50000" });
    expect((await setup.broadcaster.submit(setup.input)).code).toBe("submitted");
  });

  it("a receipt timeout is indeterminate and never re-sends, including later and concurrent calls", async () => {
    const setup = await fixture({}, { receiptStatus: "timeout", afterSendCommitment: undefined });
    // Keep the read-back uncommitted even after the send. The transport returns
    // the explicit EvidenceNotCommitted selector, not a fabricated zero commitment.
    const original = setup.transport;
    let reads = 0;
    const pendingTransport: Transport = (options) => {
      const transport = original(options);
      return { ...transport, request: async (request, options) => {
        if (request.method === "eth_call"
          && decodeFunctionData({ abi: functions, data: (request.params as [{ data: Hex }])[0].data }).functionName === "evidenceBundleHashOf") {
          reads++;
          throw { code: 3, message: setup.rpcUrl, data: encodeErrorResult({ abi: errorAbi, errorName: "EvidenceNotCommitted" }) };
        }
        return transport.request(request, options);
      } };
    };
    const broadcaster = createEvidenceBroadcaster({ chain: setup.chain }, setup.signer, { transport: pendingTransport });
    const first = await broadcaster.submit(setup.input);
    expect(first).toEqual({ code: "indeterminate", transactionHash: setup.hash });
    const subsequent = await Promise.all([broadcaster.submit(setup.input), broadcaster.submit(setup.input)]);
    expect(subsequent).toEqual([first, first]);
    expect(await broadcaster.readBack(setup.input)).toEqual({ code: "refused", reason: "EvidenceNotCommitted" });
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    setup.expectRedacted({ first, subsequent });
  });

  it("an ambiguous send failure is indeterminate with exactly one send and no transport retry", async () => {
    const setup = await fixture({}, { failureMethod: "eth_sendRawTransaction" });
    const first = await setup.broadcaster.submit(setup.input);
    const second = await setup.broadcaster.submit(setup.input);
    expect(first).toEqual({ code: "indeterminate", transactionHash: setup.hash });
    expect(second).toEqual(first);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    setup.expectRedacted({ first, second });
  });

  it("matching read-back gives already_committed without signing or sending", async () => {
    const setup = await fixture();
    setup.fake.commitment = contractCommitment(setup.input);
    expect(await setup.broadcaster.submit(setup.input)).toEqual({ code: "already_committed" });
    expect(await setup.broadcaster.readBack(setup.input)).toEqual({ code: "already_committed" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
  });

  it("differing read-back gives conflict before and after sending", async () => {
    const before = await fixture({}, { commitment: bytes32() });
    expect(await before.broadcaster.submit(before.input)).toEqual({ code: "conflict" });
    expect(await before.broadcaster.readBack(before.input)).toEqual({ code: "conflict" });
    expect(before.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    const after = await fixture({}, { afterSendCommitment: bytes32() });
    expect(await after.broadcaster.submit(after.input)).toEqual({ code: "conflict" });
    expect(after.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("read-back checks the exact domain, chain, escrow, unit, schema version, format 1 and digest", async () => {
    for (let index = 0; index < 12; index++) {
      const setup = await fixture({}, { storedVersion: index * 5_000 });
      const input = { ...setup.input, compositionSchemaVersion: index * 5_000 };
      setup.fake.commitment = contractCommitment(input);
      expect(await setup.broadcaster.readBack(input)).toEqual({ code: "already_committed" });
      expect(await setup.broadcaster.readBack({ ...input, compositionSchemaVersion: input.compositionSchemaVersion + 1 }))
        .toEqual({ code: "refused", reason: "unit_mismatch" });
      expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
      expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    }
  });

  it("compares read-back against the stored schema version, rejecting a commitment for V+1", async () => {
    const setup = await fixture({}, { storedVersion: 17 });
    setup.fake.commitment = contractCommitment(setup.input);
    expect(await setup.broadcaster.readBack(setup.input)).toEqual({ code: "already_committed" });
    setup.fake.commitment = contractCommitment({ ...setup.input, compositionSchemaVersion: 18 });
    expect(await setup.broadcaster.readBack(setup.input)).toEqual({ code: "conflict" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
  });

  it.each([["submit", true], ["submit", false], ["readBack", true], ["readBack", false]] as const)(
    "%s refuses a package schema version differing from the stored unit before signing or sending (committed=%s)", async (method, committed) => {
    const setup = await fixture({}, { storedVersion: 17 });
    const input = { ...setup.input, compositionSchemaVersion: 18 };
    // A caller-bound commitment must not bypass the frozen version check either.
    setup.fake.commitment = committed ? contractCommitment(input) : undefined;
    expect(await setup.broadcaster[method](input)).toEqual({ code: "refused", reason: "unit_mismatch" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    expect(setup.calls.some(({ method }) => method === "eth_getTransactionCount")).toBe(false);
    setup.expectRedacted(setup.calls);
  });

  it.each([["submit", true], ["submit", false], ["readBack", true], ["readBack", false]] as const)(
    "%s refuses a unit derived from another chain despite matching config and RPC before signing or sending (committed=%s)", async (method, committed) => {
    const setup = await fixture({}, { unitChainId: 84532 });
    setup.fake.commitment = committed ? contractCommitment(setup.input) : undefined;
    expect(await setup.broadcaster[method](setup.input)).toEqual({ code: "refused", reason: "chain_mismatch" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    expect(setup.calls.some(({ method }) => method === "eth_getTransactionCount")).toBe(false);
  });

  it.each(["submit", "readBack"] as const)("%s refuses UnitNotFound from unitTerms before signing or sending", async (method) => {
    const setup = await fixture({}, { termsRevert: "UnitNotFound" });
    expect(await setup.broadcaster[method](setup.input)).toEqual({ code: "refused", reason: "UnitNotFound" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    setup.expectRedacted(setup.calls);
  });

  it.each(["submit", "readBack"] as const)("%s reports a unitTerms transport failure as rpc_unavailable before signing or sending", async (method) => {
    const setup = await fixture({}, { termsFailure: true });
    expect(await setup.broadcaster[method](setup.input)).toEqual({ code: "rpc_unavailable" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
    setup.expectRedacted(setup.calls);
  });

  it.each(["submit", "readBack"] as const)("%s reports a jobIdHash transport failure as rpc_unavailable before signing or sending", async (method) => {
    const setup = await fixture({}, { jobIdFailure: true });
    expect(await setup.broadcaster[method](setup.input)).toEqual({ code: "rpc_unavailable" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
  });

  it("reads frozen terms before the commitment, pending nonce and signing, exactly once per call", async () => {
    const setup = await fixture({}, { storedVersion: 23 });
    expect(await setup.broadcaster.submit(setup.input)).toEqual({ code: "submitted", transactionHash: setup.hash });
    const order = setup.calls.map(({ method, params }) => method === "eth_call"
      ? decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data }).functionName : method);
    for (const termsRead of ["unitTerms", "jobIdHash"]) {
      expect(order.indexOf(termsRead)).toBeGreaterThanOrEqual(0);
      for (const later of ["evidenceBundleHashOf", "eth_getTransactionCount", "signTransaction", "eth_sendRawTransaction"]) {
        expect(order.indexOf(termsRead)).toBeLessThan(order.indexOf(later));
      }
    }
    expect(setup.contractReads("unitTerms")).toHaveLength(1);
    expect(setup.contractReads("jobIdHash")).toHaveLength(1);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    expect(await setup.broadcaster.readBack(setup.input)).toEqual({ code: "already_committed" });
    expect(setup.contractReads("unitTerms")).toHaveLength(2);
    expect(setup.contractReads("jobIdHash")).toHaveLength(2);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it.each(["submit", "readBack"] as const)("%s reads frozen terms afresh across calls instead of caching them", async (method) => {
    const setup = await fixture({}, { storedVersion: 23 });
    setup.fake.commitment = contractCommitment(setup.input);
    expect(await setup.broadcaster[method](setup.input)).toEqual({ code: "already_committed" });
    // Simulate a different RPC answer to expose any cache across calls.
    setup.fake.storedVersion = 24;
    const input = { ...setup.input, compositionSchemaVersion: 24 };
    setup.fake.commitment = contractCommitment(input);
    expect(await setup.broadcaster[method](input)).toEqual({ code: "already_committed" });
    expect(setup.contractReads("unitTerms")).toHaveLength(2);
    expect(setup.contractReads("jobIdHash")).toHaveLength(2);
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
    expect(setup.calls.some(({ method }) => method === "eth_sendRawTransaction")).toBe(false);
  });

  it.each(["NotActive", "OnlyOperator", "TooLateForEvidence", "EvidenceAlreadyCommitted"] as const)(
    "a %s estimate revert gives a closed refused code without signing", async (reason) => {
      const setup = await fixture({}, { estimateRevert: reason });
      const result = await setup.broadcaster.submit(setup.input);
      expect(result).toEqual({ code: "refused", reason });
      expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
      setup.expectRedacted(result);
    });

  it("distinguishes an uncommitted getter from other getter reverts", async () => {
    const setup = await fixture({}, { readRevert: "UnitNotFound" });
    expect(await setup.broadcaster.submit(setup.input)).toEqual({ code: "refused", reason: "UnitNotFound" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
  });

  it("a failed receipt gives refused and never claims submission", async () => {
    const setup = await fixture({}, { receiptStatus: "reverted" });
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "refused", reason: "transaction_reverted" });
    setup.expectPostSendRead("eth_getTransactionReceipt");
    setup.expectRedacted(result);
  });

  it.each(["ours", "different"] as const)("a reverted receipt reconciles an %s commitment", async (commitment) => {
    const setup = await fixture({}, { receiptStatus: "reverted" });
    setup.fake.afterSendCommitment = commitment === "ours" ? contractCommitment(setup.input) : bytes32();
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: commitment === "ours" ? "already_committed" : "conflict" });
    setup.expectPostSendRead("eth_getTransactionReceipt");
    setup.expectRedacted(result);
  });

  it.each(["transport", "revert"] as const)("a reverted receipt with a failed %s read is indeterminate", async (failure) => {
    const setup = await fixture({}, { receiptStatus: "reverted", postSendReadFailure: failure === "transport",
      postSendReadRevert: failure === "revert" ? "UnitNotFound" : undefined });
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "indeterminate", transactionHash: setup.hash });
    setup.expectPostSendRead("eth_getTransactionReceipt");
    setup.expectRedacted(result);
  });

  it.each((["NotActive", "EvidenceAlreadyCommitted", "unknown_revert"] as const).flatMap((reason) =>
    (["ours", "different", "uncommitted", "transport", "revert"] as const).map((state) => ({ reason, state }))))(
    "a send-time $reason revert reconciles the $state escrow outcome", async ({ reason, state }) => {
      const setup = await fixture({}, { sendRevert: reason, postSendReadFailure: state === "transport",
        postSendReadRevert: state === "revert" ? "UnitNotFound" : undefined });
      setup.fake.afterSendCommitment = state === "ours" ? contractCommitment(setup.input)
        : state === "different" ? bytes32() : null;
      const result = await setup.broadcaster.submit(setup.input);
      expect(result).toEqual(state === "ours" ? { code: "already_committed" }
        : state === "different" ? { code: "conflict" }
        : state === "uncommitted" ? { code: "refused", reason }
        : { code: "indeterminate", transactionHash: setup.hash });
      setup.expectPostSendRead("eth_sendRawTransaction");
      setup.expectRedacted(result);
    });

  it.each(["NotActive", "EvidenceAlreadyCommitted", "unknown_revert"] as const)(
    "a send rejected with %s and uncommitted read-back releases both cross-unit nonce checks", async (reason) => {
      const setup = await fixture({}, { sendRevert: reason });
      const first = await setup.broadcaster.submit(setup.input);
      expect(first).toEqual({ code: "refused", reason });
      const boundary = setup.calls.length;
      // An unconsumed nonce remains 7. Any latest read would fail and expose a hold.
      setup.fake.latestFailure = true;
      setup.fake.pendingNonce = 7;
      setup.fake.sendRevert = undefined;
      expect(await setup.broadcaster.submit(setup.addUnit(4n)))
        .toEqual({ code: "submitted", transactionHash: setup.hash });
      expect(setup.signer.signSubmitEvidenceTx.mock.calls.map(([input]) => input.nonce)).toEqual([7, 7]);
      expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
      expect(setup.calls.slice(boundary).filter(({ method, params }) => method === "eth_getTransactionCount")
        .map(({ params }) => (params as [Hex, string])[1])).toEqual(["pending"]);
      // Its own latch survives the released hold, even when its escrow is absent.
      setup.fake.afterSendCommitment = null;
      expect(await setup.broadcaster.submit(setup.input))
        .toEqual({ code: "indeterminate", transactionHash: setup.hash });
      expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(2);
      expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
      setup.expectRedacted(first);
    });

  it("an ambiguous send failure keeps its cross-unit nonce hold", async () => {
    const setup = await fixture({}, { failureMethod: "eth_sendRawTransaction" });
    expect(await setup.broadcaster.submit(setup.input))
      .toEqual({ code: "indeterminate", transactionHash: setup.hash });
    setup.fake.failureMethod = undefined;
    expect(await setup.broadcaster.submit(setup.addUnit(4n)))
      .toEqual({ code: "refused", reason: "unreconciled_transaction" });
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("a successful receipt with unavailable read-back remains indeterminate", async () => {
    const setup = await fixture({}, { postSendReadFailure: true });
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "indeterminate", transactionHash: setup.hash });
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    setup.expectRedacted(result);
  });

  it("waits for the configured number of confirmations", async () => {
    const confirmed = await fixture({ confirmations: 2 });
    expect((await confirmed.broadcaster.submit(confirmed.input)).code).toBe("submitted");
    expect(confirmed.calls.some(({ method }) => method === "eth_blockNumber")).toBe(true);
    const unconfirmed = await fixture({ confirmations: 3 });
    const result = await unconfirmed.broadcaster.submit(unconfirmed.input);
    expect(result).toEqual({ code: "indeterminate", transactionHash: unconfirmed.hash });
    unconfirmed.expectRedacted(result);
  });

  it("serializes concurrent distinct units through the operator's pending nonce stream", async () => {
    const setup = await fixture();
    const second = setup.addUnit(4n);
    const results = await Promise.all([setup.broadcaster.submit(setup.input), setup.broadcaster.submit(second)]);
    expect(results.map((result) => result.code)).toEqual(["submitted", "submitted"]);
    expect(setup.signer.signSubmitEvidenceTx.mock.calls.map(([input]) => input.nonce)).toEqual([7, 8]);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    expect(setup.calls.filter(({ method, params }) => method === "eth_getTransactionCount"
      && (params as [Hex, string])[1] === "latest")).toHaveLength(0);
    setup.expectRedacted(results);
  });

  it.each([true, false])("refuses another unit while a transaction is unmined (pending misses it=%s)", async (misses) => {
    const setup = await fixture({}, { receiptStatus: "timeout", pendingMissesUnminedSends: misses });
    const second = setup.addUnit(4n);
    const first = await setup.broadcaster.submit(setup.input);
    expect(first).toEqual({ code: "indeterminate", transactionHash: setup.hash });
    const boundary = setup.calls.length;
    const result = await setup.broadcaster.submit(second);
    expect(result).toEqual({ code: "refused", reason: "unreconciled_transaction" });
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    const later = setup.calls.slice(boundary);
    expect(later.filter(({ method }) => method === "eth_getTransactionCount").map(({ params }) => params))
      .toEqual([[setup.signer.address, "latest"]]);
    for (const method of ["eth_getBlockByNumber", "eth_maxPriorityFeePerGas", "eth_estimateGas"]) {
      expect(later.some((call) => call.method === method)).toBe(false);
    }
    setup.expectRedacted({ first, result });
  });

  it("allows another unit with nonce 8 after the latest nonce passes a timed-out transaction", async () => {
    const setup = await fixture({}, { receiptStatus: "timeout" });
    const second = setup.addUnit(4n);
    const first = await setup.broadcaster.submit(setup.input);
    expect(first).toEqual({ code: "indeterminate", transactionHash: setup.hash });
    const blocked = await setup.broadcaster.submit(second);
    expect(blocked).toEqual({ code: "refused", reason: "unreconciled_transaction" });
    setup.fake.receiptStatus = "success";
    setup.fake.latestNonce = 8;
    const result = await setup.broadcaster.submit(second);
    expect(result).toEqual({ code: "submitted", transactionHash: setup.hash });
    expect(setup.signer.signSubmitEvidenceTx.mock.calls.map(([input]) => input.nonce)).toEqual([7, 8]);
    expect(setup.signer.signSubmitEvidenceTx.mock.calls.filter(([input]) => input.unitId === setup.input.unitId)).toHaveLength(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    setup.expectRedacted({ first, blocked, result });
  });

  it("refuses a lagging pending nonce after a successful receipt", async () => {
    const setup = await fixture();
    const first = await setup.broadcaster.submit(setup.input);
    expect(first).toEqual({ code: "submitted", transactionHash: setup.hash });
    setup.fake.pendingNonce = 7;
    const result = await setup.broadcaster.submit(setup.addUnit(4n));
    expect(result).toEqual({ code: "refused", reason: "unreconciled_transaction" });
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    expect(setup.calls.filter(({ method }) => method === "eth_estimateGas")).toHaveLength(1);
    setup.expectRedacted({ first, result });
  });

  it("a reverted receipt settles its nonce so another unit proceeds without a latest read", async () => {
    const setup = await fixture({}, { receiptStatus: "reverted" });
    const first = await setup.broadcaster.submit(setup.input);
    expect(first).toEqual({ code: "refused", reason: "transaction_reverted" });
    setup.fake.receiptStatus = "success";
    const result = await setup.broadcaster.submit(setup.addUnit(4n));
    expect(result).toEqual({ code: "submitted", transactionHash: setup.hash });
    expect(setup.signer.signSubmitEvidenceTx.mock.calls.map(([input]) => input.nonce)).toEqual([7, 8]);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    expect(setup.calls.filter(({ method, params }) => method === "eth_getTransactionCount"
      && (params as [Hex, string])[1] === "latest")).toHaveLength(0);
    setup.expectRedacted({ first, result });
  });

  it("a failed latest nonce read while another unit is unsettled gives rpc_unavailable", async () => {
    const setup = await fixture({}, { receiptStatus: "timeout" });
    const first = await setup.broadcaster.submit(setup.input);
    expect(first).toEqual({ code: "indeterminate", transactionHash: setup.hash });
    setup.fake.latestFailure = true;
    const boundary = setup.calls.length;
    const result = await setup.broadcaster.submit(setup.addUnit(4n));
    expect(result).toEqual({ code: "rpc_unavailable" });
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    const later = setup.calls.slice(boundary);
    expect(later.filter(({ method }) => method === "eth_getTransactionCount").map(({ params }) => params))
      .toEqual([[setup.signer.address, "latest"]]);
    expect(later.some(({ method }) => method === "eth_estimateGas")).toBe(false);
    setup.expectRedacted({ first, result });
  });

  it.each(["eth_chainId", "eth_call", "eth_getTransactionCount", "eth_getBlockByNumber", "eth_estimateGas"])(
    "an RPC failure at %s is unavailable and exposes no URL, raw transaction or server text", async (failureMethod) => {
      const setup = await fixture({}, { failureMethod });
      const result = await setup.broadcaster.submit(setup.input);
      expect(result).toEqual({ code: "rpc_unavailable" });
      expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
      setup.expectRedacted(result);
    });

  it("requires the RPC chain to equal the configured chain before any signing", async () => {
    const setup = await fixture({}, { chainId: 84532 });
    expect(await setup.broadcaster.submit(setup.input)).toEqual({ code: "refused", reason: "chain_mismatch" });
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
  });

  it("snapshots manually constructed caps before async work and rejects invalid config without input text", async () => {
    const setup = await fixture({ maxFeePerGasCap: "21" }, { baseFee: 20n });
    const mutable = { ...setup.chain };
    const broadcaster = createEvidenceBroadcaster({ chain: mutable }, setup.signer, { transport: setup.transport });
    mutable.maxFeePerGasCap = "1000";
    expect(await broadcaster.submit(setup.input)).toEqual({ code: "caps_exceeded", cap: "maxFeePerGasCap" });
    let error: unknown;
    try { createEvidenceBroadcaster({ chain: { ...mutable, gasCap: setup.rpcUrl } }, setup.signer); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(EvidenceChainConfigError);
    expect((error as Error).message).toBe("bad_config");
    setup.expectRedacted(error);
  });

  it("securely reads rpcUrlFile and refuses bad mode, malformed URL and unsupported remote HTTP", async () => {
    const setup = await fixture();
    await chmod(setup.chain.rpcUrlFile, 0o644);
    const badMode = await setup.broadcaster.submit(setup.input);
    expect(badMode).toEqual({ code: "rpc_unavailable" });
    await chmod(setup.chain.rpcUrlFile, 0o600);
    for (const url of [`${setup.rpcUrl}\nextra`, "http://remote.example.test", "https:///rpc.example.test", "https://rpc.example.test/ with-space"]) {
      await writeFile(setup.chain.rpcUrlFile, url);
      const result = await setup.broadcaster.submit(setup.input);
      expect(result).toEqual({ code: "rpc_unavailable" });
      setup.expectRedacted(result);
    }
    setup.expectRedacted(badMode);
    expect(setup.signer.signSubmitEvidenceTx).not.toHaveBeenCalled();
  });

  it("signing failures and invalid submission input contain only a closed refusal", async () => {
    const setup = await fixture();
    setup.signer.signSubmitEvidenceTx.mockRejectedValueOnce(new Error(setup.rpcUrl));
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "refused", reason: "signing_failed" });
    const invalid = await setup.broadcaster.submit({ ...setup.input, packageDigest: setup.rpcUrl as Hex });
    expect(invalid).toEqual({ code: "refused", reason: "bad_input" });
    setup.expectRedacted({ result, invalid });
  });
});
