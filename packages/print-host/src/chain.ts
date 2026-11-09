import {
  createPublicClient, decodeErrorResult, defineChain, encodeFunctionData, getAddress,
  http, keccak256, parseAbi, parseTransaction, zeroAddress, zeroHash,
  type Address, type Hex, type Transport,
} from "viem";
import { evidenceCommitment, settlementUnitId } from "@pcc/contracts/vnext";
import { validateHostChainConfig, type HostConfig } from "./config.js";
import type { OperatorKey } from "./keys.js";
import { readSecretFile } from "./secret-file.js";

// Escrow views and submitEvidence errors used by this broadcaster.
// Source: VNextSettlementEscrow.sol and contracts/ts/vnext/abi.ts.
const evidenceAbi = parseAbi([
  "function unitTerms(bytes32 unitId) view returns (uint256 milestoneIndex_, bytes32 stepId_, uint8 requestedTier_, uint256 reclaimAt_, bytes32 payoutConfigHash_, uint16 compositionSchemaVersion_, bool evidenceCommitted_)",
  "function jobIdHash() view returns (bytes32)",
  "function evidenceBundleHashOf(bytes32 unitId) view returns (bytes32)",
  "function submitEvidence(bytes32 unitId, bytes32 packageDigest)",
  "error EvidenceNotCommitted()", "error EvidenceAlreadyCommitted()",
  "error OnlyOperator()", "error NotActive()", "error TooLateForEvidence()",
  "error ZeroEvidenceDigest()", "error UnitNotFound()", "error Reentrancy()",
]);

export interface EvidenceSubmission {
  readonly escrow: Address;
  readonly unitId: Hex;
  readonly packageDigest: Hex;
  readonly compositionSchemaVersion: number;
}

export type EvidenceRefusalCode = "bad_input" | "chain_mismatch" | "unit_mismatch" | "signing_failed" |
  "transaction_reverted" | "unreconciled_transaction" | "unknown_revert" | "EvidenceNotCommitted" | "EvidenceAlreadyCommitted" |
  "OnlyOperator" | "NotActive" | "TooLateForEvidence" | "ZeroEvidenceDigest" |
  "UnitNotFound" | "Reentrancy";

/** Only closed codes and public transaction hashes cross the RPC boundary. */
export type EvidenceBroadcastOutcome =
  | Readonly<{ code: "submitted"; transactionHash: Hex }>
  | Readonly<{ code: "already_committed" }>
  | Readonly<{ code: "conflict" }>
  | Readonly<{ code: "indeterminate"; transactionHash?: Hex }>
  | Readonly<{ code: "refused"; reason: EvidenceRefusalCode; transactionHash?: Hex }>
  | Readonly<{ code: "caps_exceeded"; cap: "maxFeePerGasCap" | "maxPriorityFeePerGasCap" | "gasCap" }>
  | Readonly<{ code: "rpc_unavailable" }>;

export interface EvidenceBroadcaster {
  readonly submit: (input: EvidenceSubmission, options?: {
    /** Awaited after signing, immediately before the only raw transaction send. */
    beforeSend(sent: { transactionHash: Hex; nonce: number }): Promise<void>;
  }) => Promise<EvidenceBroadcastOutcome>;
  /** Uncommitted reads return refused/EvidenceNotCommitted; this method never signs or sends. */
  readonly readBack: (input: EvidenceSubmission) => Promise<EvidenceBroadcastOutcome>;
}

export interface EvidenceBroadcasterOptions {
  readonly expectedUid?: number;
  /** Tests may provide a viem transport. Reads still securely validate rpcUrlFile. */
  readonly transport?: Transport;
}

/** Fixed factory error; retains neither configuration values nor underlying errors. */
export class EvidenceChainConfigError extends Error {
  readonly code = "bad_config";
  constructor() { super("bad_config"); this.name = "EvidenceChainConfigError"; }
}

const knownReverts = new Set<EvidenceRefusalCode>([
  "EvidenceNotCommitted", "EvidenceAlreadyCommitted", "OnlyOperator", "NotActive",
  "TooLateForEvidence", "ZeroEvidenceDigest", "UnitNotFound", "Reentrancy",
]);

/**
 * Decoded send-time errors that release the attempt's nonce. Each is permanent
 * once observed, so a forwarded transaction can only revert. Any other decoded
 * selector (EvidenceNotCommitted, ZeroEvidenceDigest, UnitNotFound or
 * Reentrancy) proves no such thing: it reads back and keeps the nonce hold, as
 * unknown_revert does.
 */
const sendTimeRefusals = new Set<EvidenceRefusalCode>([
  "OnlyOperator", "NotActive", "TooLateForEvidence", "EvidenceAlreadyCommitted",
]);

/** Decode data, never messages/details or server-supplied error names. */
function revertCode(error: unknown): EvidenceRefusalCode | undefined {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < 12 && current !== null && typeof current === "object"; depth++) {
      const data = (current as { data?: unknown }).data;
      const raw = (current as { raw?: unknown }).raw ?? (typeof data === "string" ? data
        : data !== null && typeof data === "object" ? (data as { raw?: unknown }).raw : undefined);
      if (typeof raw === "string" && /^0x[0-9a-fA-F]{8}$/.test(raw)) {
        try {
          const decoded = decodeErrorResult({ abi: evidenceAbi, data: raw as Hex });
          if (knownReverts.has(decoded.errorName)) return decoded.errorName;
        } catch { /* Unknown data is reported only as a closed revert code. */ }
      }
      if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) return "unknown_revert";
      current = (current as { cause?: unknown }).cause;
    }
  } catch { /* Hostile error accessors cannot cross the boundary. */ }
  return undefined;
}

function snapshotInput(input: EvidenceSubmission): EvidenceSubmission | undefined {
  try {
    const escrow = getAddress(input.escrow);
    const unitId = input.unitId;
    const packageDigest = input.packageDigest;
    const compositionSchemaVersion = input.compositionSchemaVersion;
    if (escrow === zeroAddress || typeof unitId !== "string" || !/^0x[0-9a-f]{64}$/.test(unitId)
      || typeof packageDigest !== "string" || !/^0x[0-9a-f]{64}$/.test(packageDigest) || packageDigest === zeroHash
      || !Number.isInteger(compositionSchemaVersion) || compositionSchemaVersion < 0 || compositionSchemaVersion > 65_535) {
      return undefined;
    }
    return Object.freeze({ escrow, unitId, packageDigest, compositionSchemaVersion });
  } catch { return undefined; }
}

function rpcUrl(bytes: Buffer, chainId: number): string | undefined {
  const text = bytes.toString("utf8");
  const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!line || /\s/.test(line) || !/^https?:\/\/[^/\\?#]/i.test(line) || line.includes("\\")) return undefined;
  try {
    const url = new URL(line);
    return url.hostname && (url.protocol === "https:" || (chainId === 31337 && url.protocol === "http:"
      && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase()))) ? line : undefined;
  } catch { return undefined; }
}

/**
 * Library-only, operator-scoped broadcaster. Caps are captured before any await.
 * A sent/ambiguous unit is latched for this instance: reconciliation never re-sends.
 */
export function createEvidenceBroadcaster(
  config: Pick<HostConfig, "chain">,
  operator: Pick<OperatorKey, "address" | "signSubmitEvidenceTx">,
  options: EvidenceBroadcasterOptions = {},
): EvidenceBroadcaster {
  let settings: HostConfig["chain"];
  let address: Address;
  let signTransaction: OperatorKey["signSubmitEvidenceTx"];
  let expectedUid: number | undefined;
  let suppliedTransport: Transport | undefined;
  try {
    settings = validateHostChainConfig(config.chain);
    address = getAddress(operator.address);
    signTransaction = operator.signSubmitEvidenceTx;
    if (address === zeroAddress || typeof signTransaction !== "function") throw new EvidenceChainConfigError();
    expectedUid = options.expectedUid;
    suppliedTransport = options.transport;
    if (expectedUid !== undefined && (!Number.isSafeInteger(expectedUid) || expectedUid < 0)) throw new EvidenceChainConfigError();
  } catch { throw new EvidenceChainConfigError(); }
  const maxFeePerGasCap = BigInt(settings.maxFeePerGasCap ?? "0");
  const maxPriorityFeePerGasCap = BigInt(settings.maxPriorityFeePerGasCap ?? "0");
  const gasCap = BigInt(settings.gasCap ?? "0");
  const rpcTimeoutMs = settings.rpcTimeoutMs ?? 10_000;
  const receiptTimeoutMs = settings.receiptTimeoutMs ?? 60_000;
  const confirmations = settings.confirmations ?? 1;
  const pollingInterval = settings.pollingIntervalMs ?? 1_000;
  const attempted = new Map<string, { transactionHash: Hex; nonce: number; settled: boolean; released: boolean }>();
  // One operator has one pending nonce stream, including across distinct units.
  let queue = Promise.resolve();

  async function publicClient() {
    const bytes = await readSecretFile(settings.rpcUrlFile, { expectedUid });
    try {
      const url = rpcUrl(bytes, settings.chainId);
      if (url === undefined) throw new Error("rpc_unavailable");
      // Disable all transport retries, particularly sendRawTransaction retries.
      // An injected transport also receives retryCount:0 below.
      const transport: Transport = suppliedTransport === undefined
        ? http(url, { timeout: rpcTimeoutMs, retryCount: 0 })
        : (parameters) => suppliedTransport!({ ...parameters, retryCount: 0 });
      return createPublicClient({ chain: defineChain({ id: settings.chainId, name: "PCC testnet",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } }),
      transport, pollingInterval });
    } finally { bytes.fill(0); }
  }

  type Client = Awaited<ReturnType<typeof publicClient>>;
  type Read = { code: "uncommitted" } | EvidenceBroadcastOutcome;
  async function frozenCommitment(client: Client, input: EvidenceSubmission): Promise<
    { expected: Hex } | EvidenceBroadcastOutcome
  > {
    try {
      const [milestoneIndex, stepId, , , , compositionSchemaVersion] = await client.readContract({
        address: input.escrow, abi: evidenceAbi, functionName: "unitTerms", args: [input.unitId] });
      const jobIdHash = await client.readContract({ address: input.escrow, abi: evidenceAbi,
        functionName: "jobIdHash" });
      const chainId = BigInt(settings.chainId);
      // fund() derived the id with block.chainid and these frozen fields.
      // Equality proves the configured chain is the unit's frozen chain.
      if (settlementUnitId({ chainId, escrow: input.escrow, jobIdHash, milestoneIndex, stepId }) !== input.unitId) {
        return { code: "refused", reason: "chain_mismatch" };
      }
      if (compositionSchemaVersion !== input.compositionSchemaVersion) return { code: "refused", reason: "unit_mismatch" };
      return { expected: evidenceCommitment({ chainId, escrow: input.escrow, settlementUnitId: input.unitId,
        compositionSchemaVersion, packageDigest: input.packageDigest }) };
    } catch (error) {
      const reason = revertCode(error);
      return reason === undefined ? { code: "rpc_unavailable" } : { code: "refused", reason };
    }
  }

  async function read(client: Client, input: EvidenceSubmission, expected: Hex): Promise<Read> {
    try {
      const actual = await client.readContract({ address: input.escrow, abi: evidenceAbi,
        functionName: "evidenceBundleHashOf", args: [input.unitId] });
      return { code: actual.toLowerCase() === expected ? "already_committed" : "conflict" };
    } catch (error) {
      const reason = revertCode(error);
      return reason === "EvidenceNotCommitted" ? { code: "uncommitted" }
        : reason === undefined ? { code: "rpc_unavailable" } : { code: "refused", reason };
    }
  }

  async function reconcileRefusal(client: Client, input: EvidenceSubmission, expected: Hex,
    transactionHash: Hex, reason: EvidenceRefusalCode): Promise<EvidenceBroadcastOutcome> {
    const reconciled = await read(client, input, expected);
    if (reconciled.code === "already_committed" || reconciled.code === "conflict") return reconciled;
    return reconciled.code === "uncommitted" ? { code: "refused", reason, transactionHash }
      : { code: "indeterminate", transactionHash };
  }

  async function connect(): Promise<Client | undefined> {
    try { return await publicClient(); } catch { return undefined; }
  }

  async function checkedClient(): Promise<Client | EvidenceBroadcastOutcome> {
    const client = await connect();
    if (client === undefined) return { code: "rpc_unavailable" };
    try {
      if (await client.getChainId() !== settings.chainId) return { code: "refused", reason: "chain_mismatch" };
      return client;
    } catch { return { code: "rpc_unavailable" }; }
  }

  async function submit(input: EvidenceSubmission, key: string,
    options?: Parameters<EvidenceBroadcaster["submit"]>[1]): Promise<EvidenceBroadcastOutcome> {
    const previous = attempted.get(key);
    if (previous !== undefined) return { code: "indeterminate", transactionHash: previous.transactionHash };
    const client = await checkedClient();
    if ("code" in client) return client;
    const frozen = await frozenCommitment(client, input);
    if ("code" in frozen) return frozen;
    const { expected } = frozen;
    const before = await read(client, input, expected);
    if (before.code !== "uncommitted") return before;
    const data = encodeFunctionData({ abi: evidenceAbi, functionName: "submitEvidence", args: [input.unitId, input.packageDigest] });
    let nonce: number;
    let gas: bigint;
    let maxFeePerGas: bigint;
    let maxPriorityFeePerGas: bigint;
    try {
      const unsettled = [...attempted.entries()].filter(([otherKey, attempt]) => otherKey !== key && !attempt.settled && !attempt.released);
      if (unsettled.length > 0) {
        const latest = await client.getTransactionCount({ address, blockTag: "latest" });
        for (const [, attempt] of unsettled) if (attempt.nonce < latest) attempt.settled = true;
        if (unsettled.some(([, attempt]) => !attempt.settled)) return { code: "refused", reason: "unreconciled_transaction" };
      }
      nonce = await client.getTransactionCount({ address, blockTag: "pending" });
      // Even a settled transaction must not be replaced by a lagging pending view.
      for (const attempt of attempted.values()) {
        if (!attempt.released && nonce <= attempt.nonce) return { code: "refused", reason: "unreconciled_transaction" };
      }
      const fees = await client.estimateFeesPerGas({ type: "eip1559" });
      maxFeePerGas = fees.maxFeePerGas;
      maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      if (maxFeePerGas > maxFeePerGasCap) return { code: "caps_exceeded", cap: "maxFeePerGasCap" };
      if (maxPriorityFeePerGas > maxPriorityFeePerGasCap) return { code: "caps_exceeded", cap: "maxPriorityFeePerGasCap" };
      gas = await client.estimateGas({ account: address, to: input.escrow,
        data,
        value: 0n, nonce, maxFeePerGas, maxPriorityFeePerGas });
      if (gas > gasCap) return { code: "caps_exceeded", cap: "gasCap" };
    } catch (error) {
      const reason = revertCode(error);
      if (reason === "EvidenceAlreadyCommitted") {
        const reconciled = await read(client, input, expected);
        if (reconciled.code === "already_committed" || reconciled.code === "conflict") return reconciled;
      }
      return reason === undefined ? { code: "rpc_unavailable" } : { code: "refused", reason };
    }
    let serializedTransaction: Hex;
    let transactionHash: Hex;
    try {
      serializedTransaction = await signTransaction.call(operator, { escrow: input.escrow, unitId: input.unitId,
        packageDigest: input.packageDigest, nonce, gas, maxFeePerGas, maxPriorityFeePerGas });
      if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(serializedTransaction)) throw new Error("signing_failed");
      const signed = parseTransaction(serializedTransaction);
      if (signed.chainId !== settings.chainId || signed.to?.toLowerCase() !== input.escrow.toLowerCase()
        || signed.data?.toLowerCase() !== data || signed.nonce !== nonce || (signed.gas ?? 0n) !== gas
        || (signed.maxFeePerGas ?? 0n) !== maxFeePerGas || (signed.maxPriorityFeePerGas ?? 0n) !== maxPriorityFeePerGas
        || signed.type !== "eip1559" || (signed.value ?? 0n) !== 0n) throw new Error("signing_failed");
      transactionHash = keccak256(serializedTransaction);
    } catch { return { code: "refused", reason: "signing_failed" }; }
    // Latch BEFORE sending: an RPC timeout may mean the node accepted the tx.
    const attempt = { transactionHash, nonce, settled: false, released: false };
    attempted.set(key, attempt);
    try {
      // The caller's durable boundary must complete before anything can be sent.
      await options?.beforeSend({ transactionHash, nonce });
    } catch (error) {
      // A failed boundary is provably unsent; both this unit and its nonce may retry.
      attempted.delete(key);
      throw error;
    }
    try {
      const sentHash = await client.sendRawTransaction({ serializedTransaction });
      if (sentHash.toLowerCase() !== transactionHash) return { code: "indeterminate", transactionHash };
    } catch (error) {
      const reason = revertCode(error);
      if (reason !== undefined && sendTimeRefusals.has(reason)) {
        // A decoded refusal releases the nonce, but the unit remains one-shot.
        attempt.released = true;
        return reconcileRefusal(client, input, expected, transactionHash, reason);
      }
      const reconciled = await read(client, input, expected);
      if (reconciled.code === "already_committed" || reconciled.code === "conflict") return reconciled;
      return { code: "indeterminate", transactionHash };
    }
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations,
        timeout: receiptTimeoutMs, pollingInterval, retryCount: 0 });
      attempt.settled = true;
      if (receipt.status !== "success") return reconcileRefusal(client, input, expected, transactionHash, "transaction_reverted");
    } catch { return { code: "indeterminate", transactionHash }; }
    const after = await read(client, input, expected);
    if (after.code === "already_committed") return { code: "submitted", transactionHash };
    if (after.code === "conflict") return after;
    return { code: "indeterminate", transactionHash };
  }

  return Object.freeze({
    async submit(input: EvidenceSubmission,
      options?: Parameters<EvidenceBroadcaster["submit"]>[1]): Promise<EvidenceBroadcastOutcome> {
      const snapshot = snapshotInput(input);
      if (snapshot === undefined) return { code: "refused", reason: "bad_input" };
      const key = `${snapshot.escrow.toLowerCase()}:${snapshot.unitId}`;
      // Serialize this instance's operator nonce stream, including distinct units.
      const pending = queue.then(() => submit(snapshot, key, options));
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    },
    async readBack(input: EvidenceSubmission): Promise<EvidenceBroadcastOutcome> {
      const snapshot = snapshotInput(input);
      if (snapshot === undefined) return { code: "refused", reason: "bad_input" };
      const client = await checkedClient();
      if ("code" in client) return client;
      const frozen = await frozenCommitment(client, snapshot);
      if ("code" in frozen) return frozen;
      const outcome = await read(client, snapshot, frozen.expected);
      return outcome.code === "uncommitted" ? { code: "refused", reason: "EvidenceNotCommitted" } : outcome;
    },
  });
}
