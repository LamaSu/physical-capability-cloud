/**
 * On-chain source: Phase 2 stub.
 *
 * When `BridgeDirectory.sol` deploys (see spec §5), this module reads it
 * via viem and returns the same `BridgeDirectory` shape that JSON returns.
 * Until then, `fetchOnchainDirectory` throws a clear "not implemented"
 * error so consumers can gate cleanly.
 *
 * Why a stub now: it locks the public API. Phase 2 changes only the
 * internals of this file; `getBridgeDirectory()` callers don't change.
 */

import type { BridgeDirectory, GetDirectoryOptions } from "./types.js";

/** Error thrown by Phase 1 builds when onchain mode is requested.
 * Distinct error class so consumers can branch on `instanceof`. */
export class OnchainNotImplementedError extends Error {
  constructor(message?: string) {
    super(message ?? "bridge-directory: onchain source not implemented (Phase 2)");
    this.name = "OnchainNotImplementedError";
  }
}

/**
 * Read the bridge directory from `BridgeDirectory.sol` on the requested
 * chain. Phase 2 implementation will:
 *
 *   1. Construct a viem `PublicClient` for `options.chainId`.
 *   2. Call `listNamespaces()` on the contract.
 *   3. For each namespace, call `getBridge(namespace)`.
 *   4. For each entry, optionally fetch `getRegistry(namespace, chainId)`
 *      and `getExtension(namespace, key)` for known extension keys.
 *   5. Read `directoryVersion()` for the envelope.
 *   6. Assemble + return the `BridgeDirectory`.
 *
 * For Phase 1, throws `OnchainNotImplementedError`.
 */
export async function fetchOnchainDirectory(
  _options: Pick<
    GetDirectoryOptions,
    "chainId" | "directoryAddress"
  > = {},
): Promise<BridgeDirectory> {
  throw new OnchainNotImplementedError(
    "bridge-directory: onchain source not yet implemented — " +
      "BridgeDirectory.sol not deployed (Phase 2). " +
      "Use { source: 'json' } or omit source for default JSON behavior.",
  );
}
