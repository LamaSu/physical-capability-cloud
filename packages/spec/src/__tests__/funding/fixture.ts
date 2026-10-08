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
  encodeFunctionResult,
  keccak256,
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
const FEE_RECIPIENT: Address = "0x4444444444444444444444444444444444444444";
/** secp256k1's group order: `n - s` is the high-s twin of a signature. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const newAccount = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());

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
}

export interface Fixture {
  payer: PrivateKeyAccount;
  operator: PrivateKeyAccount;
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
  const jobIdHash = keccak256(stringToHex("pcc:funding-test:job"));
  const termsHash = keccak256(stringToHex("pcc:funding-test:terms"));
  const acceptedPolicyDigest = keccak256(stringToHex("pcc:funding-test:accepted"));
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

export interface ChainState {
  chainId: number;
  walletChainId: number;
  block: { number: bigint; hash: Hex; timestamp: bigint };
  code: Map<string, Hex>;
  handlers: Map<string, (data: Hex) => Hex>;
  log: Array<{ method: string; params: readonly unknown[] }>;
  failCalls: boolean;
  failBlocks: boolean;
}

/** A revert as a node reports it: JSON-RPC error code 3 carrying the revert data. */
export function revertWith(data: Hex): never {
  throw Object.assign(new Error("execution reverted"), { code: 3, data });
}

export function makeChain(fx: Fixture, o: { escrowCode?: boolean } = {}) {
  const state: ChainState = {
    chainId: Number(fx.chainId),
    walletChainId: Number(fx.chainId),
    block: { number: 100n, hash: keccak256(stringToHex("pcc:funding-test:block-100")), timestamp: NOW },
    code: new Map([
      [fx.factory.toLowerCase(), "0x6080" as Hex],
      [IMPLEMENTATION.toLowerCase(), "0x6080" as Hex],
    ]),
    handlers: new Map(),
    log: [],
    failCalls: false,
    failBlocks: false,
  };
  if (o.escrowCode) state.code.set(fx.escrow.toLowerCase(), "0x363d3d37");

  /** Answer `functionName` on `to` with `result(args)`. */
  const on = (to: Address, abi: Abi, functionName: string, result: (args: readonly unknown[]) => unknown) => {
    const item = (abi as readonly { type: string; name?: string }[]).find((x) => x.type === "function" && x.name === functionName);
    const selector = toFunctionSelector(item as never);
    state.handlers.set(`${to.toLowerCase()}:${selector}`, (data) =>
      encodeFunctionResult({ abi, functionName, result: result(decodeFunctionData({ abi, data } as never).args ?? []) } as never),
    );
  };
  on(fx.factory, FACTORY_ABI, "implementation", () => IMPLEMENTATION);
  on(IMPLEMENTATION, ESCROW_ABI, "USDC", () => fx.usdc);
  on(fx.escrow, ESCROW_ABI, "policy", () => [fx.operator.address, 1n, fx.message.prePolicyRoot, zeroHash, fx.message.acceptedPolicyDigest]);
  on(fx.factory, FACTORY_ABI, "fundedEscrowOf", () => zeroAddress);
  on(fx.escrow, ESCROW_ABI, "unitState", () => 1);
  on(fx.usdc, ERC20_ABI, "approve", () => true);

  const provider = (which: "public" | "wallet") => ({
    async request({ method, params }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
      state.log.push({ method, params: params ?? [] });
      switch (method) {
        case "eth_chainId":
          return toHex(which === "wallet" ? state.walletChainId : state.chainId);
        case "eth_getBlockByNumber":
        case "eth_getBlockByHash":
          if (state.failBlocks) throw new Error("fake chain: no block");
          return {
            number: toHex(state.block.number),
            hash: state.block.hash,
            parentHash: zeroHash,
            timestamp: toHex(state.block.timestamp),
            transactions: [],
          };
        case "eth_getCode":
          return state.code.get(String((params as unknown[])[0]).toLowerCase()) ?? "0x";
        case "eth_call": {
          if (state.failCalls) throw new Error("fake chain: eth_call unavailable");
          const { to, data } = (params as [{ to: Address; data: Hex }])[0];
          const handler = state.handlers.get(`${to.toLowerCase()}:${data.slice(0, 10)}`);
          if (!handler) throw new Error(`fake chain: no handler for ${to} ${data.slice(0, 10)}`);
          return handler(data);
        }
        default:
          throw new Error(`fake chain: unexpected ${method}`);
      }
    },
  });
  const publicClient = createPublicClient({ transport: custom(provider("public"), { retryCount: 0 }) });
  const wallet = (account: LocalAccount = fx.payer) => createWalletClient({ account, transport: custom(provider("wallet"), { retryCount: 0 }) });
  /** Methods that would send or sign a transaction: the SDK must call none before a refusal. */
  const sends = () => state.log.filter((x) => x.method === "eth_sendRawTransaction" || x.method === "eth_sendTransaction");
  return { state, on, publicClient, wallet, sends };
}

/** The pins a test passes for the fake chain (no built-in pin exists for 31337). */
export const testPins = (fx: Fixture) => ({ [fx.chainId.toString()]: { usdc: fx.usdc, factory: fx.factory } });
