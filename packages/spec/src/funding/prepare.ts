/**
 * `prepareFunding`: verify a gateway's prepare payload before the buyer signs or sends anything. Author:
 * implementer-bravo (pcc-adk).
 *
 * It recomputes everything it can and refuses on any difference. It never repairs a payload (buyer-funding plan
 * S3.1; the check list and the source of each check are in the design note and on each refusal below). On
 * success it returns a deep-frozen `PreparedFunding`, registered in a module-private set. `signJobPolicy` and
 * `approveAndFund` accept nothing else, so neither can be handed unverified terms.
 *
 * ESC = packages/contracts/src/VNextSettlementEscrow.sol, FAC = .../VNextSettlementEscrowFactory.sol.
 */
import {
  getAddress,
  hexToBigInt,
  hexToNumber,
  recoverAddress,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { assertChain, describeRevert, pinBlock, pinnedReader } from "./chain.js";
import { refuse } from "./errors.js";
import { parsePreparePayload, type PreparePayload } from "./payload.js";
import { resolvePins, type FundingPins } from "./pins.js";
import {
  ECDSA_S_MAX,
  ESCROW_ABI,
  FACTORY_ABI,
  JOB_POLICY_FIELDS,
  MAX_RECLAIM_DELAY,
  MIN_RECLAIM_DELAY,
  POLICY_VERSION,
  acceptanceDigest,
  domainSeparator,
  jobPolicyHash,
  jobPolicyTypedData,
  policyKey,
  policySalt,
  prePolicyRoot,
  predictEscrow,
  settlementUnitId,
  unitsRoot,
  type JobPolicyMessage,
  type JobPolicyTypedData,
  type UnitConfig,
} from "./vnext.js";

/** Seconds the acceptance must outlive the latest block, and the slack kept above the 10-day reclaim floor. */
export const DEFAULT_MARGIN_SECONDS = 300n;

export interface PrepareFundingArgs {
  /** The gateway's prepare response, JSON-decoded (`pcc.vnext.buyer-funding.prepare.v1`). */
  payload: unknown;
  /** The buyer's viem wallet: an EOA account that signs and sends. */
  wallet: WalletClient;
  /** Reads the chain the payload names. */
  publicClient: PublicClient;
  /** The buyer-approved quote: ΣG above it is refused. */
  quote: { maxTotalGross: bigint };
  /** Extra pins by chain id; required for the factory until a V-next deployment is pinned in this module. */
  pins?: FundingPins;
  marginSeconds?: bigint;
}

/** A payload that passed every check, with every value the SDK recomputed. Deep-frozen. */
export interface PreparedFunding {
  readonly chainId: bigint;
  readonly factory: Address;
  readonly implementation: Address;
  readonly escrow: Address;
  readonly usdc: Address;
  readonly payer: Address;
  readonly operator: Address;
  /** ΣG: exactly what `fund()` pulls from the payer, and exactly what the approve allows. */
  readonly totalGross: bigint;
  readonly expiry: bigint;
  readonly configs: readonly UnitConfig[];
  readonly unitIds: readonly Hex[];
  readonly prePolicyRoot: Hex;
  /** The EIP-712 struct hash: `policy().jobPolicyHash_` reads back exactly this once funded. */
  readonly jobPolicyHash: Hex;
  readonly digest: Hex;
  readonly policyKey: Hex;
  /** The SDK's own typed data: the only thing `signJobPolicy` signs. */
  readonly typedData: JobPolicyTypedData;
  readonly operatorSignature: Hex;
  /** When the money is locked until: a unit refunds at its reclaimAt unless it is released first (plan G14). */
  readonly reclaimAt: { readonly earliest: bigint; readonly latest: bigint };
  /** The block the live checks ran at. */
  readonly verifiedAt: { readonly blockNumber: bigint; readonly blockHash: Hex; readonly blockTimestamp: bigint };
}

const PREPARED = new WeakSet<object>();

/** Only an object `prepareFunding` returned passes; a structurally identical copy does not. */
export function assertPrepared(x: unknown): PreparedFunding {
  if (typeof x !== "object" || x === null || !PREPARED.has(x)) {
    refuse("NOT_PREPARED", "pass the object prepareFunding returned; nothing else is signed or sent");
  }
  return x as PreparedFunding;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** What the factory's ECDSA leg accepts (FAC:375-387): 65 bytes, v in {27, 28}, s <= secp256k1n / 2. */
export function eoaSignatureProblem(signature: Hex): string | undefined {
  if (size(signature) !== 65) return `the signature is ${size(signature)} bytes; an EOA signature is 65`;
  const v = hexToNumber(slice(signature, 64, 65));
  if (v !== 27 && v !== 28) return `v is ${v}; the factory accepts only 27 or 28`;
  if (hexToBigInt(slice(signature, 32, 64)) > ECDSA_S_MAX) return "s is above secp256k1n / 2; the factory rejects it";
  return undefined;
}

/** The address an EOA signature over `digest` recovers to, or undefined if it does not recover. */
export async function recoverSigner(digest: Hex, signature: Hex): Promise<Address | undefined> {
  try {
    return await recoverAddress({ hash: digest, signature });
  } catch {
    return undefined;
  }
}

/**
 * The time rules at a block. The factory refuses `block.timestamp > expiry` (FAC:237) and `fund()` refuses a
 * reclaimAt outside [10 d, 365 d] after its own block (ESC:796-801). The transactions land after `timestamp`,
 * so both keep `margin` seconds of slack on the side that time erodes.
 */
export function checkTiming(p: { expiry: bigint; configs: readonly UnitConfig[] }, timestamp: bigint, margin: bigint): void {
  if (p.expiry < timestamp + margin) {
    refuse("EXPIRY_TOO_SOON", `the acceptance expires at ${p.expiry}; the latest block is at ${timestamp}, and the margin is ${margin}s`);
  }
  p.configs.forEach((c, i) => {
    const delay = c.reclaimAt - timestamp;
    if (delay < MIN_RECLAIM_DELAY + margin || delay > MAX_RECLAIM_DELAY) {
      refuse(
        "RECLAIM_WINDOW",
        `fund.configs[${i}].reclaimAt is ${delay}s after the latest block; fund() needs [${MIN_RECLAIM_DELAY}, ${MAX_RECLAIM_DELAY}]s after its own block (margin ${margin}s)`,
      );
    }
  });
}

function domainProblem(got: PreparePayload["typedData"]["domain"], want: JobPolicyTypedData["domain"]): string | undefined {
  if (got.name !== want.name) return `name is "${got.name}"; the escrow's is "${want.name}"`;
  if (got.version !== want.version) return `version is "${got.version}"; the escrow's is "${want.version}"`;
  if (got.chainId !== want.chainId) return `chainId is ${got.chainId}; the policy's is ${want.chainId}`;
  if (!same(got.verifyingContract, want.verifyingContract)) {
    return `verifyingContract is ${got.verifyingContract}; the predicted escrow is ${want.verifyingContract}`;
  }
  return undefined;
}

function typedDataProblem(got: PreparePayload["typedData"], want: JobPolicyTypedData): string | undefined {
  if (got.primaryType !== want.primaryType) return `primaryType is "${got.primaryType}"; expected "${want.primaryType}"`;
  const g = got.types.JobPolicy;
  const w = want.types.JobPolicy;
  if (g.length !== w.length || g.some((f, i) => f.name !== w[i]!.name || f.type !== w[i]!.type)) {
    return "types.JobPolicy is not the contract's JobPolicy struct";
  }
  for (const { name } of JOB_POLICY_FIELDS) {
    const a = got.message[name];
    const b = want.message[name];
    const equal = typeof b === "bigint" ? a === b : same(String(a), b);
    if (!equal) return `message.${name} is ${String(a)}; the recomputed value is ${String(b)}`;
  }
  return undefined;
}

export async function prepareFunding(args: PrepareFundingArgs): Promise<PreparedFunding> {
  // Everything judged below comes from this parse, taken before the first await.
  const p = parsePreparePayload(args.payload);
  const maxTotalGross = args.quote?.maxTotalGross;
  if (typeof maxTotalGross !== "bigint" || maxTotalGross < 0n) throw new TypeError("quote.maxTotalGross must be a non-negative bigint");
  const margin = args.marginSeconds ?? DEFAULT_MARGIN_SECONDS;
  if (typeof margin !== "bigint" || margin < 0n) throw new TypeError("marginSeconds must be a non-negative bigint");
  const pins = resolvePins(p.chainId, args.pins);
  const account = args.wallet.account;
  if (!account) refuse("PAYER_NOT_SIGNER", "the wallet has no account to sign or send with");
  const m = p.typedData.message;

  // 1. The chain, for both clients (plan S3 negative: "the chainId differs").
  await assertChain(args.wallet, args.publicClient, p.chainId);

  // 2. The deployment. The token is the pinned Circle USDC (plan S3 negative; DEP-01), and the factory is the pinned
  //    one (plan §3 step 6, S1 negative 5). Without a factory pin, every check below could be met by a look-alike
  //    deployment whose fund() pays someone else.
  if (pins.usdc === undefined) refuse("TOKEN_NOT_PINNED", `chain ${p.chainId} has no USDC pin`);
  if (!same(p.usdc, pins.usdc)) refuse("TOKEN_NOT_PINNED", `usdc ${p.usdc} is not the pinned USDC ${pins.usdc}`);
  if (pins.factory === undefined) refuse("FACTORY_NOT_PINNED", `chain ${p.chainId} has no factory pin: pass pins["${p.chainId}"].factory`);
  if (!same(p.factory, pins.factory)) refuse("FACTORY_NOT_PINNED", `factory ${p.factory} is not the pinned factory ${pins.factory}`);

  // 3. The payer is this wallet (plan S3 negative: "the payer is not its own address").
  if (!same(m.payer, account.address)) refuse("PAYER_NOT_SIGNER", `the policy's payer is ${m.payer}; the wallet is ${account.address}`);

  // 4. ΣG, recomputed from the configs (fund() pulls exactly that: ESC:830, 843), against the payload and the quote.
  const totalGross = p.fund.configs.reduce((sum, c) => sum + c.g, 0n);
  if (totalGross !== p.totalGross) refuse("TOTAL_GROSS_MISMATCH", `the configs' gross amounts sum to ${totalGross}; the payload says ${p.totalGross}`);
  if (totalGross > maxTotalGross) refuse("AMOUNT_EXCEEDS_QUOTE", `ΣG is ${totalGross}; the quote allows at most ${maxTotalGross}`);

  // 5. The terms: the configs' hash (ESC:873), then the address that hash commits to through the salt (FAC:390-398).
  const root = prePolicyRoot(p.fund.configs);
  if (!same(root, m.prePolicyRoot)) refuse("POLICY_ROOT_MISMATCH", `keccak256(abi.encode(configs)) is ${root}; the policy says ${m.prePolicyRoot}`);
  // The factory's PolicyIdentity, in its field order (VNextSettlementLib PolicyIdentity), with the recomputed root.
  const identity = {
    payer: m.payer,
    operator: m.operator,
    jobIdHash: m.jobIdHash,
    termsHash: m.termsHash,
    policyNonce: m.policyNonce,
    prePolicyRoot: root,
    acceptedPolicyDigest: m.acceptedPolicyDigest,
  };
  const salt = policySalt(identity);
  const escrow = predictEscrow(p.factory, m.implementation, salt);
  if (!same(escrow, p.escrow)) refuse("ESCROW_NOT_PREDICTED", `escrow ${p.escrow} is not CREATE2(factory, salt, clone(implementation)) = ${escrow}`);

  // 6. The typed data: exactly the JobPolicy the factory hashes (FAC:299-329), in the clone's domain (FAC:333-343).
  const unitIds = p.fund.configs.map((c) =>
    settlementUnitId({ chainId: p.chainId, escrow, jobIdHash: m.jobIdHash, milestoneIndex: c.milestoneIndex, stepId: c.stepId }),
  );
  const message: JobPolicyMessage = {
    chainId: p.chainId,
    factory: getAddress(p.factory),
    implementation: getAddress(m.implementation),
    escrow,
    policyVersion: POLICY_VERSION,
    payer: getAddress(m.payer),
    operator: getAddress(m.operator),
    jobIdHash: m.jobIdHash,
    termsHash: m.termsHash,
    policyNonce: m.policyNonce,
    prePolicyRoot: root,
    unitsRoot: unitsRoot(unitIds),
    expiry: p.expiry,
    acceptedPolicyDigest: m.acceptedPolicyDigest,
  };
  const typedData = jobPolicyTypedData(message);
  const badDomain = domainProblem(p.typedData.domain, typedData.domain);
  if (badDomain) refuse("DOMAIN_MISMATCH", badDomain);
  const badTypedData = typedDataProblem(p.typedData, typedData);
  if (badTypedData) refuse("TYPED_DATA_MISMATCH", badTypedData);

  // 7. The approve the gateway expects: exactly ΣG of the pinned USDC, to the escrow (plan §3 step 5).
  if (!same(p.approve.token, pins.usdc)) refuse("TOKEN_NOT_PINNED", `approve.token ${p.approve.token} is not the pinned USDC ${pins.usdc}`);
  if (!same(p.approve.spender, escrow)) refuse("APPROVE_SPENDER_NOT_ESCROW", `approve.spender ${p.approve.spender} is not the escrow ${escrow}`);
  if (p.approve.amount !== totalGross) refuse("APPROVE_AMOUNT_NOT_TOTAL", `approve.amount ${p.approve.amount} is not ΣG ${totalGross}`);

  // 8. The exact fund() args: this policy's expiry, and the payer-sent shape. The payer leg is implicit only when
  //    the payer sends (ESC:718; FAC:253), so its signature bytes are empty and are never checked.
  if (p.fund.acceptance.expiry !== p.expiry) refuse("FUND_ARGS_MISMATCH", `fund.acceptance.expiry ${p.fund.acceptance.expiry} is not the policy's ${p.expiry}`);
  if (p.fund.acceptance.payerSignature !== "0x") refuse("FUND_ARGS_MISMATCH", "fund.acceptance.payerSignature must be empty: the payer sends fund() itself");

  // 9. The operator's acceptance: an EOA signature over the RECOMPUTED digest (FAC:256, 375-387).
  const structHash = jobPolicyHash(message);
  const digest = acceptanceDigest(domainSeparator(p.chainId, escrow), structHash);
  const operatorSignature = p.fund.acceptance.operatorSignature;
  const badShape = eoaSignatureProblem(operatorSignature);
  if (badShape) refuse("OPERATOR_SIGNATURE_INVALID", badShape);
  const operatorSigner = await recoverSigner(digest, operatorSignature);
  if (operatorSigner === undefined || !same(operatorSigner, m.operator)) {
    refuse("OPERATOR_SIGNATURE_INVALID", `the operator signature recovers to ${operatorSigner ?? "nothing"} over these terms, not the operator ${m.operator}`);
  }

  // 10. Live, at one pinned block: the pinned factory's implementation (an immutable, FAC:34), the factory's own
  //     prediction of the escrow address (ABI doc §5.2), that implementation's token (an immutable, ESC:75), and the
  //     time rules.
  const live = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (e) {
      refuse("LIVE_CHECK_FAILED", `${what}: ${describeRevert(e)}`);
    }
  };
  const block = await live("pin the latest block", () => pinBlock(args.publicClient));
  const reader = pinnedReader(args.publicClient, block.hash);
  const factoryCode = await live("read the factory's code", () => reader.code(p.factory));
  if (factoryCode === "0x") refuse("DEPLOYMENT_MISMATCH", `no code at the pinned factory ${p.factory} on chain ${p.chainId}`);
  const liveImplementation = await live("factory.implementation()", () => reader.read<Address>(p.factory, FACTORY_ABI, "implementation"));
  if (!same(liveImplementation, m.implementation)) {
    refuse("DEPLOYMENT_MISMATCH", `the pinned factory's implementation is ${liveImplementation}; the policy names ${m.implementation}`);
  }
  // reviewer-charlie L5: the escrow the approve names must also be the pinned factory's own answer for this identity
  // (FAC:146, 390-392), so it never rests on this module's salt and CREATE2 derivation alone.
  const predicted = await live("factory.predictEscrow(identity)", () => reader.read<Address>(p.factory, FACTORY_ABI, "predictEscrow", [identity]));
  if (!same(predicted, escrow)) {
    refuse("ESCROW_NOT_PREDICTED", `the pinned factory's predictEscrow(identity) is ${predicted}; this module derived ${escrow}`);
  }
  const liveToken = await live("implementation.USDC()", () => reader.read<Address>(m.implementation, ESCROW_ABI, "USDC"));
  if (!same(liveToken, pins.usdc)) refuse("TOKEN_NOT_PINNED", `the implementation settles in ${liveToken}, not the pinned USDC ${pins.usdc}`);
  checkTiming({ expiry: p.expiry, configs: p.fund.configs }, block.timestamp, margin);

  const reclaims = p.fund.configs.map((c) => c.reclaimAt);
  const prepared: PreparedFunding = deepFreeze({
    chainId: p.chainId,
    factory: message.factory,
    implementation: message.implementation,
    escrow,
    usdc: getAddress(pins.usdc),
    payer: message.payer,
    operator: message.operator,
    totalGross,
    expiry: p.expiry,
    configs: p.fund.configs,
    unitIds,
    prePolicyRoot: root,
    jobPolicyHash: structHash,
    digest,
    policyKey: policyKey(message.payer, message.operator, m.jobIdHash),
    typedData,
    operatorSignature,
    reclaimAt: {
      earliest: reclaims.reduce((a, b) => (b < a ? b : a)),
      latest: reclaims.reduce((a, b) => (b > a ? b : a)),
    },
    verifiedAt: { blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp },
  });
  PREPARED.add(prepared);
  return prepared;
}
