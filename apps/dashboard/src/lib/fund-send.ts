import {
  DEFAULT_MARGIN_SECONDS, DRY_RUN_UNIT_TESTNET_V1, FundingRefusal,
  approveAndFund, dryRunUnitPrincipalWord, dryRunUnitTestnetExpectation, ensureEscrow,
  prepareFunding, readFundedState,
  type DryRunUnitTestnetExpectationInput, type FundingPins, type FundingExpectations, type PreparedFunding,
} from "@pcc/spec/funding";
import { erc20Abi, formatUnits, zeroHash, type Address, type PublicClient, type WalletClient } from "viem";

export type RefusalLabel = "L2" | "L5" | "L10a" | "L15" | "L16" | "L30" | "L31" | "L34";
export type FundingLabel = RefusalLabel | "L1" | "L18" | "L23" | "L32" | "L33" | "L37";
export type LabelResult = { kind: "label"; label: FundingLabel } | { kind: "label"; label: "L29"; held: string; needed: string };
export interface FundingIdentity { jobId: string; address: Address; sessionToken: string }
export interface CheckedDisplay {
  amount: string; escrow: string; operator: string; fundBy: string; refundableFrom: string; checkedAtBlock: string;
}
export interface CheckedOrder { kind: "checked"; prepared: PreparedFunding; display: CheckedDisplay }
export type CheckResult = CheckedOrder | LabelResult | { kind: "read_failed"; reason: unknown } | { kind: "busy" };
export type FundResult = LabelResult | { kind: "busy" };
export interface CheckOrderInput {
  scopeId: string;
  identity: FundingIdentity;
  payload: unknown;
  walletClient: WalletClient;
  publicClient: PublicClient;
  readOperator: () => Promise<unknown>;
  chainId?: number;
  pins?: FundingPins;
  expect?: FundingExpectations;
}
export interface FundOrderInput {
  scopeId: string;
  identity: FundingIdentity;
  checked: CheckedOrder;
  walletClient: WalletClient;
  publicClient: PublicClient;
}
export type FundingFlight =
  | { kind: "check"; identity: FundingIdentity; result: Promise<CheckResult> }
  | { kind: "send"; identity: FundingIdentity; display: CheckedDisplay; result: Promise<FundResult> };

export function buildSubject(payer: Address, operator: Address) {
  const unit = DRY_RUN_UNIT_TESTNET_V1;
  return {
    payer: dryRunUnitPrincipalWord(payer), operatorPrincipal: dryRunUnitPrincipalWord(operator),
    operatorSettlementAddress: operator.toLowerCase() as Address, authorizedTuplesRoot: zeroHash,
    committedProgramHash: unit.committedProgramHash, ...unit.zeroSubjectFields, integrityGrade: unit.integrityGrade,
  };
}

export function buildExpectation(input: Omit<DryRunUnitTestnetExpectationInput, "subject" | "bindings">) {
  return dryRunUnitTestnetExpectation({ ...input, subject: buildSubject(input.fundingWallet, input.operator), bindings: [] });
}

export function refusalLabel(error: unknown): RefusalLabel {
  if (!(error instanceof FundingRefusal)) return "L30";
  switch (error.code) {
    case "PAYER_NOT_SIGNER": return "L5";
    case "CHAIN_MISMATCH": return "L16";
    case "LIVE_CHECK_FAILED": return "L15";
    case "EXPIRY_TOO_SOON": case "RECLAIM_WINDOW": return "L10a";
    case "AMOUNT_EXCEEDS_QUOTE": case "DEPLOYMENT_MISMATCH": case "DOMAIN_MISMATCH":
    case "ESCROW_NOT_PREDICTED": case "FACTORY_NOT_PINNED": case "INTENT_MISMATCH":
    case "OPERATOR_SIGNATURE_INVALID": case "PIN_INVALID": case "POLICY_ROOT_MISMATCH":
    case "SIGNATURE_NOT_CANONICAL": case "TOKEN_NOT_PINNED": case "TOTAL_GROSS_MISMATCH":
    case "TYPED_DATA_MISMATCH": case "ALREADY_FUNDED": return "L2";
    case "PAYER_TX_PENDING": return "L31";
    case "SIMULATION_REVERTED": return "L34";
    default: return "L30";
  }
}

const flights = new Map<string, FundingFlight>();
export function runningFlight(scopeId: string): FundingFlight | undefined { return flights.get(scopeId); }
const sameIdentity = (a: FundingIdentity, b: FundingIdentity) =>
  a.jobId === b.jobId && a.address === b.address && a.sessionToken === b.sessionToken;
const label = (value: FundingLabel): LabelResult => ({ kind: "label", label: value });

function flight<T extends CheckResult | FundResult>(
  input: CheckOrderInput | FundOrderInput, kind: "check" | "send", run: () => Promise<T>,
): Promise<T> {
  const existing = flights.get(input.scopeId);
  if (existing) return existing.kind === kind && sameIdentity(existing.identity, input.identity)
    ? existing.result as Promise<T> : Promise.resolve({ kind: "busy" } as T);
  const result = Promise.resolve().then(run).catch((error: unknown) => label(refusalLabel(error)) as T).finally(() => {
    if (flights.get(input.scopeId)?.result === result) flights.delete(input.scopeId);
  });
  const identity = { ...input.identity };
  flights.set(input.scopeId, kind === "check" ? { kind, identity, result: result as Promise<CheckResult> }
    : { kind, identity, display: (input as FundOrderInput).checked.display, result: result as Promise<FundResult> });
  return result;
}

export function checkOrder(input: CheckOrderInput): Promise<CheckResult> {
  return flight(input, "check", async () => {
    let operator: unknown;
    try { operator = await input.readOperator(); }
    catch (reason) { return { kind: "read_failed", reason }; }
    if (typeof operator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(operator)) return label("L23");
    operator = operator.toLowerCase();
    let chainId: number;
    try { chainId = await input.walletClient.getChainId(); }
    catch { return label("L15"); }
    if (chainId !== (input.chainId ?? 84532)) return label("L16");
    let expect = input.expect;
    if (expect === undefined) {
      let timestamp: bigint;
      try { timestamp = (await input.publicClient.getBlock({ blockTag: "latest" })).timestamp; }
      catch { return label("L15"); }
      expect = buildExpectation({ jobId: input.identity.jobId, operator: operator as Address,
        fundingWallet: input.identity.address, latestBlockTimestamp: timestamp });
    }
    const prepared = await prepareFunding({ payload: input.payload, wallet: input.walletClient, publicClient: input.publicClient,
      quote: { maxTotalGross: DRY_RUN_UNIT_TESTNET_V1.g * BigInt(DRY_RUN_UNIT_TESTNET_V1.unitCount) }, expect,
      ...(input.pins === undefined ? {} : { pins: input.pins }) });
    let code;
    try { code = await input.publicClient.getCode({ address: prepared.escrow, blockTag: "latest" }); }
    catch { return label("L15"); }
    if (code && code !== "0x") {
      const state = await readFundedState({ publicClient: input.publicClient, prepared });
      if (state.kind === "funded_ours") return label("L18");
      if (state.kind === "other") return label("L2");
      if (state.kind === "unreadable") return label("L15");
    }
    let balance: bigint;
    try {
      balance = await input.publicClient.readContract({ address: prepared.usdc, abi: erc20Abi,
        functionName: "balanceOf", args: [prepared.payer], blockTag: "latest" });
    } catch { return label("L15"); }
    if (balance < prepared.totalGross) return { kind: "label", label: "L29",
      held: formatUnits(balance, 6), needed: formatUnits(prepared.totalGross, 6) };
    return { kind: "checked", prepared, display: {
      amount: `${formatUnits(prepared.totalGross, 6)} test USDC`, escrow: prepared.escrow, operator: prepared.operator,
      fundBy: new Date(Number(prepared.expiry - DEFAULT_MARGIN_SECONDS) * 1000).toISOString(),
      refundableFrom: new Date(Number(prepared.reclaimAt.earliest) * 1000).toISOString(),
      checkedAtBlock: prepared.verifiedAt.blockNumber.toString(),
    } };
  });
}

export function fundOrder(input: FundOrderInput): Promise<FundResult> {
  return flight(input, "send", async () => {
    const args = { prepared: input.checked.prepared, wallet: input.walletClient, publicClient: input.publicClient };
    const escrow = await ensureEscrow(args);
    if (escrow.outcome === "absent") return label("L32");
    if (escrow.outcome === "indeterminate") return label("L1");
    try {
      const result = await approveAndFund(args);
      return label(result.outcome === "committed" ? "L18" : result.outcome === "unchanged" ? "L33" : "L1");
    } catch (error) {
      return label(escrow.create?.kind === "mined" || escrow.create?.kind === "unknown" ? "L37" : refusalLabel(error));
    }
  });
}
