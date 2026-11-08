/**
 * Unit tests for `readMilestoneRecipients` (N102) against a SCRIPTED STUB client — no
 * network, no anvil. The stub answers raw `eth_call`s by decoding the call data against
 * the real generated ABIs (plus the two small local fragments the module itself uses for
 * V2's `protocolRoot`/`tokenForMilestone`), so these tests exercise the exact same
 * encode/decode path the module runs against a live node. The real-contract regression
 * (real bytecode, real anvil, real token-balance deltas) is `milestone-recipients.anvil.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { readMilestoneRecipients, type MilestoneRecipients } from "../milestone-recipients.js";
import { MilestoneEscrowV2ABI, MilestoneStatusV2 } from "../abi/MilestoneEscrowV2.js";
import { MilestoneEscrowV3ABI, MilestoneStatusV3 } from "../abi/MilestoneEscrowV3.js";
import { PCCProtocolV2ABI } from "../abi/PCCProtocolV2.js";

const V2_LOCAL_ABI = parseAbi([
  "function protocolRoot() view returns (address)",
  "function tokenForMilestone(uint256 milestoneIndex) view returns (address)",
]);

/** `disputes(uint256)` — the auto-generated public-mapping getter for `Dispute`. Also
 *  missing from the generated ABIs (same gap as V2's `protocolRoot`/`tokenForMilestone`).
 *  Multiple named outputs decode as a PLAIN ARRAY in viem (verified empirically — names
 *  on top-level outputs are display-only, unlike a single named-tuple/struct return). */
const DISPUTE_LOCAL_ABI = parseAbi([
  "function disputes(uint256) view returns (address challenger, uint256 challengerBond, bytes32 challengerEvidenceHash, string reason, bool resolved, bool challengerWon)",
]);

const ESCROW: Address = getAddress("0x1000000000000000000000000000000000000001");
const ROOT: Address = getAddress("0x2000000000000000000000000000000000000002");
const OPERATOR: Address = getAddress("0x3000000000000000000000000000000000000003");
const TOKEN: Address = getAddress("0x4000000000000000000000000000000000000004");
const FEE_RECIPIENT: Address = getAddress("0x5000000000000000000000000000000000000005");
const LEG1: Address = getAddress("0x6000000000000000000000000000000000000006");
const LEG2: Address = getAddress("0x7000000000000000000000000000000000000007");
const PAYER: Address = getAddress("0x8000000000000000000000000000000000000008");
const CHALLENGER: Address = getAddress("0x9000000000000000000000000000000000000009");
/** A non-zero EAS UID, as `submitAttestation` writes on a REAL attestation (R2-M1a fix:
 *  attestation presence is read from this field, never inferred from status). */
const ATTESTATION_UID: Hex = `0x${"ab".repeat(32)}`;
const ROLE_A: Hex = `0x${"aa".repeat(32)}`;
const ROLE_B: Hex = `0x${"bb".repeat(32)}`;

const HEAD = 9_000n;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

type Payout = { recipient: Address; bps: bigint; roleTag: Hex; ipId: Hex };

interface MilestoneFieldsV2 {
  stepId: Hex;
  operator: Address;
  amount: bigint;
  operatorBond: bigint;
  status: number;
  evidenceBundleHash: Hex;
  verifierAttestationHash: Hex;
  challengeWindowEnd: bigint;
  challengeWindowSeconds: bigint;
  requiredTier: number;
  jobIdHash: Hex;
  verifierAttestationUid: Hex;
}
interface MilestoneFieldsV3 extends MilestoneFieldsV2 {
  attestedFeeBps: number;
  attestedFeeRecipient: Address;
}

const BASE_MILESTONE_V2: MilestoneFieldsV2 = {
  stepId: zeroHash,
  operator: OPERATOR,
  amount: 0n,
  operatorBond: 0n,
  status: MilestoneStatusV2.Funded,
  evidenceBundleHash: zeroHash,
  verifierAttestationHash: zeroHash,
  challengeWindowEnd: 0n,
  challengeWindowSeconds: 0n,
  requiredTier: 0,
  jobIdHash: zeroHash,
  verifierAttestationUid: zeroHash,
};
const mkV2 = (overrides: Partial<MilestoneFieldsV2> = {}): MilestoneFieldsV2 => ({ ...BASE_MILESTONE_V2, ...overrides });

const BASE_MILESTONE_V3: MilestoneFieldsV3 = {
  ...BASE_MILESTONE_V2,
  attestedFeeBps: 0,
  attestedFeeRecipient: zeroAddress,
};
const mkV3 = (overrides: Partial<MilestoneFieldsV3> = {}): MilestoneFieldsV3 => ({ ...BASE_MILESTONE_V3, ...overrides });

interface DisputeState {
  challenger: Address;
  challengerBond: bigint;
  resolved: boolean;
  challengerWon: boolean;
}
const NO_DISPUTE: DisputeState = { challenger: zeroAddress, challengerBond: 0n, resolved: false, challengerWon: false };

interface StubState {
  chainIds: number[];
  milestoneCount: bigint;
  milestone: MilestoneFieldsV2 | MilestoneFieldsV3;
  payoutMapSet: boolean;
  payoutMap: Payout[];
  token: Address;
  protocolRoot: Address;
  rootFeeBps: bigint;
  rootFeeRecipient: Address;
  payer: Address;
  dispute: DisputeState;
  eip1898Unsupported?: boolean;
  blockReadFails?: boolean;
  throwOn?: string;
}

const DEFAULT_STATE: StubState = {
  chainIds: [1337],
  milestoneCount: 1n,
  milestone: mkV2(),
  payoutMapSet: false,
  payoutMap: [],
  token: TOKEN,
  protocolRoot: zeroAddress,
  rootFeeBps: 0n,
  rootFeeRecipient: zeroAddress,
  payer: PAYER,
  dispute: NO_DISPUTE,
};

type Pin = { blockHash: Hex; requireCanonical: boolean };
type Call = { to: Address; functionName: string; pin: Pin };

/** Builds a minimal PublicClient-shaped stub: only `getChainId`/`getBlock`/`request` are
 *  implemented (the only three client methods `readMilestoneRecipients` calls), matching
 *  the same "cast a partial object through PublicClient" convention this package's other
 *  pinned-call tests use (`ts/__tests__/vnext-preflight.test.ts`). */
function makeClient(version: "v2" | "v3", overrides: Partial<StubState> = {}): { client: PublicClient; calls: Call[] } {
  const s: StubState = { ...DEFAULT_STATE, ...overrides, dispute: { ...NO_DISPUTE, ...overrides.dispute } };
  const escrowAbi = (
    version === "v2"
      ? [...MilestoneEscrowV2ABI, ...V2_LOCAL_ABI, ...DISPUTE_LOCAL_ABI]
      : [...MilestoneEscrowV3ABI, ...DISPUTE_LOCAL_ABI]
  ) as Abi;
  const calls: Call[] = [];
  let chainCallIndex = 0;

  const stub = {
    getChainId: async () => {
      const v = s.chainIds[Math.min(chainCallIndex, s.chainIds.length - 1)]!;
      chainCallIndex++;
      return v;
    },
    getBlock: async (args?: { blockNumber?: bigint }) => {
      if (s.blockReadFails) throw new Error("stub: block unavailable");
      const n = args?.blockNumber ?? HEAD;
      return { number: n, hash: hashOf(n) };
    },
    request: async (args: { method: string; params: unknown[] }) => {
      if (s.eip1898Unsupported) {
        throw new Error("stub: invalid argument: hex string without 0x prefix (EIP-1898 unsupported)");
      }
      if (args.method !== "eth_call") throw new Error(`stub: unsupported method ${args.method}`);
      const [tx, pin] = args.params as [{ to: Address; data: Hex }, Pin];
      if (!pin?.blockHash || pin.requireCanonical !== true) {
        throw new Error("stub: eth_call issued without a proper EIP-1898 pin");
      }
      const toRoot = tx.to.toLowerCase() === ROOT.toLowerCase();
      const abi = toRoot ? (PCCProtocolV2ABI as Abi) : escrowAbi;
      const { functionName } = decodeFunctionData({ abi, data: tx.data });
      calls.push({ to: tx.to, functionName, pin });

      if (s.throwOn === functionName) throw new Error(`stub: execution reverted: ${functionName}`);

      const reply = (result: unknown) => encodeFunctionResult({ abi, functionName, result } as never);
      if (toRoot) {
        if (functionName === "protocolFeeBps") return reply(s.rootFeeBps);
        if (functionName === "feeRecipient") return reply(s.rootFeeRecipient);
        throw new Error(`stub: unscripted root read ${functionName}`);
      }
      switch (functionName) {
        case "getMilestoneCount":
          return reply(s.milestoneCount);
        case "getMilestone":
          return reply(s.milestone);
        case "payoutMapSet":
          return reply(s.payoutMapSet);
        case "getPayoutMap":
          return reply(s.payoutMap);
        case "tokenForMilestone":
          return reply(s.token);
        case "protocolRoot":
          return reply(s.protocolRoot);
        case "payer":
          return reply(s.payer);
        case "disputes":
          return reply([
            s.dispute.challenger,
            s.dispute.challengerBond,
            zeroHash, // challengerEvidenceHash — unused by the module
            "", // reason — unused by the module
            s.dispute.resolved,
            s.dispute.challengerWon,
          ]);
        default:
          throw new Error(`stub: unscripted escrow read ${functionName}`);
      }
    },
  };
  return { client: stub as unknown as PublicClient, calls };
}

const failed = (r: MilestoneRecipients) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const checkNamed = (r: MilestoneRecipients, name: string) => r.checks.find((c) => c.name === name);

describe("readMilestoneRecipients — V2 legacy path (no payout map)", () => {
  it("with a V2 root fee: source 'root', final false, operator gets amount - fee + bond", async () => {
    const amount = 100_000_000n;
    const operatorBond = 10_000_000n;
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Attested }),
      protocolRoot: ROOT,
      rootFeeBps: 235n,
      rootFeeRecipient: FEE_RECIPIENT,
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });

    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.recipientsFinal).toBe(true);
    expect(r.fee).toEqual({ recipient: FEE_RECIPIENT, bps: 235, final: false, source: "root" });
    expect(r.legs).toEqual([{ recipient: OPERATOR, role: "operator-residual", residualBps: 10000, plusBond: operatorBond }]);
    // V2 attempts the fee transfer unconditionally whenever a root is set, so a "fee" row
    // comes first (F3), matching the contract's transfer order.
    const fee = (amount * 235n) / 10000n;
    expect(r.projected).toEqual([
      { recipient: FEE_RECIPIENT, role: "fee", amount: fee },
      { recipient: OPERATOR, role: "operator-residual", amount: amount - fee + operatorBond },
    ]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond); // fully routed
  });

  it("with no root: source 'none', bps 0, final true, operator gets amount + bond", async () => {
    const amount = 50_000_000n;
    const operatorBond = 1_000_000n;
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Released }),
      protocolRoot: zeroAddress,
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });

    expect(failed(r)).toEqual([]);
    expect(r.fee).toEqual({ recipient: null, bps: 0, final: true, source: "none" });
    // grossFee is 0 (no root), so no "fee" row — just the operator, in full.
    expect(r.projected).toEqual([{ recipient: OPERATOR, role: "operator-residual", amount: amount + operatorBond }]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond);
  });

  it("F1: payoutMapSet:true with ZERO legs is a VALID on-chain state — behaves exactly like the legacy path", async () => {
    // setPayoutMap has no minimum length (only payouts.length <= MAX_PAYOUTS), so this is
    // NOT a map-read-consistent violation — release() pays the operator the full
    // distributable + bond through _distributeWithMap, same as the unset path.
    const amount = 40_000_000n;
    const operatorBond = 2_000_000n;
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Funded }),
      payoutMapSet: true,
      payoutMap: [],
      protocolRoot: zeroAddress,
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });

    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.legs).toEqual([{ recipient: OPERATOR, role: "operator-residual", residualBps: 10000, plusBond: operatorBond }]);
    expect(r.projected).toEqual([{ recipient: OPERATOR, role: "operator-residual", amount: amount + operatorBond }]);
  });
});

describe("readMilestoneRecipients — split path (payout map set)", () => {
  it("2 legs + a non-zero root fee: fee is taken on the GROSS amount, not the distributable", async () => {
    // Distinguishes "fee on gross" from "fee on distributable" — a test with zero fee (or
    // zero legs) cannot tell the two apart, since they coincide in either degenerate case.
    const amount = 1_000_000n;
    const operatorBond = 50_000n;
    const payoutMap: Payout[] = [
      { recipient: LEG1, bps: 3000n, roleTag: ROLE_A, ipId: zeroHash },
      { recipient: LEG2, bps: 3000n, roleTag: ROLE_B, ipId: zeroHash },
    ];
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Attested }),
      payoutMapSet: true,
      payoutMap,
      protocolRoot: ROOT,
      rootFeeBps: 1000n, // 10%
      rootFeeRecipient: FEE_RECIPIENT,
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });

    expect(failed(r)).toEqual([]);
    expect(r.fee).toEqual({ recipient: FEE_RECIPIENT, bps: 1000, final: false, source: "root" });

    // Hand computation of release()'s _distributeWithMap: fee on the GROSS amount, FIRST.
    const grossFee = (amount * 1000n) / 10000n;
    const distributable = amount - grossFee;
    const share1 = (distributable * 3000n) / 10000n;
    const share2 = (distributable * 3000n) / 10000n;
    const operatorAmount = distributable - (share1 + share2) + operatorBond;
    expect(r.projected).toEqual([
      { recipient: FEE_RECIPIENT, role: "fee", amount: grossFee },
      { recipient: LEG1, role: "split", amount: share1 },
      { recipient: LEG2, role: "split", amount: share2 },
      { recipient: OPERATOR, role: "operator-residual", amount: operatorAmount },
    ]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond); // fully routed
  });

  it("2 legs + residual, with truncation dust landing on the operator", async () => {
    // Deliberately not evenly divisible by 10000 so (distributable * bps) / 10000 truncates.
    const amount = 1_000_001n;
    const operatorBond = 7_777n;
    const payoutMap: Payout[] = [
      { recipient: LEG1, bps: 3333n, roleTag: ROLE_A, ipId: zeroHash },
      { recipient: LEG2, bps: 3333n, roleTag: ROLE_B, ipId: zeroHash },
    ];
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Attested }),
      payoutMapSet: true,
      payoutMap,
      protocolRoot: zeroAddress, // isolate the split/truncation math from fee math
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });

    expect(failed(r)).toEqual([]);
    expect(r.legs).toEqual([
      { recipient: LEG1, role: "split", bps: 3333, roleTag: ROLE_A, ipId: zeroHash },
      { recipient: LEG2, role: "split", bps: 3333, roleTag: ROLE_B, ipId: zeroHash },
      { recipient: OPERATOR, role: "operator-residual", residualBps: 10000 - 6666, plusBond: operatorBond },
    ]);

    // Hand computation of the contract's math (release()'s _distributeWithMap), independent
    // of the module under test: fee is 0 (no root), so distributable === amount.
    const distributable = amount;
    const share1 = (distributable * 3333n) / 10000n;
    const share2 = (distributable * 3333n) / 10000n;
    expect(share1).toBe(333_300n); // floor(3,333,003,333 / 10,000) — genuine truncation
    const distributed = share1 + share2;
    const operatorAmount = distributable - distributed + operatorBond;
    // No root here, so grossFee is 0 — no "fee" row, just the split legs + operator.
    expect(r.projected).toEqual([
      { recipient: LEG1, role: "split", amount: share1 },
      { recipient: LEG2, role: "split", amount: share2 },
      { recipient: OPERATOR, role: "operator-residual", amount: operatorAmount },
    ]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond);
  });
});

describe("readMilestoneRecipients — V3 fee-from-attestation", () => {
  it("before attestation: fee unknown (null/null), not final, no projected — but ok stays true", async () => {
    const { client } = makeClient("v3", {
      milestone: mkV3({ status: MilestoneStatusV3.Evidenced, amount: 1_000n, operatorBond: 10n }),
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v3", milestoneIndex: 0n });

    // fee-known is the only FAILED check (it's informational), and must not drag ok down.
    expect(failed(r)).toEqual(["fee-known"]);
    expect(checkNamed(r, "fee-known")?.ok).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.fee).toEqual({ recipient: null, bps: null, final: false, source: "none" });
    expect(r.projected).toBeUndefined();
    // legs don't depend on the fee at all — still fully reported.
    expect(r.legs).toEqual([{ recipient: OPERATOR, role: "operator-residual", residualBps: 10000, plusBond: 10n }]);
  });

  it("Attested or later: fee from the attestation, final true, source 'attested'", async () => {
    const amount = 200_000n;
    const operatorBond = 500n;
    const { client } = makeClient("v3", {
      // R2-M1a fix: a genuinely-Attested V3 milestone always has a real EAS UID — submitAttestation
      // writes BOTH verifierAttestationUid and the fee fields in the same call, together.
      milestone: mkV3({
        status: MilestoneStatusV3.Attested,
        amount,
        operatorBond,
        verifierAttestationUid: ATTESTATION_UID,
        attestedFeeBps: 500,
        attestedFeeRecipient: FEE_RECIPIENT,
      }),
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v3", milestoneIndex: 0n });

    expect(failed(r)).toEqual([]);
    expect(r.fee).toEqual({ recipient: FEE_RECIPIENT, bps: 500, final: true, source: "attested" });
    const fee = (amount * 500n) / 10000n;
    expect(r.projected).toEqual([
      { recipient: FEE_RECIPIENT, role: "fee", amount: fee },
      { recipient: OPERATOR, role: "operator-residual", amount: amount - fee + operatorBond },
    ]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond); // fully routed
  });

  it("F2: Attested with bps > 0 but a ZERO recipient — V3 takes NO fee at all (mirrors the contract's guard)", async () => {
    // V3's _distributeLegacy/_distributeWithMap only take the fee when feeBps > 0 AND
    // feeRecipient != address(0); submitAttestation itself refuses this combination, but
    // the projection must mirror the contract defensively rather than trust that invariant.
    const amount = 300_000n;
    const operatorBond = 1_000n;
    const { client } = makeClient("v3", {
      // R2-M1a fix: same reasoning — Attested implies a real EAS UID, even in this
      // defensive (bps>0, zero-recipient) scenario submitAttestation itself refuses.
      milestone: mkV3({
        status: MilestoneStatusV3.Attested,
        amount,
        operatorBond,
        verifierAttestationUid: ATTESTATION_UID,
        attestedFeeBps: 500,
        attestedFeeRecipient: zeroAddress,
      }),
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v3", milestoneIndex: 0n });

    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    // .fee keeps reporting the attested values AS READ — bps 500 is a fact, not a guess.
    expect(r.fee).toEqual({ recipient: null, bps: 500, final: true, source: "attested" });
    // but the projection takes NO fee: no "fee" row, operator gets the FULL amount + bond.
    expect(r.projected).toEqual([{ recipient: OPERATOR, role: "operator-residual", amount: amount + operatorBond }]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond); // fully routed (zero fee, safely)
  });
});

describe("readMilestoneRecipients — recipientsFinal and existence", () => {
  it("Unfunded gives recipientsFinal:false (map could still change)", async () => {
    const { client } = makeClient("v2", { milestone: mkV2({ status: MilestoneStatusV2.Unfunded }) });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(true);
    expect(r.recipientsFinal).toBe(false);
  });

  it("every non-Unfunded status gives recipientsFinal:true", async () => {
    for (const status of [
      MilestoneStatusV2.Funded,
      MilestoneStatusV2.Locked,
      MilestoneStatusV2.Evidenced,
      MilestoneStatusV2.Attested,
      MilestoneStatusV2.Released,
      MilestoneStatusV2.Disputed,
      MilestoneStatusV2.Refunded,
      MilestoneStatusV2.Slashed,
    ]) {
      const { client } = makeClient("v2", { milestone: mkV2({ status }) });
      const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
      expect(r.recipientsFinal).toBe(true);
    }
  });

  it("an out-of-range index fails 'milestone-exists', ok:false, no throw", async () => {
    const { client } = makeClient("v2", { milestoneCount: 1n });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 1n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["milestone-exists"]);
    expect(r.status).toBeUndefined();
  });
});

describe("readMilestoneRecipients — never throws; fails closed by name", () => {
  it("a read failure gives ok:false, named 'milestone-read', and does not throw", async () => {
    const { client } = makeClient("v2", { throwOn: "getPayoutMap" });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["milestone-read"]);
  });

  it("a chain id that changes mid-call gives ok:false, named 'chain-id-stable'", async () => {
    const { client } = makeClient("v2", { chainIds: [1337, 1] });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["chain-id-stable"]);
    // everything else still ran and is still reported — only the chain-id check failed.
    expect(r.status).toBe(MilestoneStatusV2.Funded);
  });

  it("a node that cannot serve EIP-1898 fails closed on 'pinned-block' alone, nothing else runs", async () => {
    const { client, calls } = makeClient("v2", { eip1898Unsupported: true });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    // R2-L2 added 'escrow-address' as a check BEFORE the pin is even attempted (a valid
    // ESCROW here, so it passes) — 'pinned-block' remains the only FAILED check, and
    // nothing past it runs.
    expect(r.checks).toEqual([
      { name: "escrow-address", ok: true, detail: expect.any(String) },
      { name: "pinned-block", ok: false, detail: expect.stringContaining("EIP-1898") },
    ]);
    expect(calls).toEqual([]); // the first (and only) attempted eth_call threw before any decoded
  });

  it("a stub where payoutMapSet is FALSE but getPayoutMap returns a leg gives ok:false, named 'map-read-consistent'", async () => {
    // F1: the only real inconsistency is this direction — unset, but the map read returns
    // legs. (`payoutMapSet:true` with ZERO legs is a VALID state, covered by the F1 test
    // in the "V2 legacy path" describe block above — it must NOT fail this check.)
    const { client } = makeClient("v2", {
      payoutMapSet: false,
      payoutMap: [{ recipient: LEG1, bps: 3000n, roleTag: ROLE_A, ipId: zeroHash }],
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["map-read-consistent"]);
  });

  it("a corrupted map (zero bps leg) fails 'map-bps-within-bounds', re-checked from the read", async () => {
    const { client } = makeClient("v2", {
      payoutMapSet: true,
      payoutMap: [{ recipient: LEG1, bps: 0n, roleTag: ROLE_A, ipId: zeroHash }],
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["map-bps-within-bounds"]);
  });

  it("a map with more than MAX_PAYOUTS (16) legs fails 'map-bps-within-bounds'", async () => {
    const payoutMap: Payout[] = Array.from({ length: 17 }, (_, i) => ({
      recipient: getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
      bps: 1n,
      roleTag: ROLE_A,
      ipId: zeroHash,
    }));
    const { client } = makeClient("v2", { payoutMapSet: true, payoutMap });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["map-bps-within-bounds"]);
  });

  it("F4: a V2 root with bps > 0 and a ZERO feeRecipient() — 'fee-recipient-set' fires, but ok stays true", async () => {
    // _distributeLegacy transfers to root.feeRecipient() UNCONDITIONALLY whenever a root is
    // set — a zero recipient makes that ERC-20 transfer revert, so release() cannot succeed
    // until the root is fixed. This is informational (like fee-known): reported, not guessed.
    const amount = 10_000_000n;
    const operatorBond = 500_000n;
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Attested }),
      protocolRoot: ROOT,
      rootFeeBps: 235n,
      rootFeeRecipient: zeroAddress,
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });

    expect(r.ok).toBe(true); // fee-recipient-set is excluded from `ok`, like fee-known
    expect(r.fee).toEqual({ recipient: null, bps: 235, final: false, source: "root" });
    expect(checkNamed(r, "fee-recipient-set")).toEqual({
      name: "fee-recipient-set",
      ok: false,
      detail: expect.stringContaining("release would revert"),
    });
    // The computed fee (>0) has nowhere valid to go, so it's omitted as a row entirely —
    // the sum deliberately falls SHORT of amount + operatorBond by exactly that stuck fee
    // (the one case F3's "fully routed" identity does not hold; that's the point of the check).
    const grossFee = (amount * 235n) / 10000n;
    expect(r.projected).toEqual([{ recipient: OPERATOR, role: "operator-residual", amount: amount - grossFee + operatorBond }]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond - grossFee);
  });

  it("F4b: a V2 root at 0 bps with a ZERO feeRecipient() still blocks the legacy path, not the map path", async () => {
    // _distributeLegacy transfers to root.feeRecipient() even when the fee is 0, and an ERC-20
    // transfer to the zero address reverts whatever the amount. _distributeWithMap transfers only
    // when the fee is above 0, so the same root does not block a milestone with a payout map.
    const amount = 10_000_000n;
    const operatorBond = 500_000n;
    const base = {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Attested }),
      protocolRoot: ROOT,
      rootFeeBps: 0n,
      rootFeeRecipient: zeroAddress,
    };

    const legacy = await readMilestoneRecipients({ client: makeClient("v2", base).client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(legacy.ok).toBe(true);
    expect(checkNamed(legacy, "fee-recipient-set")?.ok).toBe(false);

    const mapped = await readMilestoneRecipients({
      client: makeClient("v2", {
        ...base,
        payoutMapSet: true,
        payoutMap: [{ recipient: LEG1, bps: 2000n, roleTag: ROLE_A, ipId: zeroHash }],
      }).client,
      escrow: ESCROW,
      version: "v2",
      milestoneIndex: 0n,
    });
    expect(mapped.ok).toBe(true);
    expect(checkNamed(mapped, "fee-recipient-set")?.ok).toBe(true);
  });
});

describe("readMilestoneRecipients — pins every read to one block, by hash", () => {
  it("every eth_call carries the SAME { blockHash, requireCanonical: true } pin", async () => {
    const { client, calls } = makeClient("v2", {
      protocolRoot: ROOT,
      rootFeeBps: 100n,
      rootFeeRecipient: FEE_RECIPIENT,
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(true);
    expect(r.blockNumber).toBe(HEAD);
    expect(r.blockHash).toBe(hashOf(HEAD));
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.pin).toEqual({ blockHash: hashOf(HEAD), requireCanonical: true });
    }
  });

  it("honors an explicit blockNumber instead of the latest", async () => {
    const { client } = makeClient("v2", {});
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n, blockNumber: HEAD - 5n });
    expect(r.blockNumber).toBe(HEAD - 5n);
    expect(r.blockHash).toBe(hashOf(HEAD - 5n));
  });
});

/**
 * N102 round 2 — pack 411 (astra, SHIP-WITH-FIXES on #556 @8731dd9b). PHASE 1: each of these
 * asserts the CORRECT behaviour and must FAIL at 8731dd9b (the bug is real); PHASE 2 (the
 * source fixes in milestone-recipients.ts) makes them pass. See BRIEF-r2.md and the verdict
 * at review-packs-for-chatgpt-20260924/411-n102-556-recipients-astra-8731dd9b.astra.verdict.md.
 */
describe("N102 round 2 — Phase 1 repro (findings R2-M1a, R2-M1b, R2-M2, R2-L1, R2-L2)", () => {
  it("R2-M1a: V3 Refunded without any attestation must NOT report the fee as attested, and must NOT project a release", async () => {
    // Today (8731dd9b, :340): `status >= Attested` is true for Refunded (7 >= 4) by pure
    // numeric luck, even though reclaimAfterDeadline never touches attestation state —
    // every attestation field is still the zeroed default from addMilestone.
    const { client } = makeClient("v3", {
      milestone: mkV3({ status: MilestoneStatusV3.Refunded, amount: 1000n, operatorBond: 0n }),
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v3", milestoneIndex: 0n });
    expect(r.fee?.source).not.toBe("attested");
    expect(r.fee?.final).not.toBe(true);
    expect(r.projected).toBeUndefined(); // the money went back to the payer, not the operator
    expect(r.outcome).toBe("refunded");
    expect(r.projectionBasis).toBeUndefined();
    expect(r.ok).toBe(true); // fee-known/fee-recipient-set are informational; nothing else failed
  });

  it("R2-M1b: Released via resolveDispute(false) must project amount+operatorBond+challengerBond to the operator — no fee, no splits", async () => {
    // Today (8731dd9b, :474): the reader does not read the dispute record at all, so a
    // Released milestone with a payout map AND a root fee still gets ordinary splits —
    // even though resolveDispute(false) (MilestoneEscrowV2.sol:1113-1153) bypasses both
    // entirely and sends the operator amount + operatorBond + challengerBond in full.
    const amount = 100_000n;
    const operatorBond = 5_000n;
    const challengerBond = 2_000n;
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Released }),
      payoutMapSet: true,
      payoutMap: [{ recipient: LEG1, bps: 3000n, roleTag: ROLE_A, ipId: zeroHash }], // would ordinarily split
      protocolRoot: ROOT, rootFeeBps: 500n, rootFeeRecipient: FEE_RECIPIENT, // would ordinarily take a fee
      dispute: { challenger: CHALLENGER, challengerBond, resolved: true, challengerWon: false },
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.outcome).toBe("released-by-dispute");
    expect(r.projectionBasis).toBe("actual");
    expect(r.projected).toEqual([
      { recipient: OPERATOR, role: "operator-dispute-award", amount: amount + operatorBond + challengerBond },
    ]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond + challengerBond);
  });

  it("R2-M2: a single leg at 6000 bps exceeds MAX_SINGLE_BPS (5000) and must fail 'map-bps-within-bounds'", async () => {
    // Today (8731dd9b, :385): the bounds re-check has no per-leg ceiling at all.
    const { client } = makeClient("v2", {
      payoutMapSet: true,
      payoutMap: [{ recipient: LEG1, bps: 6000n, roleTag: ROLE_A, ipId: zeroHash }],
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["map-bps-within-bounds"]);
  });

  it("R2-L1: Unfunded with payoutMapSet:true (even an empty map) is ALREADY final — setPayoutMap is single-shot", async () => {
    // Today (8731dd9b, :367): recipientsFinal looks only at status, so an Unfunded milestone
    // always reports false — even though setPayoutMap (V2 :688, V3 :590) can never run again.
    const { client } = makeClient("v2", {
      milestone: mkV2({ status: MilestoneStatusV2.Unfunded }),
      payoutMapSet: true,
      payoutMap: [],
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.recipientsFinal).toBe(true);
  });

  it("R2-L2: an invalid escrow address must never throw — ok:false, named 'escrow-address'", async () => {
    // Today (8731dd9b, :186): `getAddress(params.escrow)` runs before any try/catch, so an
    // invalid address string throws OUT of readMilestoneRecipients entirely.
    const { client } = makeClient("v2", {});
    const r = await readMilestoneRecipients({
      client,
      escrow: "not-an-address" as Address,
      version: "v2",
      milestoneIndex: 0n,
    });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["escrow-address"]);
  });
});

/**
 * N102 round 2 — Phase 2 supplementary coverage: the rest of M1's outcome table (BRIEF-r2.md
 * lines 29-42) not already exercised by the Phase 1 repro tests above. Needed for genuine
 * mutant-killing coverage of mutants (j)-(m), not just the two findings astra reproduced.
 */
describe("N102 round 2 — Phase 2: the full M1 outcome table", () => {
  it("'pending' for every pre-Released status, with projectionBasis 'conditional'", async () => {
    for (const status of [
      MilestoneStatusV2.Funded,
      MilestoneStatusV2.Locked,
      MilestoneStatusV2.Evidenced,
      MilestoneStatusV2.Attested,
    ]) {
      const { client } = makeClient("v2", { milestone: mkV2({ status, amount: 1000n, operatorBond: 10n }) });
      const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
      expect(r.outcome).toBe("pending");
      expect(r.projectionBasis).toBe("conditional");
      expect(r.projected).toEqual([{ recipient: OPERATOR, role: "operator-residual", amount: 1010n }]);
    }
  });

  it("'released' (ordinary release, no resolved dispute) has projectionBasis 'actual' — distinct from 'released-by-dispute'", async () => {
    const { client } = makeClient("v2", {
      milestone: mkV2({ status: MilestoneStatusV2.Released, amount: 1000n, operatorBond: 10n }),
      // default dispute (NO_DISPUTE): resolved:false — no dispute ever touched this milestone.
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.outcome).toBe("released");
    expect(r.projectionBasis).toBe("actual");
    expect(r.projected).toEqual([{ recipient: OPERATOR, role: "operator-residual", amount: 1010n }]);
  });

  it("'released' through a V2 ROOT is 'estimated', not 'actual': the root's rate is mutable and read at this block", async () => {
    // The release used the rate at its own block. A later read can only reproduce it if the rate never changed,
    // so the reader must not claim the amounts are actual.
    const { client } = makeClient("v2", {
      milestone: mkV2({ status: MilestoneStatusV2.Released, amount: 1000n, operatorBond: 10n }),
      protocolRoot: ROOT,
      rootFeeBps: 235n,
      rootFeeRecipient: FEE_RECIPIENT,
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.outcome).toBe("released");
    expect(r.fee?.final).toBe(false);
    expect(r.projectionBasis).toBe("estimated");
  });

  it("'slashed': resolveDispute(true) projects a payer-refund AND a challenger-award, summing to amount+operatorBond+challengerBond", async () => {
    const amount = 50_000n;
    const operatorBond = 3_000n;
    const challengerBond = 1_500n;
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount, operatorBond, status: MilestoneStatusV2.Slashed }),
      payer: PAYER,
      dispute: { challenger: CHALLENGER, challengerBond, resolved: true, challengerWon: true },
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.outcome).toBe("slashed");
    expect(r.projectionBasis).toBe("actual");
    expect(r.projected).toEqual([
      { recipient: PAYER, role: "payer-refund", amount },
      { recipient: CHALLENGER, role: "challenger-award", amount: challengerBond + operatorBond },
    ]);
    expect(r.projected!.reduce((s, p) => s + p.amount, 0n)).toBe(amount + operatorBond + challengerBond);
  });

  it("'disputed': no projection at all — the arbiter has not yet decided", async () => {
    const { client } = makeClient("v2", {
      milestone: mkV2({ status: MilestoneStatusV2.Disputed, amount: 1000n, operatorBond: 10n }),
      dispute: { challenger: CHALLENGER, challengerBond: 100n, resolved: false, challengerWon: false },
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.outcome).toBe("disputed");
    expect(r.projectionBasis).toBeUndefined();
    expect(r.projected).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("V2 can never reach Refunded on the real contract, but is still handled defensively, the same as V3", async () => {
    const { client } = makeClient("v2", { milestone: mkV2({ status: MilestoneStatusV2.Refunded, amount: 1000n }) });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.outcome).toBe("refunded");
    expect(r.projected).toBeUndefined();
  });

  it("a dispute-read failure gives ok:false, named 'dispute-read', no throw — but status/fee/legs already read are still returned", async () => {
    const { client } = makeClient("v2", {
      milestone: mkV2({ amount: 1000n, operatorBond: 10n, status: MilestoneStatusV2.Attested }),
      throwOn: "disputes",
    });
    const r = await readMilestoneRecipients({ client, escrow: ESCROW, version: "v2", milestoneIndex: 0n });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["dispute-read"]);
    expect(r.status).toBe(MilestoneStatusV2.Attested);
    expect(r.fee).toEqual({ recipient: null, bps: 0, final: true, source: "none" });
    expect(r.outcome).toBeUndefined();
    expect(r.projected).toBeUndefined();
  });
});
