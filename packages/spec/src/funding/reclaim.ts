/** Payer refunds only: validate every unit and simulate every call before sending any transaction. */
import { encodeFunctionData, type Hex, type PublicClient, type WalletClient } from "viem";
import { assertChain, describeRevert, pinBlock, pinnedReader } from "./chain.js";
import { refuse } from "./errors.js";
import { chainForSend, sendAndWait, type SendResult } from "./fund.js";
import { readUnitStates, validateUnitsTarget, type UnitsTarget, type UnitStateName } from "./units.js";
import { ESCROW_ABI, MAX_UNITS, UNIT_FUNDED_ACTIVE, UNIT_REFUND_ALLOCATED, UNIT_SETTLED_REFUNDED, UNIT_STATE_NAMES } from "./vnext.js";

export type ReclaimOutcome = "reclaimed" | "unchanged" | "indeterminate";
export interface ReclaimUnitResult {
  unitId: Hex; outcome: ReclaimOutcome; send: SendResult; txHash?: Hex; refunded: boolean; detail: string;
  readBack: { state: number | null; stateName: UnitStateName | null; blockNumber: bigint | null; blockHash: Hex | null };
}
export interface ReclaimUnitsArgs extends UnitsTarget {
  wallet: WalletClient; publicClient: PublicClient; unitIds: readonly Hex[]; confirmations?: number; receiptTimeoutMs?: number;
}
export interface ReclaimResult { results: readonly ReclaimUnitResult[]; checkedAt: { blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint } }

/** The read-back decides whether the refund was allocated, even when this sender's transaction reverted. */
export function classifyReclaim(send: SendResult, readState: number | "unreadable"): ReclaimOutcome {
  if (readState === UNIT_REFUND_ALLOCATED || readState === UNIT_SETTLED_REFUNDED) return "reclaimed";
  const refused = send.kind === "not_sent" || (send.kind === "mined" && send.status === "reverted");
  return refused && readState === UNIT_FUNDED_ACTIVE ? "unchanged" : "indeterminate";
}

/** After sending starts, failures are per-unit results. Resolve indeterminate outcomes by reading before retrying. */
export async function reclaimUnits(args: ReclaimUnitsArgs): Promise<ReclaimResult> {
  const { wallet, publicClient, chainId, escrow, pins } = args;
  const account = wallet.account;
  if (!account) refuse("PAYER_NOT_SIGNER", "the wallet has no account to send with");
  const unitIds = Array.isArray(args.unitIds) ? Array.from(args.unitIds) : [];
  if (unitIds.length === 0 || unitIds.length > MAX_UNITS ||
      unitIds.some((id) => typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id)) ||
      new Set(unitIds.map((id) => id.toLowerCase())).size !== unitIds.length) {
    refuse("BAD_EXPECTATION", `unitIds must contain 1 to ${MAX_UNITS} distinct 32-byte hex strings`);
  }
  const opts = { confirmations: args.confirmations === undefined ? 1 : args.confirmations,
    timeout: args.receiptTimeoutMs === undefined ? 120_000 : args.receiptTimeoutMs };
  if (!Number.isInteger(opts.confirmations) || opts.confirmations <= 0) refuse("BAD_EXPECTATION", "confirmations must be a positive integer");
  if (!Number.isInteger(opts.timeout) || opts.timeout <= 0) refuse("BAD_EXPECTATION", "receiptTimeoutMs must be a positive integer");
  validateUnitsTarget(args);
  await assertChain(wallet, publicClient, chainId);
  const before = await readUnitStates({ publicClient, chainId, escrow, pins });
  if (before.kind === "unreadable") refuse("LIVE_CHECK_FAILED", before.detail);
  if (before.payer.toLowerCase() !== account.address.toLowerCase()) {
    refuse("PAYER_NOT_SIGNER", `the wallet is ${account.address}; the escrow's payer is ${before.payer}`);
  }
  for (const unitId of unitIds) {
    const unit = before.units.find((u) => u.unitId.toLowerCase() === unitId.toLowerCase());
    if (!unit) refuse("UNIT_NOT_ACTIVE", `unit ${unitId} is not a unit of escrow ${escrow}`);
    if (unit.state !== UNIT_FUNDED_ACTIVE) refuse("UNIT_NOT_ACTIVE", `unit ${unitId} is ${unit.stateName} (${unit.state}), not FUNDED_ACTIVE`);
    if (!(before.blockTimestamp >= unit.reclaimAt)) {
      refuse("NOT_RECLAIMABLE", `unit ${unitId} reclaimAt ${unit.reclaimAt} is later than pinned block timestamp ${before.blockTimestamp}`);
    }
  }
  let pendingNonce: number;
  let latestNonce: number;
  try {
    pendingNonce = await publicClient.getTransactionCount({ address: before.payer, blockTag: "pending" });
    latestNonce = await publicClient.getTransactionCount({ address: before.payer, blockTag: "latest" });
  } catch (e) {
    refuse("LIVE_CHECK_FAILED", `read the payer's nonce: ${describeRevert(e)}`);
  }
  if (pendingNonce > latestNonce) {
    refuse("PAYER_TX_PENDING", `the payer has ${pendingNonce - latestNonce} transaction(s) pending (nonce ${pendingNonce} at pending, ${latestNonce} at latest): resolve the earlier run with readUnitStates, or wait for those transactions, before retrying`);
  }
  const calls = unitIds.map((unitId) => ({ unitId,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "reclaimAfterDeadline", args: [unitId] }) }));
  for (const { unitId, data } of calls) {
    try {
      await publicClient.request({ method: "eth_call", params: [
        { from: before.payer, to: escrow, data }, { blockHash: before.blockHash, requireCanonical: true },
      ] } as never);
    } catch (e) {
      refuse("SIMULATION_REVERTED", `reclaimAfterDeadline(${unitId}) would revert: ${describeRevert(e)}`);
    }
  }

  const results: ReclaimUnitResult[] = [];
  let started = false;
  let unresolved = false;
  for (const { unitId, data } of calls) {
    let send: SendResult;
    if (unresolved) {
      send = { kind: "not_sent", reason: "not sent: an earlier reclaim in this call is unresolved" };
    } else {
      try {
        const chain = await chainForSend(wallet, chainId);
        started = true;
        send = await sendAndWait(wallet, publicClient, chain, chainId, escrow, data, opts);
      } catch (e) {
        if (!started) throw e;
        send = { kind: "not_sent", reason: describeRevert(e) };
      }
      if (send.kind !== "mined") unresolved = true;
    }
    const readBack: ReclaimUnitResult["readBack"] = { state: null, stateName: null, blockNumber: null, blockHash: null };
    let detail: string;
    try {
      const block = await pinBlock(publicClient, send.kind === "mined" ? send.blockHash : undefined);
      readBack.blockNumber = block.number;
      readBack.blockHash = block.hash;
      const state = await pinnedReader(publicClient, block.hash).read<number>(escrow, ESCROW_ABI, "unitState", [unitId]);
      readBack.state = state;
      readBack.stateName = UNIT_STATE_NAMES[state] ?? "UNKNOWN";
      detail = `unit ${unitId} reads ${readBack.stateName} (${state}) at block ${block.number}`;
    } catch (e) {
      detail = `could not read back unit ${unitId}: ${describeRevert(e)}`;
    }
    results.push({ unitId, send, txHash: send.kind === "not_sent" ? undefined : send.txHash,
      outcome: classifyReclaim(send, readBack.state ?? "unreadable"), refunded: readBack.state === UNIT_SETTLED_REFUNDED,
      readBack, detail });
  }
  return { results, checkedAt: { blockNumber: before.blockNumber, blockHash: before.blockHash, blockTimestamp: before.blockTimestamp } };
}
