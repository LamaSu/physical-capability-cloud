/**
 * Auto source: prefer on-chain, fall back to JSON.
 *
 * Phase 1: on-chain always throws (stub), so this always falls back to
 * JSON. The behavior is correct — consumers can write
 * `getBridgeDirectory({ source: "auto" })` today and pick up the on-chain
 * upgrade automatically when `BridgeDirectory.sol` ships.
 */

import type { BridgeDirectory, GetDirectoryOptions } from "./types.js";
import { fetchJsonDirectory } from "./json-source.js";
import {
  fetchOnchainDirectory,
  OnchainNotImplementedError,
} from "./onchain-source.js";

export async function fetchAutoDirectory(
  options: GetDirectoryOptions = {},
): Promise<BridgeDirectory> {
  // Try on-chain first. If it's the Phase 1 stub or any other failure,
  // fall back to JSON. We swallow OnchainNotImplementedError silently
  // because it's the expected state during Phase 1; everything else is
  // surfaced as a warning on the eventual fallback failure (e.g., to
  // help debug RPC outages during Phase 2 ops).
  try {
    return await fetchOnchainDirectory({
      chainId: options.chainId,
      directoryAddress: options.directoryAddress,
    });
  } catch (e) {
    if (e instanceof OnchainNotImplementedError) {
      // Expected during Phase 1 — fall through silently.
    } else {
      // Phase 2 RPC error: log so operators see it.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `bridge-directory: onchain read failed, falling back to JSON — ${msg}`,
      );
    }
  }

  return fetchJsonDirectory({
    jsonUrl: options.jsonUrl,
    fetchImpl: options.fetchImpl,
  });
}
