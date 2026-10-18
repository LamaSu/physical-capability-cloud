/**
 * Read every funded unit's `UnitConfig` back from a V-next escrow, at ONE pinned block, and PROVE the
 * reconstruction against the same on-chain commitments `fund()` itself enforced (docs/VNEXT_SETTLEMENT_ABI.md
 * §4, §5). VCR's field-equality check (#3450, #3485) and composition's read surface (#4555 item 3) both need
 * the escrow's OWN funded values, not a value computed off-chain and merely assumed to match — this function
 * never returns `ok:true` on an assumption.
 *
 * ONE BLOCK, BY IDENTITY, exactly like `preflightVNextFunding` (./preflight.ts): the block is resolved once
 * (the caller's `blockNumber`, or latest), then EVERY read below is a raw `eth_call`/`eth_getCode` pinned to
 * that block's HASH (EIP-1898, `requireCanonical: true`). A node that cannot serve hash-pinned calls fails
 * this closed, by name, rather than silently answering from a different (possibly reorganized) block. The
 * chain id is read before and after; a mismatch fails closed too. The raw-call plumbing below is COPIED from
 * `preflight.ts`, not imported from it: the two read paths stay independent, so a change here can never alter
 * preflight's own behaviour or its tests (preflight.ts is untouched by this file).
 *
 * RECONSTRUCTION, NOT ASSUMPTION. Every one of `UnitConfig`'s 13 fields is read from a NAMED contract view
 * (mapped by hand from `VNextSettlementEscrow.sol`, listed below), never derived or guessed. The
 * reconstruction is then run through THREE checks that each compare it against a commitment the escrow itself
 * computed and stored at `fund()`:
 *   (1) per unit, this module's own `payoutConfigHash(unitId, payouts)` equals the escrow's
 *       `unitTerms(unitId).payoutConfigHash_` — proves the payout legs, in their on-chain order;
 *   (2) per unit, this module's own `settlementUnitId(...)` equals the `unitId` it was read under — proves
 *       milestoneIndex/stepId derive the same id the escrow derived, under the escrow's own `jobIdHash()`;
 *   (3) for the WHOLE escrow, this module's own `prePolicyRoot(configs)` over every reconstructed config, IN
 *       THE ESCROW'S OWN UNIT ORDER, equals the escrow's `policy().prePolicyRoot_`. `fund()` reverts
 *       `PolicyRootMismatch` unless the configs it received hash to exactly this root, so a match here proves
 *       BYTE-FOR-BYTE that the reconstruction IS the funded config — not merely a plausible-looking one. This
 *       is the actual proof; (1) and (2) are named, localized diagnostics that usually fail first and point at
 *       which unit and which field drifted (a tampered `compositionRoot`, fee field or tier, for instance, is
 *       caught ONLY by (3): neither `payoutConfigHash` nor `settlementUnitId` depends on those fields).
 * `ok` is the AND of every check below. A check that could not even be attempted (a read failed, or an
 * earlier unit in the loop could not be reconstructed) is recorded `false`, never skipped and never silently
 * assumed true: this function does not return `ok:true` on a partial read.
 *
 * FIELD MAP (UnitConfig, 13 fields -> the view that returns it; line numbers in VNextSettlementEscrow.sol):
 *   milestoneIndex, stepId, requestedTier, reclaimAt, compositionSchemaVersion  <- unitTerms(unitId)        :1097
 *   requiredTier                                                               <- requiredTierOf(unitId)   :1125
 *   g, f, n                                                                    <- feeAmountsOf(unitId)     :981
 *   feeBps                                                                     <- feeBpsOf(unitId)         :992
 *   feeRecipient                                                               <- feeRecipientOf(unitId)   :996
 *   compositionRoot                                                            <- compositionRootOf(unitId):1008
 *   payouts (count)                                                            <- unitCounters(unitId)     :1310 (payoutCount_)
 *   payouts (each leg)                                                         <- payoutAt(unitId, 0..count-1) :1319
 * `unitCount()` / `unitIdAt(i)` (:1329, :1333) give the escrow's own unit order — the funding order
 * (compiler.ts's own comment on `VNextCompileInput.units`: "ORDERED: the array order is the funding order").
 * `jobIdHash()` and `policy().prePolicyRoot_` (:903) are the two escrow-level reads checks (2) and (3) need.
 * `requiredTierOf`, `feeBpsOf`, `feeRecipientOf`, `feeAmountsOf`, `compositionRootOf` and `unitCounters` are
 * NOT in the frozen `VNextSettlementEscrowABI` (abi.ts pins THAT ABI's selectors against the golden and forge
 * suites) — they are declared in a small local ABI fragment below, by hand, from the Solidity, so this read
 * path adds nothing to what abi.ts freezes and touches no existing selector.
 *
 * UNFUNDED CLONE. `unitCount()` on a clone that was created but never funded returns 0 — a plain storage
 * read, never a revert — so this never throws for that case: it fails closed on the named
 * "escrow funded (unitCount > 0)" check and, independently, on "prePolicyRoot" (`initialize`
 * (`VNextSettlementEscrow.sol:677`) already writes `_prePolicyRoot` to the off-chain-compiled commitment
 * BEFORE `fund()` ever runs — it is not zero or unwritten pre-funding — so an empty reconstruction's root,
 * over zero units, cannot equal whatever that already-committed value is). A clone with no code at all fails the
 * same two checks the same way: `unitCount()` then throws (empty return data), which is caught, not thrown.
 *
 * No contract change. No write, anywhere. Pure read, then pure proof (compiler.ts is pure; see its header).
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { VNextSettlementEscrowABI } from "./abi.js";
import { payoutConfigHash, prePolicyRoot, settlementUnitId, type PayoutEntry, type UnitConfig } from "./compiler.js";
import { describeRevert } from "./preflight.js";

/**
 * Local to this read path only (see the file header: abi.ts's frozen ABI is untouched). Selectors and return
 * shapes copied by hand from `VNextSettlementEscrow.sol`: `requiredTierOf` :1125, `feeBpsOf` :992,
 * `feeRecipientOf` :996, `feeAmountsOf` :981, `compositionRootOf` :1008, `unitCounters` :1310. `UnitNotFound`
 * (`onlyExisting`, :479/:582) is declared too, so a stale or malformed `unitId` decodes by name.
 */
const UNIT_READ_ABI = parseAbi([
  "function requiredTierOf(bytes32 unitId) view returns (uint8)",
  "function feeBpsOf(bytes32 unitId) view returns (uint16)",
  "function feeRecipientOf(bytes32 unitId) view returns (address)",
  "function feeAmountsOf(bytes32 unitId) view returns (uint256 g_, uint256 f_, uint256 n_)",
  "function compositionRootOf(bytes32 unitId) view returns (bytes32)",
  "function unitCounters(bytes32 unitId) view returns (uint256 liability_, uint256 payoutCount_, uint256 remainingClaimCount_)",
  "error UnitNotFound()",
]);

export interface ReadUnitConfigsCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReadUnitConfigsResult {
  /** True only when every check below passes. Never true on a partial read. */
  ok: boolean;
  chainId: number;
  escrow: Address;
  blockNumber: bigint;
  blockHash: Hex;
  /**
   * In the escrow's own unit order (`unitIdAt(0..unitCount-1)`). Only a unit that was fully, successfully
   * reconstructed appears here — see the `units[i] read` check for one that was not (then `ok` is `false`).
   */
  units: Array<{ unitId: Hex; config: UnitConfig }>;
  /** As the escrow reports it (`policy().prePolicyRoot_`); `zeroHash` if it could not be read. */
  prePolicyRoot: Hex;
  checks: ReadUnitConfigsCheck[];
}

/**
 * Reconstruct every unit's funded `UnitConfig` from a V-next escrow at one pinned block, and prove the
 * reconstruction against the escrow's own `payoutConfigHash`, `unitId` derivation and `prePolicyRoot` (file
 * header). Fails closed: a node that cannot serve EIP-1898, a reverting read, a chain id that changes
 * mid-read, or an unfunded (or nonexistent) clone all return `ok:false` with a named check — never a throw.
 */
export async function readUnitConfigs(p: {
  client: PublicClient;
  escrow: Address;
  /** Pin a specific block. Default: the latest block, read once at the start. */
  blockNumber?: bigint;
}): Promise<ReadUnitConfigsResult> {
  const { client, escrow } = p;
  const checks: ReadUnitConfigsCheck[] = [];
  const record = (name: string, ok: boolean, detail?: string): boolean => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  };

  // The chain id, before anything is pinned (read again at the end; mismatch fails "chain id unchanged").
  // A failure here does NOT stop the read — exactly like preflight.ts, only the pinned block below is load
  // -bearing for every subsequent call. A chain id that could not be read either time fails that check by name.
  let chainIdBefore: number | undefined;
  try {
    chainIdBefore = await client.getChainId();
  } catch {
    chainIdBefore = undefined;
  }

  // 0. the one block everything below runs against, addressed by its hash (copied from preflight.ts's
  //    pattern, not imported, so a change here can never alter preflight's own tests).
  let blockNumber: bigint;
  let blockHash: Hex;
  try {
    const b = p.blockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: p.blockNumber });
    if (b.number === null || b.hash === null) throw new Error("the node returned a pending block, which has no number or hash to pin");
    blockNumber = b.number;
    blockHash = b.hash;
  } catch (e) {
    record("pinned block", false, `could not read the block to pin: ${describeRevert(e)}`);
    return { ok: false, chainId: chainIdBefore ?? 0, escrow, blockNumber: 0n, blockHash: zeroHash, units: [], prePolicyRoot: zeroHash, checks };
  }
  const pin = { blockHash, requireCanonical: true } as const;
  const rpc = (method: "eth_call" | "eth_getCode", params: unknown[]) =>
    client.request({ method, params: [...params, pin] } as never) as Promise<Hex>;
  // A node that cannot serve calls pinned by block hash (EIP-1898) fails closed, exactly like the preflight.
  try {
    await rpc("eth_getCode", [escrow]);
  } catch (e) {
    record(
      "pinned block",
      false,
      `block ${blockNumber} (${blockHash}) could not be addressed by hash (EIP-1898, requireCanonical): ${describeRevert(e)}`,
    );
    return { ok: false, chainId: chainIdBefore ?? 0, escrow, blockNumber, blockHash, units: [], prePolicyRoot: zeroHash, checks };
  }
  record("pinned block", true, `every read ran at block ${blockNumber}, addressed by hash ${blockHash}`);

  const read = async (abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<unknown> => {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const ret = await rpc("eth_call", [{ to: escrow, data }]);
    return decodeFunctionResult({ abi, functionName, data: ret } as never) as unknown;
  };

  // 1. the escrow's own unit order, and whether it is funded at all. Never throws: unitCount() is a plain
  //    storage read (0 for a created-but-unfunded clone), and a read that fails (e.g. no code at `escrow`)
  //    is caught and recorded here instead of propagating.
  let unitCount = 0n;
  let unitCountRead = false;
  try {
    unitCount = (await read(VNextSettlementEscrowABI, "unitCount")) as bigint;
    unitCountRead = true;
    record("escrow funded (unitCount > 0)", unitCount > 0n, `unitCount() = ${unitCount}`);
  } catch (e) {
    record("escrow funded (unitCount > 0)", false, `could not read unitCount(): ${describeRevert(e)}`);
  }

  // 2. the two escrow-level reads checks (2) and (3) need. A failure here does not throw: it is folded into
  //    those checks below as a clear "cannot verify" detail, so `ok` still fails closed, by name.
  let jobIdHashValue: Hex | undefined;
  let jobIdHashError: string | undefined;
  try {
    jobIdHashValue = (await read(VNextSettlementEscrowABI, "jobIdHash")) as Hex;
  } catch (e) {
    jobIdHashError = describeRevert(e);
  }
  let escrowPrePolicyRoot: Hex | undefined;
  let policyError: string | undefined;
  try {
    const [, , prePolicyRoot_] = (await read(VNextSettlementEscrowABI, "policy")) as [Address, bigint, Hex, Hex, Hex];
    escrowPrePolicyRoot = prePolicyRoot_;
  } catch (e) {
    policyError = describeRevert(e);
  }

  // 3. reconstruct each unit, in the escrow's own order, and run checks (1)/(2) as soon as each is built.
  const units: Array<{ unitId: Hex; config: UnitConfig }> = [];
  if (unitCountRead) {
    for (let i = 0n; i < unitCount; i++) {
      try {
        const unitId = (await read(VNextSettlementEscrowABI, "unitIdAt", [i])) as Hex;
        const [milestoneIndex, stepId, requestedTier, reclaimAt, payoutConfigHashValue, compositionSchemaVersion] = (await read(
          VNextSettlementEscrowABI,
          "unitTerms",
          [unitId],
        )) as [bigint, Hex, number, bigint, Hex, number, boolean];
        const requiredTier = (await read(UNIT_READ_ABI, "requiredTierOf", [unitId])) as number;
        const [g, f, n] = (await read(UNIT_READ_ABI, "feeAmountsOf", [unitId])) as [bigint, bigint, bigint];
        const feeBps = (await read(UNIT_READ_ABI, "feeBpsOf", [unitId])) as number;
        const feeRecipient = (await read(UNIT_READ_ABI, "feeRecipientOf", [unitId])) as Address;
        const compositionRoot = (await read(UNIT_READ_ABI, "compositionRootOf", [unitId])) as Hex;
        const [, payoutCount] = (await read(UNIT_READ_ABI, "unitCounters", [unitId])) as [bigint, bigint, bigint];
        const payouts: PayoutEntry[] = [];
        for (let j = 0n; j < payoutCount; j++) {
          const [recipient, amount] = (await read(VNextSettlementEscrowABI, "payoutAt", [unitId, j])) as [Address, bigint];
          payouts.push({ recipient, amount });
        }
        const config: UnitConfig = {
          milestoneIndex,
          stepId,
          requiredTier,
          requestedTier,
          g,
          f,
          n,
          feeBps,
          feeRecipient,
          reclaimAt,
          compositionSchemaVersion,
          compositionRoot,
          payouts,
        };
        units.push({ unitId, config });

        // (1) the payout legs, in their on-chain order, hash to what the escrow froze at fund().
        const computedPayoutConfigHash = payoutConfigHash(unitId, payouts);
        record(
          `units[${i}] payoutConfigHash`,
          computedPayoutConfigHash === payoutConfigHashValue,
          `computed ${computedPayoutConfigHash}; unitTerms().payoutConfigHash_ ${payoutConfigHashValue}`,
        );
        // (2) milestoneIndex/stepId, under the escrow's OWN jobIdHash/chainId/address, derive this unit's id.
        if (jobIdHashValue === undefined) {
          record(`units[${i}] unitId derivation`, false, `cannot derive: jobIdHash() unreadable: ${jobIdHashError}`);
        } else {
          const derived = settlementUnitId({
            chainId: BigInt(chainIdBefore ?? 0),
            escrow,
            jobIdHash: jobIdHashValue,
            milestoneIndex,
            stepId,
          });
          record(`units[${i}] unitId derivation`, derived === unitId, `derived ${derived}; read as ${unitId}`);
        }
      } catch (e) {
        // UNIT_READ_ABI as the extra fragment: a stale/malformed unitId can revert `UnitNotFound` (:87),
        // which is declared there, not in the frozen `VNextSettlementEscrowABI` — without it the detail
        // would name no error at all.
        record(`units[${i}] read`, false, `could not reconstruct unit ${i}: ${describeRevert(e, UNIT_READ_ABI)}`);
      }
    }
  }

  // 4. the whole-escrow proof: every reconstructed config, in order, hashes to the root `fund()` enforced.
  //    Guarded explicitly on every unit having been reconstructed: a partial array is never hashed and
  //    compared as if it were complete (it would almost never match anyway — this says exactly why not).
  if (!unitCountRead || units.length !== Number(unitCount)) {
    record("prePolicyRoot", false, `cannot verify: ${units.length} of ${unitCountRead ? unitCount.toString() : "?"} units were reconstructed`);
  } else if (escrowPrePolicyRoot === undefined) {
    record("prePolicyRoot", false, `cannot verify: policy() unreadable: ${policyError}`);
  } else {
    const computed = prePolicyRoot(units.map((u) => u.config));
    record("prePolicyRoot", computed === escrowPrePolicyRoot, `computed ${computed}; policy().prePolicyRoot_ ${escrowPrePolicyRoot}`);
  }

  // The chain id again: the node must still be on the same chain after every pinned read above.
  let chainIdAfter: number | undefined;
  try {
    chainIdAfter = await client.getChainId();
  } catch {
    chainIdAfter = undefined;
  }
  record(
    "chain id unchanged",
    chainIdBefore !== undefined && chainIdAfter !== undefined && chainIdBefore === chainIdAfter,
    `before ${chainIdBefore ?? "unread"}; after ${chainIdAfter ?? "unread"}`,
  );

  return {
    ok: checks.every((c) => c.ok),
    chainId: chainIdBefore ?? chainIdAfter ?? 0,
    escrow,
    blockNumber,
    blockHash,
    units,
    prePolicyRoot: escrowPrePolicyRoot ?? zeroHash,
    checks,
  };
}
