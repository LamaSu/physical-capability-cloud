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
 *   - V2 reads `protocolRoot.protocolFeeBps()` / `.feeRecipient()` AT RELEASE TIME.
 *     `final` stays false for V2 not because BOTH can move: the concrete `PCCProtocolV2`
 *     root's `feeRecipient` is an `immutable` (`src/PCCProtocolV2.sol:60`) — fixed forever
 *     once that root is deployed. Only `protocolFeeBps()` (a plain mutable, governance-set
 *     variable) can still change before release. `final:false` for V2 reports "the fee
 *     object as a whole is not yet settled", which stays accurate (the bps half isn't) —
 *     it is NOT a claim that the recipient could also move. A `root` with a different
 *     fee-recipient implementation is a different root entirely, not a mutation of this one.
 *   - V3 reads `m.attestedFeeBps` / `m.attestedFeeRecipient`, written once by
 *     `submitAttestation` and frozen on the milestone from that point on — known only
 *     once a REAL attestation has actually landed (`m.verifierAttestationUid != 0`; never
 *     inferred from the status enum's numeric ordering — see `readMilestoneRecipients`'s
 *     `attested` below), but final from then on.
 * Everything else (the split-vs-legacy distribution, the truncation/dust rule, the
 * Unfunded→map-immutable rule) is identical between the two and implemented once
 * below — EXCEPT one more divergence lead review 1 surfaced: V3 only takes the fee when
 * `feeBps > 0 && feeRecipient != address(0)` (both `_distributeLegacy`/`_distributeWithMap`);
 * V2 attempts its fee transfer UNCONDITIONALLY whenever a root is set, with no such guard,
 * which is why `fee-recipient-set` below exists — a V2 root can be misconfigured (a fee
 * rate with no recipient) in a way V3 structurally cannot.
 *
 * LIFECYCLE EXCEPTIONS (round 2 / pack 411, astra SHIP-WITH-FIXES on #556 @8731dd9b).
 * `release()`'s ordinary fee+split math is only ONE of several ways a milestone settles.
 * `outcome` (below) names which one actually happened (or will, conditionally) — see its
 * own doc and `MilestoneOutcome`. `resolveDispute(false)` sends the operator the ENTIRE
 * amount + both bonds, bypassing fee and map entirely (V2 `:1113-1153`, V3 `:965-1000`);
 * `resolveDispute(true)` (Slashed) refunds the payer and awards the challenger; Refunded
 * (V3 only; `reclaimAfterDeadline`) returns the amount to the payer with no settlement at
 * all. `projected` reflects whichever of these actually applies — never the ordinary
 * release math by default.
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
  zeroHash,
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

/** Mirrors `MilestoneEscrowV2.sol` (`:220`, `:697`) / `MilestoneEscrowV3.sol` (`:249`,
 *  `:599`)'s `MAX_SINGLE_BPS` constant — no single leg may exceed 50% of distributable. */
const MAX_SINGLE_BPS = 5000n;

/** `disputes(uint256)` — the auto-generated public-mapping getter for the `Dispute`
 *  struct. Missing from the generated TS ABIs for both versions (same gap as V2's
 *  `protocolRoot`/`tokenForMilestone`), and identical in both contracts. Multiple named
 *  outputs decode as a PLAIN ARRAY in viem (verified: names on top-level outputs are
 *  display-only, unlike a single named-tuple/struct return) — accessed positionally below. */
const DISPUTE_LOCAL_ABI = parseAbi([
  "function disputes(uint256) view returns (address challenger, uint256 challengerBond, bytes32 challengerEvidenceHash, string reason, bool resolved, bool challengerWon)",
]);

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
  /** True once the fee object as a WHOLE can never change again (V3 once a real
   *  attestation has landed; V2 only when there is no root at all — its root's address can
   *  never change post-init, and a root without one fixes the fee at zero forever).
   *  V2 WITH a root stays `false`: `protocolFeeBps()` is a plain mutable the root's
   *  governance can still move before release. Its `feeRecipient()`, by contrast, IS
   *  immutable on `PCCProtocolV2` (`src/PCCProtocolV2.sol:60`) — `final:false` here is
   *  reporting the bps half, not a claim that the recipient could move too; see `.recipient`
   *  plus the module's own top-of-file doc. */
  final: boolean;
  source: "root" | "attested" | "none";
}

/**
 * How this milestone actually settles (or will, conditionally) — see `readMilestoneRecipients`'s
 * doc for the full table. `release()`'s ordinary fee+split math is only the "pending"/"released"
 * case; disputes, slashing and refunds each bypass it differently.
 */
export type MilestoneOutcome =
  | "pending" // Funded/Locked/Evidenced/Attested — release() has not run yet.
  | "released" // Released via release(), no resolved dispute — ordinary fee+split math applied.
  | "released-by-dispute" // Released via resolveDispute(false) — operator takes amount + both bonds.
  | "slashed" // resolveDispute(true) — payer refunded the amount, challenger awarded both bonds.
  | "refunded" // V3 reclaimAfterDeadline — amount returned to the payer; bond disposition unknown from here.
  | "disputed"; // fileDispute has run; the arbiter has not yet resolved it.

export interface MilestoneRecipientProjection {
  recipient: Address;
  /** "fee" appears first (matching the contract's transfer order) only when the computed
   *  fee amount is above 0 AND the recipient is known — see `fee-recipient-set`. The three
   *  dispute/refund-outcome roles appear ONLY for their matching `outcome` (never mixed
   *  with "fee"/"split"/"operator-residual" — see `MilestoneOutcome`). */
  role: "fee" | "split" | "operator-residual" | "operator-dispute-award" | "payer-refund" | "challenger-award";
  /** Computed exactly like the contract actually paid or will pay for this row's `outcome`.
   *  For "pending"/"released": fee on the gross (V2: whenever a root is set, unconditionally;
   *  V3: only when bps > 0 AND the recipient is non-zero — see `readMilestoneRecipients`'s
   *  `grossFee`), truncated per-leg shares in on-chain map order, integer dust folded into
   *  the operator's residual. `sum(amount)` over every row equals `amount + operatorBond`
   *  whenever the fee is fully routed (a "fee" row present, or no fee at all) — it falls
   *  short by the fee only in the one state `fee-recipient-set` flags: a fee amount with
   *  nowhere valid to send it. For "released-by-dispute"/"slashed", `sum(amount)` always
   *  equals `amount + operatorBond + challengerBond` — see `MilestoneOutcome`'s table. */
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
  /** `status !== Unfunded || payoutMapSet` — once EITHER holds, the recipient set can never
   *  change again: funding freezes the legacy (no-map) shape, and `setPayoutMap` is
   *  single-shot (onlyPayer + requires Unfunded) the moment it has succeeded even once,
   *  with zero legs or many — an Unfunded milestone can still have a map SET on it. */
  recipientsFinal?: boolean;
  fee?: MilestoneRecipientFee;
  /** In on-chain map order: each split leg, then always one operator-residual leg last
   *  (residualBps is 10000 on the legacy path, where there are no split legs at all).
   *  Reported regardless of `outcome` — this is "what was configured", not "what pays". */
  legs?: MilestoneRecipientLeg[];
  /** Which lifecycle path this milestone is actually on (or will be, conditionally) — see
   *  `MilestoneOutcome`. Populated whenever `milestone-read` AND `dispute-read` both pass. */
  outcome?: MilestoneOutcome;
  /** "conditional": `projected` only happens if `release()` runs (outcome "pending").
   *  "actual": `projected` already happened, or is this milestone's only remaining possible
   *  settlement (outcome "released"/"released-by-dispute"/"slashed"), with every input final.
   *  "estimated": outcome "released" with a NON-final fee, which means V2 with a protocol root,
   *  whose rate is mutable and read at THIS block. The release used the rate at its own block,
   *  so the amounts are exact only if the rate has not changed since. Pin `blockNumber` to the
   *  release block for exact amounts. Omitted entirely for "refunded"/"disputed", where
   *  `projected` is also omitted — see `MilestoneOutcome`. */
  projectionBasis?: "conditional" | "actual" | "estimated";
  /** Omitted for outcome "refunded"/"disputed" (no projection applies — see `outcome`'s
   *  doc); omitted for "pending"/"released" specifically when `fee.bps === null` (V3,
   *  not yet attested — see `fee-known`). Otherwise always present. */
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
  // Present on both versions — `submitAttestation` writes the EAS UID here. The one true
  // signal of "has this milestone actually been attested", independent of status ordering.
  verifierAttestationUid: Hex;
  // V3 only; absent (undefined) when decoded against the V2 ABI.
  attestedFeeBps?: number;
  attestedFeeRecipient?: Address;
};

/** Positional — `disputes(uint256)`'s multiple named outputs decode as a plain array. */
type DisputeTuple = readonly [
  challenger: Address,
  challengerBond: bigint,
  challengerEvidenceHash: Hex,
  reason: string,
  resolved: boolean,
  challengerWon: boolean,
];

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

  // 0a. Normalize/checksum the caller's escrow string INSIDE a check (R2-L2) — `getAddress`
  //     throws on anything malformed, and this must never throw out of the function, not
  //     even for a bad input, before any I/O at all.
  let escrow: Address;
  try {
    escrow = getAddress(params.escrow);
  } catch (e) {
    record("escrow-address", false, `invalid escrow address ${JSON.stringify(params.escrow)}: ${errMsg(e)}`);
    return {
      ok: okOf(),
      blockNumber: null,
      blockHash: null,
      chainId: null,
      escrow: params.escrow as Address,
      version,
      milestoneIndex,
      checks,
    };
  }
  record("escrow-address", true, `normalized to ${escrow}`);

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
      // R2-M1a fix: attestation presence comes from the REAL EAS-UID field
      // `submitAttestation` writes (`MilestoneEscrowV3.sol`, `submitAttestation`, ~line 783:
      // `m.verifierAttestationUid = easUid;`), never from the status enum's numeric
      // ordering. Disputed(6)/Refunded(7)/Slashed(8) are all numerically >= Attested(4) and
      // all REACHABLE without ever attesting (Refunded via `reclaimAfterDeadline` from
      // Funded/Locked/Evidenced; Disputed/Slashed only reachable from Attested, so those two
      // in practice do carry a real attestation — but this never assumes that, it reads it).
      const attested = m.verifierAttestationUid !== zeroHash;
      if (attested) {
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
  const StatusEnum = version === "v2" ? MilestoneStatusV2 : MilestoneStatusV3;
  // R2-L1 fix: EITHER holds. `setPayoutMap` is single-shot (onlyPayer + requires Unfunded —
  // V2 :688, V3 :590), so once it has succeeded even once (any number of legs, including
  // zero), another call reverts — the recipient set is frozen from that moment on, even
  // while the milestone is still Unfunded.
  const recipientsFinal = status !== StatusEnum.Unfunded || payoutMapSetFlag;

  // 3b. dispute-read: the public `disputes(idx)` getter, decoded positionally (see
  //     `DisputeTuple`), plus `payer()` when (and only when) the outcome needs it
  //     (Slashed). Always attempted, regardless of status — cheap, and uniform beats
  //     conditional here. A failure blocks ONLY outcome/projected/projectionBasis below;
  //     everything already read (fee, legs, status, ...) is still returned.
  let disputeChallenger: Address;
  let disputeChallengerBond: bigint;
  let disputeResolved: boolean;
  let disputeChallengerWon: boolean;
  let payerAddr: Address | undefined;
  try {
    const d = await read<DisputeTuple>(escrow, [...escrowAbi, ...DISPUTE_LOCAL_ABI] as Abi, "disputes", [milestoneIndex]);
    disputeChallenger = getAddress(d[0]);
    disputeChallengerBond = d[1];
    disputeResolved = d[4];
    disputeChallengerWon = d[5];
    if (status === StatusEnum.Slashed) {
      payerAddr = getAddress(await read<Address>(escrow, escrowAbi, "payer"));
    }
  } catch (e) {
    record("dispute-read", false, `could not read the dispute record: ${errMsg(e)}`);
    // `legs` isn't computed yet at this point (it needs the map-bounds pass below) and
    // `outcome`/`projected`/`projectionBasis` need the dispute record itself — omitted,
    // honestly, rather than guessed. Everything already read is still returned.
    return finish(blockNumber, blockHash, { status, statusName, token, amount, operatorBond, recipientsFinal, fee });
  }
  record("dispute-read", true, `resolved=${disputeResolved}; challengerWon=${disputeChallengerWon}`);

  // Which lifecycle path this milestone is actually on — see `MilestoneOutcome`'s doc.
  // Disputed/Refunded/Slashed are checked before Released: once reached they are terminal
  // (V2 cannot reach Refunded at all — no function ever sets it — but is handled the same
  // way defensively, per the brief, since the numeric check costs nothing extra).
  const outcome: MilestoneOutcome =
    status === StatusEnum.Refunded
      ? "refunded"
      : status === StatusEnum.Slashed
        ? "slashed"
        : status === StatusEnum.Disputed
          ? "disputed"
          : status === StatusEnum.Released
            ? disputeResolved && !disputeChallengerWon
              ? "released-by-dispute"
              : "released"
            : "pending"; // Unfunded, Funded, Locked, Evidenced, Attested

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
    // R2-M2 fix: no single leg may exceed MAX_SINGLE_BPS (5000 = 50%) — both contracts
    // enforce this in setPayoutMap (V2 :697, V3 :599); re-checked here from the read.
    if (p.bps > MAX_SINGLE_BPS) boundsProblems.push(`leg ${p.recipient} has bps (${p.bps}) above MAX_SINGLE_BPS (${MAX_SINGLE_BPS})`);
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
  //    before attestation is a fact, not a failure, so it never flips `ok` to false. For
  //    "released-by-dispute"/"slashed", the fee reading above is still a true fact about
  //    chain state, but BOTH the fee AND the map are irrelevant to what actually settled
  //    this milestone (M1) — say so here, rather than changing `.fee`/`.legs` themselves.
  //    "refunded" carries its own note: the bond's return depends on the status BEFORE the
  //    refund, which current state no longer shows.
  const feeNote =
    outcome === "released-by-dispute" || outcome === "slashed"
      ? ` — the fee and the map do not apply: outcome is "${outcome}"`
      : outcome === "refunded"
        ? ` — does not apply: outcome is "refunded" (the operator bond's return also depends on the status BEFORE the refund, which current state no longer shows)`
        : outcome === "disputed"
          ? ` — does not apply yet: outcome is "disputed", pending the arbiter`
          : "";
  record(
    "fee-known",
    fee.bps !== null,
    (fee.bps !== null ? `${fee.bps} bps from ${fee.source}` : "not yet known (V3, not yet attested)") + feeNote,
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

  // 8. projected + projectionBasis: gated on `outcome` (M1) — NEVER the ordinary
  //    fee+split math by default. See `MilestoneOutcome`'s doc for the full table.
  let projected: MilestoneRecipientProjection[] | undefined;
  let projectionBasis: "conditional" | "actual" | "estimated" | undefined;

  if (outcome === "pending" || outcome === "released") {
    projectionBasis = outcome === "pending" ? "conditional" : fee.final ? "actual" : "estimated";
    // Ordinary release() math — only when the fee is known. Same order, same truncation,
    // dust to the operator, exactly as _distributeLegacy/_distributeWithMap compute it.
    // Covers every payee, including the fee: a "fee" row comes FIRST (matching the
    // contract's transfer order) exactly when grossFee is above 0 and the recipient is
    // known — the one case it is omitted despite grossFee > 0 is `fee-recipient-set`'s
    // stuck state (V2, a root fee with no valid recipient), where `sum(amount)` over the
    // rows below falls short of `amount + operatorBond` by exactly that stuck fee; every
    // other state (no fee at all, or a fully-routed one) sums to amount + operatorBond.
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
  } else if (outcome === "released-by-dispute") {
    // resolveDispute(false) (V2 MilestoneEscrowV2.sol:1146-1151, V3 :995-999): the operator
    // takes the ENTIRE amount + both bonds, bypassing fee and map entirely.
    projectionBasis = "actual";
    projected = [
      { recipient: operator, role: "operator-dispute-award", amount: amount + operatorBond + disputeChallengerBond },
    ];
  } else if (outcome === "slashed") {
    // resolveDispute(true) (V2 :1140-1144, V3 :989-993): the payer is refunded the amount;
    // the challenger is awarded their own bond PLUS the slashed operator bond. Transfer
    // order matches the contract (payer first).
    projectionBasis = "actual";
    projected = [
      { recipient: payerAddr!, role: "payer-refund", amount },
      { recipient: disputeChallenger, role: "challenger-award", amount: disputeChallengerBond + operatorBond },
    ];
  }
  // "refunded" / "disputed": projected and projectionBasis both stay undefined — see
  // `MilestoneOutcome`'s doc (no projection applies; the refunded bond disposition is
  // noted in the fee-known check's detail above instead of guessed here).

  return finish(blockNumber, blockHash, {
    status,
    statusName,
    token,
    amount,
    operatorBond,
    recipientsFinal,
    fee,
    legs,
    outcome,
    projectionBasis,
    projected,
  });
}
