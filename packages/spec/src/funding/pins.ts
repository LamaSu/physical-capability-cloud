/**
 * Per-chain deployment pins for buyer funding. Author: implementer-bravo (pcc-adk).
 *
 * USDC: Circle-issued USDC, the settlement asset V-next pins per chain (DEP-01,
 * packages/contracts/script/vnext/VNextDeploySpec.sol:76-79). A payload naming any other token, MockUSDC included,
 * is refused (plan G12: MockUSDC has a free mint and proves nothing).
 *
 * Factory: NONE is built in. V-next is not deployed anywhere (deployments/vnext/ holds only its README), so a
 * caller must pin the factory it trusts until plan S0.1 commits a deployment record. The pinned factory is the
 * trust anchor: the escrow address, the implementation (`factory.implementation()`, an immutable) and the
 * token (`implementation.USDC()`, an immutable) all hang off it.
 *
 * A caller may add pins for chains without a built-in one (a local anvil, say), never override a built-in one.
 */
import { isAddress, type Address } from "viem";
import { refuse } from "./errors.js";
import { MAX_RECLAIM_DELAY, MIN_RECLAIM_DELAY } from "./vnext.js";

/** Circle USDC by chain id (decimal string). Base mainnet and Base Sepolia, as in VNextDeploySpec.sol. */
export const CIRCLE_USDC: Readonly<Record<string, Address>> = Object.freeze({
  "8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
});

/**
 * Deployment windows copied from packages/contracts/deployments/vnext/base-sepolia/CANONICAL.json;
 * a test pins them to that record. Only chain id selects a window: no caller pin, payload field,
 * environment variable or option can set or widen one.
 */
export type ReclaimWindow = {
  readonly scheduleId: string;
  readonly testnetOnly: boolean;
  readonly minReclaimDelay: bigint;
  readonly maxReclaimDelay: bigint;
};

/**
 * Values copied from packages/contracts/deployments/vnext/base-sepolia/CANONICAL.json and pinned
 * to it by a test. Only chain id selects a window: no caller pin, payload field, environment
 * variable or option can set or widen one.
 */
export const RECLAIM_WINDOWS: Readonly<Record<string, ReclaimWindow>> = Object.freeze({
  "84532": Object.freeze({
    scheduleId: "vnext-testnet-short-v1", testnetOnly: true,
    minReclaimDelay: 4_500n, maxReclaimDelay: 31_536_000n,
  }),
});

/**
 * Select the window copied from packages/contracts/deployments/vnext/base-sepolia/CANONICAL.json,
 * pinned to that record by a test, or the library default. Only chain id selects it: no caller
 * pin, payload field, environment variable or option can set or widen a window.
 */
export function reclaimWindowFor(chainId: bigint): { readonly min: bigint; readonly max: bigint } {
  const key = chainId.toString();
  if (Object.prototype.hasOwnProperty.call(RECLAIM_WINDOWS, key)) {
    const w = RECLAIM_WINDOWS[key]!;
    return Object.freeze({ min: w.minReclaimDelay, max: w.maxReclaimDelay });
  }
  return Object.freeze({ min: MIN_RECLAIM_DELAY, max: MAX_RECLAIM_DELAY });
}

/** Caller pins by chain id (decimal string). */
export type FundingPins = Readonly<Record<string, { readonly usdc?: Address; readonly factory?: Address }>>;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The effective pins for one chain: the built-in USDC (if any) plus the caller's, which may only fill gaps. */
export function resolvePins(chainId: bigint, extra: FundingPins | undefined): { usdc?: Address; factory?: Address } {
  const key = chainId.toString();
  const builtinUsdc = Object.prototype.hasOwnProperty.call(CIRCLE_USDC, key) ? CIRCLE_USDC[key] : undefined;
  const pin = extra !== undefined && Object.prototype.hasOwnProperty.call(extra, key) ? extra[key] : undefined;
  for (const field of ["usdc", "factory"] as const) {
    const v = pin?.[field];
    if (v !== undefined && (typeof v !== "string" || !isAddress(v))) refuse("PIN_INVALID", `pins[${key}].${field} is not an address`);
  }
  if (builtinUsdc !== undefined && pin?.usdc !== undefined && !same(builtinUsdc, pin.usdc)) {
    refuse("PIN_INVALID", `pins[${key}].usdc ${pin.usdc} contradicts the built-in Circle USDC pin ${builtinUsdc}`);
  }
  return { usdc: builtinUsdc ?? pin?.usdc, factory: pin?.factory };
}
