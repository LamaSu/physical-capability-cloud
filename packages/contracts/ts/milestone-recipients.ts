/**
 * milestone-recipients.ts — N102: the escrow half of the milestone-recipient check.
 *
 * An operator confirms a payout destination off-chain; this module answers the other
 * half: what will THIS escrow actually pay, to whom, at one pinned block. It is a pure
 * read — it never writes — so a caller (gateway, or anyone) can compare the operator's
 * claim against the escrow's own on-chain truth. See bus #5657 for the design handoff.
 *
 * Covers both `MilestoneEscrowV2` and `MilestoneEscrowV3` (packages/contracts/src/
 * MilestoneEscrowV2.sol / MilestoneEscrowV3.sol). The two versions diverge on exactly
 * one axis that matters here — where the protocol fee comes from:
 *   - V2 reads `protocolRoot.protocolFeeBps()` / `.feeRecipient()` AT RELEASE TIME. Both
 *     can change before release, so a live read is informative but never final.
 *   - V3 reads `m.attestedFeeBps` / `m.attestedFeeRecipient`, written once by
 *     `submitAttestation` and frozen on the milestone from that point on — known only
 *     once the milestone is Attested or later, but final from then on.
 * Everything else (the split-vs-legacy distribution, the truncation/dust rule, the
 * Unfunded→map-immutable rule) is identical between the two and implemented once
 * below — EXCEPT one more divergence lead review 1 surfaced: V3 only takes the fee when
 * `feeBps > 0 && feeRecipient != address(0)` (both `_distributeLegacy`/`_distributeWithMap`);
 * V2 attempts its fee transfer UNCONDITIONALLY whenever a root is set, with no such guard,
 * which is why `fee-recipient-set` below exists — a V2 root can be misconfigured (a fee
 * rate with no recipient) in a way V3 structurally cannot.
 *
 * PINNING. Every read in a single call to `readMilestoneRecipients` is a raw `eth_call`
 * pinned to ONE block by HASH (EIP-1898, `{ blockHash, requireCanonical: true }`), so a
 * reorganized block number can never answer for the block this call actually read. The
 * block is resolved once (the caller's `blockNumber`, else the latest), then every
 * subsequent read is pinned to that block's hash. The chain id is read before AND after
 * the reads; a change between the two means the node changed chains mid-read and fails
 * the result closed. A node that cannot serve a hash-pinned `eth_call`, any read that
 * fails, or a milestone index out of range each produce `ok: false` with a named check —
 * this function NEVER throws for those. (Deliberately self-contained: no import from the
 * in-flight #536 branch — this is its own small pinned-call helper.)
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  MilestoneEscrowV2ABI,
  MilestoneStatusV2,
  milestoneStatusV2Name,
} from "./abi/MilestoneEscrowV2.js";
import {
  MilestoneEscrowV3ABI,
  MilestoneStatusV3,
  milestoneStatusV3Name,
} from "./abi/MilestoneEscrowV3.js";
import { PCCProtocolV2ABI } from "./abi/PCCProtocolV2.js";

/** `MilestoneEscrowV2.sol` has no public `protocolRoot()` / `tokenForMilestone(uint256)`
 *  entries in its generated TS ABI (`ts/abi/MilestoneEscrowV2.ts`) even though the deployed
 *  contract has both (an auto-generated public-variable getter, and a real view function).
 *  V3's generated ABI already carries both — this fragment is V2-only. */
const V2_LOCAL_ABI = parseAbi([
  "function protocolRoot() view returns (address)",
  "function tokenForMilestone(uint256 milestoneIndex) view returns (address)",
]);

/** Mirrors `MilestoneEscrowV2.sol` / `MilestoneEscrowV3.sol`'s `MAX_PAYOUTS` constant. */
const MAX_PAYOUTS = 16;

export type MilestoneVersion = "v2" | "v3";

export interface MilestoneRecipientsCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface MilestoneRecipientSplitLeg {
  recipient: Address;
  role: "split";
  bps: number;
  roleTag: Hex;
  ipId: Hex;
}

export interface MilestoneRecipientOperatorLeg {
  recipient: Address;
  role: "operator-residual";
  /** `10000 - sum(split legs' bps)`. 10000 when no split map is set (legacy path). */
  residualBps: number;
  plusBond: bigint;
}

export type MilestoneRecipientLeg = MilestoneRecipientSplitLeg | MilestoneRecipientOperatorLeg;

export interface MilestoneRecipientFee {
  recipient: Address | null;
  bps: number | null;
  /** True once the fee can never change again (V3 once attested; V2 only when there is
   *  no root at all, since a root's fee/recipient can still move before release). */
  final: boolean;
  source: "root" | "attested" | "none";
}

export interface MilestoneRecipientProjection {
  recipient: Address;
  /** "fee" appears first (matching the contract's transfer order) only when the computed
   *  fee amount is above 0 AND the recipient is known — see `fee-recipient-set`. */
  role: "fee" | "split" | "operator-residual";
  /** Computed exactly like the contract: fee on the gross (V2: whenever a root is set,
   *  unconditionally; V3: only when bps > 0 AND the recipient is non-zero — see
   *  `readMilestoneRecipients`'s `grossFee`), truncated per-leg shares in on-chain map
   *  order, integer dust folded into the operator's residual. `sum(amount)` over every row
   *  equals `amount + operatorBond` whenever the fee is fully routed (a "fee" row present,
   *  or no fee at all) — it falls short by the fee only in the one state `fee-recipient-set`
   *  flags: a fee amount with nowhere valid to send it. */
  amount: bigint;
}

export interface MilestoneRecipients {
  /** The AND of every check EXCEPT the informational `fee-known` / `fee-recipient-set`
   *  (see their own docs below). */
  ok: boolean;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  chainId: number | null;
  escrow: Address;
  version: MilestoneVersion;
  milestoneIndex: bigint;
  /** Everything below is populated once `milestone-exists` and `milestone-read` both pass;
   *  left undefined otherwise — this function reports absence of data, never guesses it. */
  status?: number;
  statusName?: string;
  token?: Address;
  amount?: bigint;
  operatorBond?: bigint;
  /** `status !== Unfunded` — once funded, `setPayoutMap` can never run again (onlyPayer +
   *  requires Unfunded), so the recipient set (map or legacy) is locked in from here on. */
  recipientsFinal?: boolean;
  fee?: MilestoneRecipientFee;
  /** In on-chain map order: each split leg, then always one operator-residual leg last
   *  (residualBps is 10000 on the legacy path, where there are no split legs at all). */
  legs?: MilestoneRecipientLeg[];
  /** Only present when `fee.bps !== null` — see `fee-known` below. */
  projected?: MilestoneRecipientProjection[];
  checks: MilestoneRecipientsCheck[];
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const short = (e as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string") return short;
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string") return msg.split("\n")[0] ?? msg;
  }
  return String(e);
}

/** Minimal struct shape `getMilestone` decodes into — named fields, viem decodes a
 *  single named-tuple output as a plain object keyed by the Solidity struct's field names.
 *  `status` is the enum's underlying `uint8` and `attestedFeeBps` is `uint16` — viem
 *  decodes both as plain `number` (bigint is only used for uint56 and wider). `amount` /
 *  `operatorBond` are `uint256` and decode as `bigint`. */
type MilestoneStruct = {
  operator: Address;
  amount: bigint;
  status: number;
  operatorBond: bigint;
  // V3 only; absent (undefined) when decoded against the V2 ABI.
  attestedFeeBps?: number;
  attestedFeeRecipient?: Address;
};

type PayoutStruct = { recipient: Address; bps: bigint; roleTag: Hex; ipId: Hex };

export async function readMilestoneRecipients(params: {
  client: PublicClient;
  escrow: Address;
  version: MilestoneVersion;
  milestoneIndex: bigint;
  /** Pin a specific block. Default: the latest block, read once at the call. */
  blockNumber?: bigint;
}): Promise<MilestoneRecipients> {
  const { client, version, milestoneIndex } = params;
  const escrow = getAddress(params.escrow);
  const escrowAbi = (version === "v2" ? MilestoneEscrowV2ABI : MilestoneEscrowV3ABI) as Abi;

  const checks: MilestoneRecipientsCheck[] = [];
  const record = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };
  /** `fee-known` and `fee-recipient-set` are informational only (facts about the fee's
   *  current state, not failures of this read), so both are reported in `checks` but
   *  deliberately excluded from the `ok` AND. */
  const INFORMATIONAL_CHECKS = new Set(["fee-known", "fee-recipient-set"]);
  const okOf = () => checks.filter((c) => !INFORMATIONAL_CHECKS.has(c.name)).every((c) => c.ok);

  // The chain id, before anything is pinned. Read again at the very end.
  let chainIdBefore: number | null;
  try {
    chainIdBefore = await client.getChainId();
  } catch {
    chainIdBefore = null;
  }

  /** No block was ever successfully pinned (resolving it failed, or the first pinned
   *  call proved the node can't serve one) — return immediately, same as a precedent
   *  pinned-call helper in this codebase (vnext/preflight.ts): when the pin itself is
   *  the failure, nothing downstream — not even the chain-id-after read — runs. */
  const shortCircuit = (blockNumber: bigint | null, blockHash: Hex | null): MilestoneRecipients => ({
    ok: okOf(),
    blockNumber,
    blockHash,
    chainId: chainIdBefore,
    escrow,
    version,
    milestoneIndex,
    checks,
  });

  /** Everything past the pin succeeded in resolving a block; always closes out with the
   *  chain-id-after read and check, whether or not the milestone itself was readable. */
  const finish = async (
    blockNumber: bigint,
    blockHash: Hex,
    extra: Partial<MilestoneRecipients> = {},
  ): Promise<MilestoneRecipients> => {
    let chainIdAfter: number | null;
    try {
      chainIdAfter = await client.getChainId();
    } catch {
      chainIdAfter = null;
    }
    record(
      "chain-id-stable",
      chainIdBefore !== null && chainIdAfter !== null && chainIdBefore === chainIdAfter,
      `before ${chainIdBefore ?? "unread"}; after ${chainIdAfter ?? "unread"}`,
    );
    return {
      ok: okOf(),
      blockNumber,
      blockHash,
      chainId: chainIdAfter ?? chainIdBefore,
      escrow,
      version,
      milestoneIndex,
      checks,
      ...extra,
    };
  };

  // 0. Resolve the one block everything below pins to.
  let blockNumber: bigint;
  let blockHash: Hex;
  try {
    const b =
      params.blockNumber === undefined
        ? await client.getBlock()
        : await client.getBlock({ blockNumber: params.blockNumber });
    if (b.number === null || b.hash === null) {
      throw new Error("the node returned a pending block, which has no number or hash to pin");
    }
    blockNumber = b.number;
    blockHash = b.hash;
  } catch (e) {
    record("pinned-block", false, `could not resolve a block to pin: ${errMsg(e)}`);
    return shortCircuit(null, null);
  }

  const read = async <T>(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<T> => {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const ret = (await client.request({
      method: "eth_call",
      params: [{ to: address, data }, { blockHash, requireCanonical: true }],
    } as never)) as Hex;
    return decodeFunctionResult({ abi, functionName, data: ret } as never) as T;
  };

  // 1. The first pinned read doubles as the EIP-1898 support probe: a node that cannot
  //    serve a hash-pinned eth_call fails here, closed, before anything else runs.
  let milestoneCount: bigint;
  try {
    milestoneCount = await read<bigint>(escrow, escrowAbi, "getMilestoneCount");
  } catch (e) {
    record(
      "pinned-block",
      false,
      `the node could not serve a call pinned by block hash (EIP-1898, requireCanonical) at block ${blockNumber}: ${errMsg(e)}`,
    );
    return shortCircuit(blockNumber, blockHash);
  }
  record("pinned-block", true, `every read ran at block ${blockNumber}, addressed by hash ${blockHash}`);

  // 2. The milestone must exist before anything else is read (every other view reverts
  //    on an out-of-range index via the contract's own `milestoneExists` modifier).
  if (!record("milestone-exists", milestoneIndex < milestoneCount, `index ${milestoneIndex} of ${milestoneCount} milestone(s)`)) {
    return finish(blockNumber, blockHash);
  }

  // 3. The milestone's full on-chain state: the struct, the map-set flag, the map itself,
  //    the token, and (V2 only) the root + its live fee. One phase, one named check —
  //    on the pinned block, if getMilestoneCount and the index bound both held, every one
  //    of these should succeed; a failure here means the node is behaving inconsistently
  //    even within a single pinned block, which is itself the thing worth reporting.
  let m: MilestoneStruct;
  let payoutMapSetFlag: boolean;
  let payouts: PayoutStruct[];
  let token: Address;
  let fee: MilestoneRecipientFee;
  try {
    m = await read<MilestoneStruct>(escrow, escrowAbi, "getMilestone", [milestoneIndex]);
    payoutMapSetFlag = await read<boolean>(escrow, escrowAbi, "payoutMapSet", [milestoneIndex]);
    payouts = await read<PayoutStruct[]>(escrow, escrowAbi, "getPayoutMap", [milestoneIndex]);

    if (version === "v2") {
      token = getAddress(await read<Address>(escrow, V2_LOCAL_ABI, "tokenForMilestone", [milestoneIndex]));
      const root = await read<Address>(escrow, V2_LOCAL_ABI, "protocolRoot");
      if (root === zeroAddress) {
        fee = { recipient: null, bps: 0, final: true, source: "none" };
      } else {
        const feeBps = await read<bigint>(root, PCCProtocolV2ABI as Abi, "protocolFeeBps");
        const feeRecipient = await read<Address>(root, PCCProtocolV2ABI as Abi, "feeRecipient");
        fee = {
          recipient: feeRecipient === zeroAddress ? null : getAddress(feeRecipient),
          bps: Number(feeBps),
          final: false,
          source: "root",
        };
      }
    } else {
      token = getAddress(await read<Address>(escrow, escrowAbi, "tokenForMilestone", [milestoneIndex]));
      const status = Number(m.status);
      if (status >= MilestoneStatusV3.Attested) {
        const attestedFeeBps = m.attestedFeeBps ?? 0;
        const attestedFeeRecipient = m.attestedFeeRecipient ?? zeroAddress;
        fee = {
          recipient: attestedFeeRecipient === zeroAddress ? null : getAddress(attestedFeeRecipient),
          bps: attestedFeeBps,
          final: true,
          source: "attested",
        };
      } else {
        // Not yet attested: attestedFeeBps/attestedFeeRecipient are still the zeroed
        // defaults from addMilestone, not a meaningful "zero fee" — report unknown, not 0.
        fee = { recipient: null, bps: null, final: false, source: "none" };
      }
    }
  } catch (e) {
    record("milestone-read", false, `index ${milestoneIndex} exists, but reading its state failed: ${errMsg(e)}`);
    return finish(blockNumber, blockHash);
  }
  record("milestone-read", true, `status, map, token${version === "v2" ? " and root fee" : " and attested fee"} all read`);

  const status = Number(m.status);
  const statusName = version === "v2" ? milestoneStatusV2Name(status) : milestoneStatusV3Name(status);
  const operator = getAddress(m.operator);
  const amount = m.amount;
  const operatorBond = m.operatorBond;
  const unfunded = version === "v2" ? MilestoneStatusV2.Unfunded : MilestoneStatusV3.Unfunded;
  const recipientsFinal = status !== unfunded;

  // 4. map-read-consistent: `payoutMapSet` (a separate top-level mapping) must agree with
  //    what `getPayoutMap` actually returned. `setPayoutMap` has NO minimum length (V2 and
  //    V3 alike only require payouts.length <= MAX_PAYOUTS), so `payoutMapSet == true` with
  //    ZERO legs is a VALID on-chain state — release() then pays the operator the full
  //    distributable + bond through `_distributeWithMap`, same as the legacy path. The
  //    only real inconsistency is the other direction: unset, but the map read returns legs.
  record(
    "map-read-consistent",
    payoutMapSetFlag || payouts.length === 0,
    `payoutMapSet=${payoutMapSetFlag}; getPayoutMap returned ${payouts.length} leg(s)`,
  );

  // 5. map-bps-within-bounds: re-checked from the read itself (not trusted from
  //    setPayoutMap's own guard, which ran in the past and against different calldata).
  let sumBps = 0n;
  const boundsProblems: string[] = [];
  for (const p of payouts) {
    if (p.bps <= 0n) boundsProblems.push(`leg ${p.recipient} has bps <= 0`);
    if (p.recipient === zeroAddress) boundsProblems.push("leg has a zero recipient");
    sumBps += p.bps;
  }
  if (sumBps > 10000n) boundsProblems.push(`sum of bps (${sumBps}) exceeds 10000`);
  if (payouts.length > MAX_PAYOUTS) boundsProblems.push(`${payouts.length} legs exceeds MAX_PAYOUTS (${MAX_PAYOUTS})`);
  record(
    "map-bps-within-bounds",
    boundsProblems.length === 0,
    boundsProblems.length ? boundsProblems.join("; ") : `sum ${sumBps} bps across ${payouts.length} leg(s)`,
  );

  // 6. fee-known: recorded as information only (see okOf() above) — an unknown V3 fee
  //    before attestation is a fact, not a failure, so it never flips `ok` to false.
  record(
    "fee-known",
    fee.bps !== null,
    fee.bps !== null ? `${fee.bps} bps from ${fee.source}` : "not yet known (V3, not yet attested)",
  );

  // The amount release() would ACTUALLY deduct, shared by the fee-recipient-set check
  // below and `projected`:
  //   - V2 attempts the fee transfer UNCONDITIONALLY whenever a root is set (both
  //     _distributeLegacy and _distributeWithMap call root.feeRecipient()/protocolFeeBps()
  //     and transfer with no guard at all) — so the computed amount is always
  //     amount*bps/10000, independent of whether the recipient is even valid.
  //   - V3 takes the fee ONLY when feeBps > 0 AND feeRecipient != address(0)
  //     (MilestoneEscrowV3.sol _distributeLegacy/_distributeWithMap, ~:849/~:877); anything
  //     else takes the contract's zero-fee branch, so the computed amount is 0 — even
  //     though `.fee` keeps reporting the attested bps/recipient as read. `submitAttestation`
  //     already refuses bps > 0 with a zero recipient, but this mirrors the contract
  //     defensively rather than trusting that invariant.
  const grossFee: bigint | null =
    fee.bps === null
      ? null
      : version === "v3" && !(fee.bps > 0 && fee.recipient !== null)
        ? 0n
        : (amount * BigInt(fee.bps)) / 10000n;

  // 6b. fee-recipient-set: informational only (excluded from `ok`, like fee-known) — false
  //     exactly when the computed fee is above 0 and the recipient is null. In practice
  //     this only ever fires for V2 (a root with protocolFeeBps() > 0 but feeRecipient()
  //     == 0): V3's gate above already zeroes grossFee in that combination, so release()
  //     cannot get stuck on it the way a V2 release can.
  if (grossFee !== null) {
    // V2's legacy path (no payout map) transfers to root.feeRecipient() even when the fee is 0
    // (`_distributeLegacy` has no `fee > 0` guard), and an ERC-20 transfer to the zero address
    // reverts whatever the amount. So with a V2 root and no map, a zero recipient blocks release
    // at ANY bps. The map path transfers only when the fee is above 0.
    const stuck =
      fee.recipient === null &&
      (version === "v2" && fee.source === "root" && !payoutMapSetFlag ? true : grossFee > 0n);
    record(
      "fee-recipient-set",
      !stuck,
      stuck
        ? "release would revert (ERC-20 transfer to the zero address) until the root's feeRecipient is set"
        : `recipient ${fee.recipient ?? "n/a (no fee to route)"}`,
    );
  }

  // 7. legs: every split leg in on-chain map order, then always the operator's residual.
  const sumBpsNumber = Number(sumBps);
  const legs: MilestoneRecipientLeg[] = [
    ...payouts.map((p): MilestoneRecipientSplitLeg => ({
      recipient: getAddress(p.recipient),
      role: "split",
      bps: Number(p.bps),
      roleTag: p.roleTag,
      ipId: p.ipId,
    })),
    {
      recipient: operator,
      role: "operator-residual",
      residualBps: 10000 - sumBpsNumber,
      plusBond: operatorBond,
    },
  ];

  // 8. projected: only when the fee is known — same order, same truncation, dust to the
  //    operator, exactly as release()'s _distributeLegacy/_distributeWithMap compute it.
  //    Covers every payee, including the fee: a "fee" row comes FIRST (matching the
  //    contract's transfer order) exactly when grossFee is above 0 and the recipient is
  //    known — the one case it is omitted despite grossFee > 0 is `fee-recipient-set`'s
  //    stuck state (V2, a root fee with no valid recipient), where `sum(amount)` over the
  //    rows below falls short of `amount + operatorBond` by exactly that stuck fee; every
  //    other state (no fee at all, or a fully-routed one) sums to amount + operatorBond.
  let projected: MilestoneRecipientProjection[] | undefined;
  if (grossFee !== null) {
    const distributable = amount - grossFee;
    let distributed = 0n;
    const rows: MilestoneRecipientProjection[] = [];
    if (grossFee > 0n && fee.recipient !== null) {
      rows.push({ recipient: fee.recipient, role: "fee", amount: grossFee });
    }
    for (const p of payouts) {
      const share = (distributable * p.bps) / 10000n;
      distributed += share;
      rows.push({ recipient: getAddress(p.recipient), role: "split", amount: share });
    }
    rows.push({ recipient: operator, role: "operator-residual", amount: distributable - distributed + operatorBond });
    projected = rows;
  }

  return finish(blockNumber, blockHash, {
    status,
    statusName,
    token,
    amount,
    operatorBond,
    recipientsFinal,
    fee,
    legs,
    projected,
  });
}
