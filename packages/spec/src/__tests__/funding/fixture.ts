/**
 * Test fixture for the buyer-funding SDK (implementer-bravo, pcc-adk).
 *
 * - `buildFixture` makes one internally consistent prepare payload with the SDK's own encoders (pinned to the golden
 *   vectors by vnext-golden.test.ts), signed by a per-run operator key. The anvil e2e in packages/contracts builds the
 *   same payload with the canonical compiler instead.
 * - `makeChain` is a fake EIP-1193 node answering exactly the reads the SDK makes, and logging every method, so a test
 *   can assert that nothing was sent.
 * No key literal anywhere: every account is `generatePrivateKey()` per run. Addresses below are placeholders, not keys.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  parseTransaction,
  stringToHex,
  toFunctionSelector,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FUNDING_PREPARE_SCHEMA } from "../../funding/payload.js";
import type { FundingExpectations } from "../../funding/prepare.js";
import {
  ERC20_ABI,
  ESCROW_ABI,
  FACTORY_ABI,
  JOB_POLICY_FIELDS,
  POLICY_VERSION,
  acceptanceDigest,
  domainSeparator,
  jobPolicyHash,
  policyKey,
  policySalt,
  prePolicyRoot,
  predictEscrow,
  settlementUnitId,
  unitsRoot,
  type JobPolicyMessage,
  type UnitConfig,
} from "../../funding/vnext.js";

export const CHAIN_ID = 31337;
/** The fake chain's block time. */
export const NOW = 1_800_000_000n;
export const DAY = 86_400n;
export const FACTORY: Address = "0x00000000000000000000000000000000000fac01";
export const IMPLEMENTATION: Address = "0x00000000000000000000000000000000000001a1";
export const TOKEN: Address = "0x0000000000000000000000000000000000005dc1";
export const OTHER: Address = "0x0000000000000000000000000000000000000bad";
export const FEE_RECIPIENT: Address = "0x4444444444444444444444444444444444444444";
export const JOB_ID = "pcc:funding-test:job";
/** secp256k1's group order: `n - s` is the high-s twin of a signature. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const newAccount = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());

/**
 * reviewer-charlie L5 (implementer-delta): the runtime code of an EIP-1167 clone of `implementation`, as the factory's
 * Clones.sol deploys it (its line 23: 363d3d373d3d3d363d73 ‖ impl ‖ 5af43d82803e903d91602b57fd5bf3). Written here
 * independently of the SDK's copy, so a drift in either one fails the unit suite.
 */
export const cloneRuntime = (implementation: Address): Hex =>
  `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

/** The factory's `predictEscrow` as the contract declares it (FAC:146; ABI doc §7), independently of the SDK's ABI. */
export const FACTORY_PREDICT_ABI = parseAbi([
  "struct PolicyIdentity { address payer; address operator; bytes32 jobIdHash; bytes32 termsHash; uint256 policyNonce; bytes32 prePolicyRoot; bytes32 acceptedPolicyDigest; }",
  "function predictEscrow(PolicyIdentity p) view returns (address)",
]);

/** JSON wire form: bigint as a decimal string, as the gateway would send it. */
export function toWire<T>(value: T): any {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function unit(i: number, reclaimAt: bigint, recipient: Address): UnitConfig {
  const g = 1_000_000n + BigInt(i);
  const feeBps = 235;
  const f = (g * BigInt(feeBps)) / 10_000n;
  return {
    milestoneIndex: BigInt(i),
    stepId: keccak256(stringToHex(`pcc:funding-test:step-${i}`)),
    requiredTier: 0,
    requestedTier: 0,
    g,
    f,
    n: g - f,
    feeBps,
    feeRecipient: FEE_RECIPIENT,
    reclaimAt,
    compositionSchemaVersion: 0,
    compositionRoot: zeroHash,
    payouts: [{ recipient, amount: g - f }],
  };
}

export interface FixtureOptions {
  chainId?: number;
  expiry?: bigint;
  reclaimAt?: bigint[];
  usdc?: Address;
  factory?: Address;
  jobId?: string;
  termsHash?: Hex;
  acceptedPolicyDigest?: Hex;
  /** Change local configs before rebuilding all commitments and signing with the operator's key. */
  configure?: (configs: UnitConfig[]) => void;
}

export interface Fixture {
  payer: PrivateKeyAccount;
  operator: PrivateKeyAccount;
  jobId: string;
  chainId: bigint;
  factory: Address;
  usdc: Address;
  configs: UnitConfig[];
  escrow: Address;
  unitIds: Hex[];
  message: JobPolicyMessage;
  jobPolicyHash: Hex;
  digest: Hex;
  policyKey: Hex;
  totalGross: bigint;
  expiry: bigint;
  operatorSignature: Hex;
  /** A fresh JSON-wire copy of the payload on every call: mutate it freely. */
  wire(): any;
}

export async function buildFixture(o: FixtureOptions = {}, parties = { payer: newAccount(), operator: newAccount() }): Promise<Fixture> {
  const { payer, operator } = parties;
  const chainId = BigInt(o.chainId ?? CHAIN_ID);
  const factory = o.factory ?? FACTORY;
  const usdc = o.usdc ?? TOKEN;
  const expiry = o.expiry ?? NOW + DAY;
  const configs = (o.reclaimAt ?? [NOW + 30n * DAY, NOW + 60n * DAY]).map((r, i) => unit(i, r, operator.address));
  o.configure?.(configs);
  const jobId = o.jobId ?? JOB_ID;
  const jobIdHash = keccak256(stringToHex(jobId));
  const termsHash = o.termsHash ?? keccak256(stringToHex("pcc:funding-test:terms"));
  const acceptedPolicyDigest = o.acceptedPolicyDigest ?? keccak256(stringToHex("pcc:funding-test:accepted"));
  const policyNonce = 1n;
  const root = prePolicyRoot(configs);
  const salt = policySalt({ payer: payer.address, operator: operator.address, jobIdHash, termsHash, policyNonce, prePolicyRoot: root, acceptedPolicyDigest });
  const escrow = predictEscrow(factory, IMPLEMENTATION, salt);
  const unitIds = configs.map((c) => settlementUnitId({ chainId, escrow, jobIdHash, milestoneIndex: c.milestoneIndex, stepId: c.stepId }));
  const message: JobPolicyMessage = {
    chainId,
    factory,
    implementation: IMPLEMENTATION,
    escrow,
    policyVersion: POLICY_VERSION,
    payer: payer.address,
    operator: operator.address,
    jobIdHash,
    termsHash,
    policyNonce,
    prePolicyRoot: root,
    unitsRoot: unitsRoot(unitIds),
    expiry,
    acceptedPolicyDigest,
  };
  const structHash = jobPolicyHash(message);
  const digest = acceptanceDigest(domainSeparator(chainId, escrow), structHash);
  const operatorSignature = await operator.sign({ hash: digest });
  const totalGross = configs.reduce((s, c) => s + c.g, 0n);
  return {
    payer,
    operator,
    jobId,
    chainId,
    factory,
    usdc,
    configs,
    escrow,
    unitIds,
    message,
    jobPolicyHash: structHash,
    digest,
    policyKey: policyKey(payer.address, operator.address, jobIdHash),
    totalGross,
    expiry,
    operatorSignature,
    wire: () =>
      toWire({
        schema: FUNDING_PREPARE_SCHEMA,
        chainId,
        factory,
        escrow,
        usdc,
        totalGross,
        expiry,
        typedData: {
          domain: { name: "VNextSettlementEscrow", version: "1", chainId, verifyingContract: escrow },
          types: { JobPolicy: JOB_POLICY_FIELDS.map((f) => ({ name: f.name, type: f.type })) },
          primaryType: "JobPolicy",
          message,
        },
        approve: { token: usdc, spender: escrow, amount: totalGross },
        fund: { configs, acceptance: { expiry, payerSignature: "0x", operatorSignature } },
      }),
  };
}

/** The high-s twin of a 65-byte signature: same signer, same digest, rejected by the factory. */
export function highS(signature: Hex): Hex {
  const r = signature.slice(2, 66);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return `0x${r}${(SECP256K1_N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
}

/** The same signature with v written as a y-parity byte (0/1): it still recovers, but the factory wants 27/28. */
export function parityV(signature: Hex): Hex {
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return `${signature.slice(0, 130)}0${v - 27}` as Hex;
}

/** What the fake does with the n-th transaction sent: mine it (success or reverted), or never mine it. */
export type ReceiptPlan = "success" | "reverted" | "none";

export interface SentTx {
  hash: Hex;
  to: Address;
  data: Hex;
  plan: ReceiptPlan;
  /** The block that was latest when it was sent: where a mined plan lands. */
  block: { number: bigint; hash: Hex };
}

type FakeBlock = { number: bigint; hash: Hex; timestamp: bigint };

export interface ChainState {
  chainId: number;
  walletChainId: number;
  /** The latest block; every block ever latest stays readable by hash in `blocks`. */
  block: FakeBlock;
  blocks: Map<string, FakeBlock>;
  /** The node answers "latest" with a pending block (no number, no hash). */
  pendingBlock: boolean;
  code: Map<string, Hex>;
  handlers: Map<string, (data: Hex) => Hex>;
  log: Array<{ method: string; params: readonly unknown[] }>;
  failCalls: boolean;
  failBlocks: boolean;
  failCode: boolean;
  failChainId: boolean;
  /** eth_sendRawTransaction throws, as a transport error after (or before) the node took the transaction would. */
  failSend: boolean;
  /** Receipt plans for the sends, in order; a send past the end is mined successfully. */
  receipts: ReceiptPlan[];
  sent: SentTx[];
  /** Transactions the payer had mined before the test (its nonce at "latest" and "pending" both start here). */
  priorNonce: number;
  /** Payer transactions pending in the node's pool that this SDK did not send (counted at "pending" only). */
  mempool: number;
  /** eth_getTransactionCount throws. */
  failNonce: boolean;
  /**
   * foxtrot F1 (implementer-delta): the pinned factory's `fundedEscrowOf` slot for THIS job's policyKey (FAC:54), zero
   * until a funding writes it (FAC:245). Like the mapping, the fake answers it for that key alone: any other key reads
   * zero.
   */
  fundedEscrow: Address;
  /** Runs after the n-th send is accepted (0-based): e.g. make policy() read as funded. */
  afterSend?: (index: number) => void;
}

/** A revert as a node reports it: JSON-RPC error code 3 carrying the revert data. */
export function revertWith(data: Hex): never {
  throw Object.assign(new Error("execution reverted"), { code: 3, data });
}

export function makeChain(fx: Fixture, o: { escrowCode?: boolean } = {}) {
  const genesis: FakeBlock = { number: 100n, hash: keccak256(stringToHex("pcc:funding-test:block-100")), timestamp: NOW };
  const state: ChainState = {
    chainId: Number(fx.chainId),
    walletChainId: Number(fx.chainId),
    block: genesis,
    blocks: new Map([[genesis.hash, genesis]]),
    pendingBlock: false,
    code: new Map([
      [fx.factory.toLowerCase(), "0x6080" as Hex],
      [IMPLEMENTATION.toLowerCase(), "0x6080" as Hex],
    ]),
    handlers: new Map(),
    log: [],
    failCalls: false,
    failBlocks: false,
    failCode: false,
    failChainId: false,
    failSend: false,
    receipts: [],
    sent: [],
    priorNonce: 0,
    mempool: 0,
    failNonce: false,
    fundedEscrow: zeroAddress,
  };
  if (o.escrowCode) state.code.set(fx.escrow.toLowerCase(), cloneRuntime(IMPLEMENTATION));

  /** Answer `functionName` on `to` with `result(args)`. */
  const on = (to: Address, abi: Abi, functionName: string, result: (args: readonly unknown[]) => unknown) => {
    const item = (abi as readonly { type: string; name?: string }[]).find((x) => x.type === "function" && x.name === functionName);
    const selector = toFunctionSelector(item as never);
    state.handlers.set(`${to.toLowerCase()}:${selector}`, (data) =>
      encodeFunctionResult({ abi, functionName, result: result(decodeFunctionData({ abi, data } as never).args ?? []) } as never),
    );
  };
  on(fx.factory, FACTORY_ABI, "implementation", () => IMPLEMENTATION);
  // As the factory answers it (FAC:146, 390-392): the clone address for the identity it is GIVEN, so an identity passed
  // wrongly yields another address.
  on(fx.factory, FACTORY_PREDICT_ABI, "predictEscrow", ([p]) =>
    predictEscrow(fx.factory, IMPLEMENTATION, policySalt(p as Parameters<typeof policySalt>[0])),
  );
  on(IMPLEMENTATION, ESCROW_ABI, "USDC", () => fx.usdc);
  on(fx.escrow, ESCROW_ABI, "policy", () => [fx.operator.address, 1n, fx.message.prePolicyRoot, zeroHash, fx.message.acceptedPolicyDigest]);
  on(fx.factory, FACTORY_ABI, "fundedEscrowOf", ([key]) =>
    String(key).toLowerCase() === fx.policyKey.toLowerCase() ? state.fundedEscrow : zeroAddress,
  );
  on(fx.escrow, ESCROW_ABI, "unitState", () => 1);
  on(fx.usdc, ERC20_ABI, "approve", () => true);
  on(fx.usdc, ERC20_ABI, "allowance", () => fx.totalGross);
  on(fx.escrow, ESCROW_ABI, "fund", () => undefined);
  const sentTx = (hash: unknown) => state.sent.find((t) => t.hash === hash);
  const fundSelector = toFunctionSelector((ESCROW_ABI as readonly { type: string; name?: string }[]).find((x) => x.type === "function" && x.name === "fund") as never);
  /**
   * reviewer-charlie L3 (implementer-delta): `fund()` refuses a sender other than the payer that carries no payer
   * signature, exactly as the escrow does (ESC:718: `msg.sender != payer && payerSignature.length == 0 -> OnlyPayer`). A
   * call with no `from` runs as the zero address, as on a node. It runs before any test handler, because in the
   * contract it precedes every other fund() revert except five (NotInitialized, AlreadySealed, ConfigTooLarge,
   * SignatureTooLarge and BadUnitCount, ESC:703-713); a test that injects one of those sees it only for a payer-sent
   * call, the only kind the SDK makes. The fake models no other fund() check.
   */
  const onlyPayer = (from: Address | undefined, to: Address, data: Hex) => {
    if (to.toLowerCase() !== fx.escrow.toLowerCase() || data.slice(0, 10) !== fundSelector) return;
    const [, acceptance] = decodeFunctionData({ abi: ESCROW_ABI, data }).args as unknown as [unknown, { payerSignature: Hex }];
    if ((from ?? zeroAddress).toLowerCase() !== fx.payer.address.toLowerCase() && acceptance.payerSignature === "0x") {
      revertWith(encodeErrorResult({ abi: ESCROW_ABI, errorName: "OnlyPayer" }));
    }
  };

  const provider = (which: "public" | "wallet") => ({
    async request({ method, params }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
      state.log.push({ method, params: params ?? [] });
      switch (method) {
        case "eth_chainId":
          if (state.failChainId) throw new Error("fake chain: eth_chainId unavailable");
          return toHex(which === "wallet" ? state.walletChainId : state.chainId);
        case "eth_getBlockByNumber":
        case "eth_getBlockByHash": {
          if (state.failBlocks) throw new Error("fake chain: no block");
          const b = method === "eth_getBlockByHash" ? state.blocks.get(String((params as unknown[])[0]).toLowerCase()) : state.block;
          if (!b) return null;
          const pending = method === "eth_getBlockByNumber" && state.pendingBlock;
          return {
            number: pending ? null : toHex(b.number),
            hash: pending ? null : b.hash,
            parentHash: zeroHash,
            timestamp: toHex(b.timestamp),
            transactions: [],
          };
        }
        case "eth_getCode":
          if (state.failCode) throw new Error("fake chain: eth_getCode unavailable");
          return state.code.get(String((params as unknown[])[0]).toLowerCase()) ?? "0x";
        case "eth_call": {
          if (state.failCalls) throw new Error("fake chain: eth_call unavailable");
          const { from, to, data } = (params as [{ from?: Address; to: Address; data: Hex }])[0];
          onlyPayer(from, to, data);
          const handler = state.handlers.get(`${to.toLowerCase()}:${data.slice(0, 10)}`);
          if (!handler) throw new Error(`fake chain: no handler for ${to} ${data.slice(0, 10)}`);
          return handler(data);
        }
        // Just enough of a node for viem to send a legacy transaction from a local account and wait for its receipt.
        case "eth_blockNumber":
          return toHex(state.block.number);
        case "eth_getTransactionCount": {
          // reviewer-charlie L7 (implementer-delta): as a node counts the payer's nonce. "latest" counts mined
          // transactions only; "pending" also counts those still in the pool: a send planned "none" never mines, and
          // `mempool` stands for the payer's other pending ones. viem signs each send with the "pending" nonce.
          // foxtrot F2: per address, as a node counts. Only the payer sends here. An address with code answers 1, a
          // contract's starting nonce (EIP-161; the escrow clone never creates, so it stays 1), and any other account
          // has sent nothing.
          if (state.failNonce) throw new Error("fake chain: eth_getTransactionCount unavailable");
          const [who, tag] = params as [Address, unknown];
          if (who.toLowerCase() !== fx.payer.address.toLowerCase()) return toHex(state.code.has(who.toLowerCase()) ? 1 : 0);
          const mined = state.sent.filter((t) => t.plan !== "none").length;
          return toHex(state.priorNonce + (tag === "pending" ? state.sent.length + state.mempool : mined));
        }
        case "eth_gasPrice":
          return toHex(1_000_000_000n);
        case "eth_estimateGas":
          return toHex(200_000n);
        case "eth_sendRawTransaction": {
          if (state.failSend) throw new Error("fake chain: the connection dropped");
          const raw = (params as [Hex])[0];
          const tx = parseTransaction(raw);
          const index = state.sent.length;
          state.sent.push({
            hash: keccak256(raw),
            to: tx.to!,
            data: tx.data ?? "0x",
            plan: state.receipts[index] ?? "success",
            block: { number: state.block.number, hash: state.block.hash },
          });
          state.afterSend?.(index);
          return keccak256(raw);
        }
        case "eth_getTransactionByHash": {
          const tx = sentTx((params as unknown[])[0]);
          if (!tx) return null;
          const mined = tx.plan !== "none";
          return {
            hash: tx.hash,
            from: fx.payer.address,
            to: tx.to,
            input: tx.data,
            nonce: toHex(state.sent.indexOf(tx)),
            blockHash: mined ? tx.block.hash : null,
            blockNumber: mined ? toHex(tx.block.number) : null,
            transactionIndex: mined ? "0x0" : null,
            value: "0x0",
            gas: toHex(200_000n),
            gasPrice: toHex(1_000_000_000n),
            type: "0x0",
            v: "0x1b",
            r: "0x1",
            s: "0x1",
          };
        }
        case "eth_getTransactionReceipt": {
          const tx = sentTx((params as unknown[])[0]);
          if (!tx || tx.plan === "none") return null;
          return {
            transactionHash: tx.hash,
            blockHash: tx.block.hash,
            blockNumber: toHex(tx.block.number),
            status: tx.plan === "success" ? "0x1" : "0x0",
            from: fx.payer.address,
            to: tx.to,
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            transactionIndex: "0x0",
            type: "0x0",
            gasUsed: "0x1",
            cumulativeGasUsed: "0x1",
            effectiveGasPrice: "0x1",
            contractAddress: null,
          };
        }
        default:
          throw new Error(`fake chain: unexpected ${method}`);
      }
    },
  });
  const publicClient = createPublicClient({ transport: custom(provider("public"), { retryCount: 0 }), pollingInterval: 20 });
  const wallet = (account: LocalAccount = fx.payer, options: { dataSuffix?: Hex } = {}) =>
    createWalletClient({ account, transport: custom(provider("wallet"), { retryCount: 0 }), ...options });
  /** A new latest block, 12 s later; the old one stays readable by hash. */
  const advanceBlock = () => {
    const number = state.block.number + 1n;
    const next: FakeBlock = { number, hash: keccak256(stringToHex(`pcc:funding-test:block-${number}`)), timestamp: state.block.timestamp + 12n };
    state.blocks.set(next.hash, next);
    state.block = next;
  };
  const accountless = () => createWalletClient({ transport: custom(provider("wallet"), { retryCount: 0 }) });
  /** Methods that would send or sign a transaction: the SDK must call none before a refusal. */
  const sends = () => state.log.filter((x) => x.method === "eth_sendRawTransaction" || x.method === "eth_sendTransaction");
  return { state, on, publicClient, wallet, accountless, advanceBlock, sends };
}

/** The pins a test passes for the fake chain (no built-in pin exists for 31337). */
export const testPins = (fx: Fixture) => ({ [fx.chainId.toString()]: { usdc: fx.usdc, factory: fx.factory } });

/** Buyer-side records for the fixture's intended policy; never read its wire payload. */
export const testExpect = (fx: Fixture): FundingExpectations => ({
  jobId: fx.jobId,
  operator: fx.operator.address,
  payees: [fx.operator.address],
  maxFeeBps: 235,
  feeRecipients: [FEE_RECIPIENT],
  tiers: [0],
  latestReclaimAt: fx.configs.reduce((latest, c) => c.reclaimAt > latest ? c.reclaimAt : latest, 0n),
  termsHash: fx.message.termsHash,
  acceptedPolicyDigest: fx.message.acceptedPolicyDigest,
  compositionRoots: [zeroHash],
});
