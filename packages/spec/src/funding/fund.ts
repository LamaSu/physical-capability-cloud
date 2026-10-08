/**
 * `approveAndFund`: the buyer's two transactions, and the funding read-back. Author: implementer-bravo (pcc-adk).
 *
 *   1. `USDC.approve(escrow, ΣG)`: exactly ΣG, never unlimited, to the verified escrow (plan §3 step 5).
 *   2. `escrow.fund(configs, {expiry, payerSignature: 0x, operatorSignature})`: the payer sends it, so the payer
 *      leg is implicit and its signature bytes are empty (ESC:718, FAC:253).
 * Each call is encoded once from the frozen `PreparedFunding`, simulated with `eth_call` from the payer using
 * those same bytes, then sent with `dataSuffix: "0x"` so a client-configured suffix cannot change them.
 *
 * FUNDED IS READ FROM THE CONTRACT (plan G5), never inferred from a receipt, a tx hash or a USDC balance. It
 * means `policy().jobPolicyHash_` equals the hash this SDK recomputed. The escrow writes that value only in
 * `_acceptPolicy` (ESC:893), after checking keccak256(configs) against the root its address commits to (ESC:873)
 * and both signatures (FAC:253-256), and in the same transaction that pulls exactly ΣG from the payer (ESC:843).
 *
 * THREE OUTCOMES (verify-writes-three-outcomes):
 *   committed      the read-back shows this exact policy funded;
 *   unchanged      the send was refused for certain (never broadcast, or mined and reverted) AND the read-back
 *                  shows the escrow unfunded;
 *   indeterminate  anything else: a broadcast with no receipt, a successful receipt whose read-back is not
 *                  "funded" (a stale read or a reorg), funding under another acceptance, or an unreadable state.
 * Indeterminate is not success. Call `readFundedState` later to resolve it; a retried `approveAndFund` returns
 * `committed` without sending if the escrow is by then funded under this policy.
 */
import { encodeFunctionData, zeroAddress, zeroHash, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { assertChain, describeRevert, pinBlock, pinnedReader, type PinnedBlock } from "./chain.js";
import { refuse } from "./errors.js";
import { DEFAULT_MARGIN_SECONDS, assertPrepared, checkTiming, type PreparedFunding } from "./prepare.js";
import { ERC20_ABI, ESCROW_ABI, FACTORY_ABI } from "./vnext.js";

export type FundedStateKind = "funded_ours" | "unfunded" | "other" | "unreadable";

export interface FundedState {
  kind: FundedStateKind;
  detail: string;
  /** The block the state was read at (by hash); null if no block could be pinned. */
  blockNumber: bigint | null;
  blockHash: Hex | null;
  /** `unitState` of each unit, in funding order, when funded under this policy (1 = FUNDED_ACTIVE). */
  unitStates: readonly number[];
}

export type SendResult =
  | { kind: "not_sent"; reason: string }
  | { kind: "unknown"; txHash?: Hex; reason: string }
  | { kind: "mined"; txHash: Hex; status: "success" | "reverted"; blockHash: Hex };

export type FundingOutcome = "committed" | "unchanged" | "indeterminate";

export interface FundingResult {
  outcome: FundingOutcome;
  /** The escrow was already funded under this exact policy before anything was sent; nothing was sent. */
  alreadyFunded: boolean;
  /** The last step attempted. */
  stage: "precheck" | "approve" | "fund";
  approveTx?: Hex;
  fundTx?: Hex;
  /** The funding read-back the outcome rests on. */
  readBack: FundedState;
  detail: string;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The three-outcome rule for funding, as a pure function of what the send did and what the read shows. */
export function classifyFunding(send: SendResult, read: FundedStateKind): FundingOutcome {
  if (read === "funded_ours") return "committed";
  const refused = send.kind === "not_sent" || (send.kind === "mined" && send.status === "reverted");
  return refused && read === "unfunded" ? "unchanged" : "indeterminate";
}

async function fundedStateAt(publicClient: PublicClient, block: PinnedBlock, prepared: PreparedFunding): Promise<FundedState> {
  const reader = pinnedReader(publicClient, block.hash);
  const state = (kind: FundedStateKind, detail: string, unitStates: readonly number[] = []): FundedState => ({
    kind,
    detail,
    blockNumber: block.number,
    blockHash: block.hash,
    unitStates,
  });
  try {
    const [, , , policyHash] = await reader.read<readonly [Address, bigint, Hex, Hex, Hex]>(prepared.escrow, ESCROW_ABI, "policy");
    if (same(policyHash, prepared.jobPolicyHash)) {
      const unitStates: number[] = [];
      for (const id of prepared.unitIds) unitStates.push(await reader.read<number>(prepared.escrow, ESCROW_ABI, "unitState", [id]));
      return state("funded_ours", `policy().jobPolicyHash_ is this policy's ${prepared.jobPolicyHash}`, unitStates);
    }
    if (!same(policyHash, zeroHash)) {
      return state("other", `the escrow is funded under another acceptance: policy().jobPolicyHash_ is ${policyHash}, not ${prepared.jobPolicyHash}`);
    }
    const fundedEscrow = await reader.read<Address>(prepared.factory, FACTORY_ABI, "fundedEscrowOf", [prepared.policyKey]);
    if (!same(fundedEscrow, zeroAddress)) {
      return state("other", `this job is already funded by escrow ${fundedEscrow} (factory.fundedEscrowOf); this escrow can never fund`);
    }
    return state("unfunded", "policy().jobPolicyHash_ is zero and no escrow is funded for this job");
  } catch (e) {
    return state("unreadable", `the funding state could not be read at block ${block.number}: ${describeRevert(e)}`);
  }
}

/** The escrow's funding state at a block (the latest by default), read by block hash. Never throws for chain reasons. */
export async function readFundedState(args: { publicClient: PublicClient; prepared: PreparedFunding; blockHash?: Hex }): Promise<FundedState> {
  const prepared = assertPrepared(args.prepared);
  let block: PinnedBlock;
  try {
    block = await pinBlock(args.publicClient, args.blockHash);
  } catch (e) {
    return { kind: "unreadable", detail: `could not pin the block: ${describeRevert(e)}`, blockNumber: null, blockHash: null, unitStates: [] };
  }
  return fundedStateAt(args.publicClient, block, prepared);
}

async function sendAndWait(
  wallet: WalletClient,
  publicClient: PublicClient,
  to: Address,
  data: Hex,
  opts: { confirmations: number; timeout: number },
): Promise<SendResult> {
  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain ?? null, to, data, dataSuffix: "0x" });
  } catch (e) {
    // A throw here cannot prove nothing was broadcast (a transport error can follow acceptance), so it is unknown.
    return { kind: "unknown", reason: `the send threw and may have been broadcast: ${describeRevert(e)}` };
  }
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: opts.confirmations, timeout: opts.timeout });
    return { kind: "mined", txHash: hash, status: receipt.status, blockHash: receipt.blockHash };
  } catch (e) {
    return { kind: "unknown", txHash: hash, reason: `no receipt for ${hash}: ${describeRevert(e)}` };
  }
}

export interface ApproveAndFundArgs {
  prepared: PreparedFunding;
  wallet: WalletClient;
  publicClient: PublicClient;
  marginSeconds?: bigint;
  /** Confirmations to wait for each receipt. Default 1. */
  confirmations?: number;
  /** How long to wait for each receipt. Default 120000 ms. */
  receiptTimeoutMs?: number;
}

export async function approveAndFund(args: ApproveAndFundArgs): Promise<FundingResult> {
  const prepared = assertPrepared(args.prepared);
  const { wallet, publicClient } = args;
  const margin = args.marginSeconds ?? DEFAULT_MARGIN_SECONDS;
  if (typeof margin !== "bigint" || margin < 0n) throw new TypeError("marginSeconds must be a non-negative bigint");
  const opts = { confirmations: args.confirmations ?? 1, timeout: args.receiptTimeoutMs ?? 120_000 };
  const account = wallet.account;
  if (!account) refuse("PAYER_NOT_SIGNER", "the wallet has no account to send with");
  if (!same(account.address, prepared.payer)) refuse("PAYER_NOT_SIGNER", `the wallet is ${account.address}; the policy's payer is ${prepared.payer}`);
  await assertChain(wallet, publicClient, prepared.chainId);

  // Pre-checks at one pinned block. A refusal here means nothing was sent.
  let block: PinnedBlock;
  try {
    block = await pinBlock(publicClient);
  } catch (e) {
    refuse("LIVE_CHECK_FAILED", `pin the latest block: ${describeRevert(e)}`);
  }
  let code: Hex;
  try {
    code = await pinnedReader(publicClient, block.hash).code(prepared.escrow);
  } catch (e) {
    refuse("LIVE_CHECK_FAILED", `read the escrow's code: ${describeRevert(e)}`);
  }
  if (code === "0x") refuse("ESCROW_NOT_CREATED", `no clone at ${prepared.escrow} yet: the gateway creates it (factory.createEscrow) before funding`);
  const before = await fundedStateAt(publicClient, block, prepared);
  if (before.kind === "funded_ours") {
    return { outcome: "committed", alreadyFunded: true, stage: "precheck", readBack: before, detail: "already funded under this policy; nothing was sent" };
  }
  if (before.kind === "other") refuse("ALREADY_FUNDED", before.detail);
  if (before.kind === "unreadable") refuse("LIVE_CHECK_FAILED", before.detail);
  checkTiming(prepared, block.timestamp, margin);

  // 1. approve(escrow, ΣG), from the frozen prepared values: the verified escrow, exactly ΣG.
  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [prepared.escrow, prepared.totalGross] });
  try {
    await publicClient.call({ account: prepared.payer, to: prepared.usdc, data: approveData });
  } catch (e) {
    refuse("SIMULATION_REVERTED", `approve(${prepared.escrow}, ${prepared.totalGross}) would revert: ${describeRevert(e)}`);
  }
  const approve = await sendAndWait(wallet, publicClient, prepared.usdc, approveData, opts);
  const approveTx = approve.kind === "not_sent" ? undefined : approve.txHash;
  const stopAtApprove = async (why: string): Promise<FundingResult> => {
    const readBack = await readFundedState({ publicClient, prepared });
    return {
      outcome: classifyFunding({ kind: "not_sent", reason: why }, readBack.kind),
      alreadyFunded: false,
      stage: "approve",
      approveTx,
      readBack,
      detail: `${why}; fund() was not sent`,
    };
  };
  if (approve.kind !== "mined") return stopAtApprove(`the approve's outcome is unknown: ${approve.reason}`);
  if (approve.status !== "success") return stopAtApprove(`the approve ${approve.txHash} reverted`);
  let allowance: bigint | undefined;
  try {
    allowance = await pinnedReader(publicClient, approve.blockHash).read<bigint>(prepared.usdc, ERC20_ABI, "allowance", [prepared.payer, prepared.escrow]);
  } catch {
    allowance = undefined;
  }
  if (allowance !== prepared.totalGross) {
    return stopAtApprove(`the allowance read back at the approve's block is ${allowance ?? "unreadable"}, not ΣG ${prepared.totalGross}`);
  }

  // 2. fund(configs, {expiry, payerSignature: 0x, operatorSignature}): the exact args the escrow verifies.
  const fundData = encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: "fund",
    args: [
      prepared.configs.map((c) => ({ ...c, payouts: c.payouts.map((p) => ({ recipient: p.recipient, amount: p.amount })) })),
      { expiry: prepared.expiry, payerSignature: "0x", operatorSignature: prepared.operatorSignature },
    ],
  });
  try {
    await publicClient.call({ account: prepared.payer, to: prepared.escrow, data: fundData });
  } catch (e) {
    const why = describeRevert(e);
    const readBack = await readFundedState({ publicClient, prepared });
    return {
      outcome: classifyFunding({ kind: "not_sent", reason: why }, readBack.kind),
      alreadyFunded: false,
      stage: "fund",
      approveTx,
      readBack,
      detail: `fund() would revert (${why}); it was not sent. The approve stands: allowance ${prepared.totalGross} to the escrow`,
    };
  }
  const fund = await sendAndWait(wallet, publicClient, prepared.escrow, fundData, opts);
  const readBack =
    fund.kind === "mined"
      ? await readFundedState({ publicClient, prepared, blockHash: fund.blockHash })
      : await readFundedState({ publicClient, prepared });
  const outcome = classifyFunding(fund, readBack.kind);
  return {
    outcome,
    alreadyFunded: false,
    stage: "fund",
    approveTx,
    fundTx: fund.kind === "not_sent" ? undefined : fund.txHash,
    readBack,
    detail:
      fund.kind === "mined"
        ? `fund() ${fund.txHash} mined (${fund.status}); read back at its block: ${readBack.detail}`
        : `${fund.reason}; read back at the latest block: ${readBack.detail}`,
  };
}
