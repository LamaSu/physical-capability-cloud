/**
 * Public source-mode dispatcher + lookup helpers.
 *
 * `getBridgeDirectory()` is the single entry point consumers should use.
 * It transparently chooses between JSON, on-chain, and auto fallback.
 */

import type {
  BridgeDirectory,
  BridgeEntry,
  BridgeStatus,
  GetDirectoryOptions,
} from "./types.js";
import { fetchJsonDirectory } from "./json-source.js";
import { fetchOnchainDirectory } from "./onchain-source.js";
import { fetchAutoDirectory } from "./auto-source.js";

/**
 * Fetch the bridge directory. Default source is "json" (Phase 1).
 *
 * @example
 *   const directory = await getBridgeDirectory();
 *   const hamilton  = lookupBridge(directory, "hamilton");
 *
 * @example (Phase 2, when contract ships)
 *   const directory = await getBridgeDirectory({
 *     source: "auto",
 *     chainId: 8453,
 *     directoryAddress: "0x...",
 *   });
 */
export async function getBridgeDirectory(
  options: GetDirectoryOptions = {},
): Promise<BridgeDirectory> {
  const mode = options.source ?? "json";

  switch (mode) {
    case "json":
      return fetchJsonDirectory({
        jsonUrl: options.jsonUrl,
        fetchImpl: options.fetchImpl,
      });
    case "onchain":
      return fetchOnchainDirectory({
        chainId: options.chainId,
        directoryAddress: options.directoryAddress,
      });
    case "auto":
      return fetchAutoDirectory(options);
    default: {
      // Exhaustiveness check — TS will error here if a new SourceMode
      // is added and not handled.
      const _exhaustive: never = mode;
      throw new Error(
        `bridge-directory: unknown source mode ${String(_exhaustive)}`,
      );
    }
  }
}

/** Look up a bridge by namespace. Returns null if not found.
 * O(n) but n is bounded at 500 — fine for occasional lookups; consumers
 * that need many lookups should build their own Map. */
export function lookupBridge(
  directory: BridgeDirectory,
  namespace: string,
): BridgeEntry | null {
  for (const b of directory.bridges) {
    if (b.namespace === namespace) return b;
  }
  return null;
}

/** Subset by lifecycle status. */
export function filterByStatus(
  directory: BridgeDirectory,
  status: BridgeStatus,
): BridgeEntry[] {
  return directory.bridges.filter((b) => b.status === status);
}

/** Subset by capability type. Returns bridges whose capabilityTypes array
 * (when present) includes the requested type. Bridges without declared
 * capabilityTypes are excluded — they advertise capabilities dynamically
 * at runtime. */
export function filterByCapabilityType(
  directory: BridgeDirectory,
  capabilityType: string,
): BridgeEntry[] {
  return directory.bridges.filter((b) =>
    Array.isArray(b.capabilityTypes)
      ? b.capabilityTypes.includes(capabilityType)
      : false,
  );
}
