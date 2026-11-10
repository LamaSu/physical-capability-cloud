/** Unit state and reclaim deadlines, read together at one canonical block hash. */
import { isAddress, type Address, type Hex, type PublicClient } from "viem";
import { describeRevert, pinBlock, pinnedReader, type PinnedBlock } from "./chain.js";
import { FundingRefusal, refuse } from "./errors.js";
import { resolvePins, type FundingPins } from "./pins.js";
import { cloneRuntimeCode, ESCROW_ABI, FACTORY_ABI, MAX_UNITS, UNIT_FUNDED_ACTIVE, UNIT_STATE_NAMES } from "./vnext.js";

export interface UnitsTarget { chainId: bigint; escrow: Address; pins?: FundingPins }
export interface ReadUnitStatesArgs extends UnitsTarget { publicClient: PublicClient; blockHash?: Hex }
export type UnitStateName = (typeof UNIT_STATE_NAMES)[number] | "UNKNOWN";
export interface UnitStateEntry { unitId: Hex; state: number; stateName: UnitStateName; reclaimAt: bigint; reclaimable: boolean }
export type UnitStatesRead =
  | { kind: "read"; escrow: Address; payer: Address; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint; units: readonly UnitStateEntry[] }
  | { kind: "unreadable"; escrow: Address; blockNumber: bigint | null; blockHash: Hex | null; detail: string };

/** Shared synchronous checks: invalid caller expectations never start an RPC. */
export function validateUnitsTarget(args: UnitsTarget & { blockHash?: Hex }): Address {
  if (typeof args.chainId !== "bigint" || args.chainId <= 0n) refuse("BAD_EXPECTATION", "chainId must be a positive bigint");
  if (typeof args.escrow !== "string" || !isAddress(args.escrow)) refuse("BAD_EXPECTATION", "escrow must be an address");
  if (args.blockHash !== undefined && (typeof args.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(args.blockHash))) {
    refuse("BAD_EXPECTATION", "blockHash must be a 32-byte hex string");
  }
  const factory = resolvePins(args.chainId, args.pins).factory;
  if (!factory) refuse("FACTORY_NOT_PINNED", `no factory is pinned for chain ${args.chainId}`);
  return factory;
}

/** RPC failures yield unreadable; malformed expectations and deterministic deployment mismatches refuse. */
export async function readUnitStates(args: ReadUnitStatesArgs): Promise<UnitStatesRead> {
  const factory = validateUnitsTarget(args);
  const { publicClient, escrow, chainId } = args;
  let readChain: number;
  try {
    readChain = await publicClient.getChainId();
  } catch (e) {
    refuse("LIVE_CHECK_FAILED", `could not read the chain id: ${describeRevert(e)}`);
  }
  if (BigInt(readChain) !== chainId) refuse("CHAIN_MISMATCH", `the read client is on chain ${readChain}; the target is for chain ${chainId}`);

  let block: PinnedBlock | undefined;
  try {
    block = await pinBlock(publicClient, args.blockHash);
    const reader = pinnedReader(publicClient, block.hash);
    const code = await reader.code(escrow);
    if (code === "0x") refuse("ESCROW_NOT_CREATED", `no clone at ${escrow}`);
    const implementation = await reader.read<Address>(factory, FACTORY_ABI, "implementation");
    if (code.toLowerCase() !== cloneRuntimeCode(implementation).toLowerCase()) {
      refuse("DEPLOYMENT_MISMATCH", `the code at ${escrow} is not the EIP-1167 clone of the pinned factory's implementation ${implementation}`);
    }
    const payer = await reader.read<Address>(escrow, ESCROW_ABI, "payer");
    const count = await reader.read<bigint>(escrow, ESCROW_ABI, "unitCount");
    if (count > BigInt(MAX_UNITS)) throw new Error(`unitCount ${count} exceeds MAX_UNITS ${MAX_UNITS}`);
    const units: UnitStateEntry[] = [];
    for (let i = 0n; i < count; i++) {
      const unitId = await reader.read<Hex>(escrow, ESCROW_ABI, "unitIdAt", [i]);
      const state = await reader.read<number>(escrow, ESCROW_ABI, "unitState", [unitId]);
      const terms = await reader.read<readonly [bigint, Hex, number, bigint, Hex, number, boolean]>(escrow, ESCROW_ABI, "unitTerms", [unitId]);
      const reclaimAt = terms[3];
      units.push({ unitId, state, stateName: UNIT_STATE_NAMES[state] ?? "UNKNOWN", reclaimAt,
        reclaimable: state === UNIT_FUNDED_ACTIVE && block.timestamp >= reclaimAt });
    }
    return { kind: "read", escrow, payer, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, units };
  } catch (e) {
    if (e instanceof FundingRefusal) throw e;
    return { kind: "unreadable", escrow, blockNumber: block?.number ?? null, blockHash: block?.hash ?? null,
      detail: `could not read unit states: ${describeRevert(e)}` };
  }
}
