import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, getAddress, keccak256,
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

type FakeOptions = {
  chainId?: number;
  baseFee?: bigint;
  priorityFee?: bigint;
  gas?: bigint;
  commitment?: Hex;
  afterSendCommitment?: Hex;
  estimateRevert?: "NotActive" | "OnlyOperator" | "TooLateForEvidence" | "EvidenceAlreadyCommitted";
  readRevert?: "UnitNotFound";
  receiptStatus?: "success" | "reverted" | "timeout";
  failureMethod?: string;
  postSendReadFailure?: boolean;
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
  const input: EvidenceSubmission = { escrow: getAddress(`0x${randomBytes(20).toString("hex")}`),
    unitId: bytes32(), packageDigest: bytes32(), compositionSchemaVersion: 0 };
  const raw = `0x${randomBytes(128).toString("hex")}` as Hex;
  const hash = keccak256(raw);
  const calls: { method: string; params: unknown }[] = [];
  let estimatedUnit = input.unitId;
  const sentUnits = new Set<Hex>();
  const logs = ["log", "warn", "error", "debug", "info"].map((method) =>
    vi.spyOn(console, method as "log").mockImplementation(() => undefined));
  const serverText = `${rpcUrl} ${raw} ${randomBytes(24).toString("base64url")}`;
  const signer = { address: getAddress(`0x${randomBytes(20).toString("hex")}`),
    signSubmitEvidenceTx: vi.fn(async (_value: SubmitEvidenceTxInput) => raw) };
  function reject(errorName: typeof errorAbi[number]["name"]): never {
    throw { code: 3, message: serverText, data: encodeErrorResult({ abi: errorAbi, errorName }) };
  }
  const transport = custom({ request: async ({ method, params }) => {
    calls.push({ method, params });
    if (fake.failureMethod === method) throw { code: -32603, message: serverText };
    switch (method) {
      case "eth_chainId": return numberToHex(fake.chainId ?? 31337);
      case "eth_call": {
        const decoded = decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data });
        const unitId = decoded.args[0];
        const sent = sentUnits.has(unitId);
        if (fake.readRevert !== undefined) reject(fake.readRevert);
        if (sent && fake.postSendReadFailure) throw { code: -32603, message: serverText };
        const commitment = sent ? fake.afterSendCommitment ?? contractCommitment({ ...input, unitId }) : fake.commitment;
        if (commitment === undefined) reject("EvidenceNotCommitted");
        return commitment;
      }
      case "eth_getTransactionCount": return numberToHex(7 + sentUnits.size);
      case "eth_getBlockByNumber": return { number: "0x1", hash: bytes32(), parentHash: bytes32(),
        timestamp: "0x1", baseFeePerGas: numberToHex(fake.baseFee ?? 10n),
        gasLimit: "0xffffff", gasUsed: "0x0", transactions: [] };
      case "eth_maxPriorityFeePerGas": return numberToHex(fake.priorityFee ?? 2n);
      case "eth_estimateGas":
        if (fake.estimateRevert !== undefined) reject(fake.estimateRevert);
        estimatedUnit = decodeFunctionData({ abi: functions, data: (params as [{ data: Hex }])[0].data }).args[0];
        return numberToHex(fake.gas ?? 50_000n);
      case "eth_sendRawTransaction": sentUnits.add(estimatedUnit); return hash;
      case "eth_getTransactionReceipt":
        if (fake.receiptStatus === "timeout") return null;
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
  return { broadcaster, input, signer, chain, raw, hash, calls, rpcUrl, expectRedacted, fake, transport };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("submitEvidence broadcaster", () => {
  it("signs with the pending nonce, sends exactly once, and verifies the contract-formula commitment", async () => {
    const setup = await fixture();
    const result = await setup.broadcaster.submit(setup.input);
    expect(result).toEqual({ code: "submitted", transactionHash: setup.hash });
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    expect(setup.calls.filter(({ method }) => method === "eth_call")).toHaveLength(2);
    expect(setup.calls.find(({ method }) => method === "eth_getTransactionCount")?.params).toEqual([setup.signer.address, "pending"]);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledTimes(1);
    expect(setup.signer.signSubmitEvidenceTx).toHaveBeenCalledWith({ escrow: setup.input.escrow,
      unitId: setup.input.unitId, packageDigest: setup.input.packageDigest, nonce: 7, gas: 50_000n,
      maxFeePerGas: 14n, maxPriorityFeePerGas: 2n });
    setup.expectRedacted(result);
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
        if (request.method === "eth_call") {
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
      const setup = await fixture();
      const input = { ...setup.input, compositionSchemaVersion: index * 5_000 };
      setup.fake.commitment = contractCommitment(input);
      expect(await setup.broadcaster.readBack(input)).toEqual({ code: "already_committed" });
      expect(await setup.broadcaster.readBack({ ...input, compositionSchemaVersion: input.compositionSchemaVersion + 1 })).toEqual({ code: "conflict" });
    }
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
    setup.expectRedacted(result);
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
    const second = { ...setup.input, unitId: bytes32() };
    const results = await Promise.all([setup.broadcaster.submit(setup.input), setup.broadcaster.submit(second)]);
    expect(results.map((result) => result.code)).toEqual(["submitted", "submitted"]);
    expect(setup.signer.signSubmitEvidenceTx.mock.calls.map(([input]) => input.nonce)).toEqual([7, 8]);
    expect(setup.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    setup.expectRedacted(results);
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
