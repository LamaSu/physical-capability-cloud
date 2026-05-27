/**
 * did:ens resolver — ENS-name-based DIDs.
 *
 * Format: did:ens:[<chain>:]<ens-name>
 *   e.g. did:ens:vitalik.eth
 *   e.g. did:ens:base:hamilton.base.eth   (Base ENS / Basenames)
 *
 * The resolver looks up the ENS name on the appropriate L1 / L2 chain and
 * returns a DIDDocument where the controller is the resolved address
 * (effectively folding back to a did:pkh-style document).
 *
 * Spec (draft): https://github.com/uport-project/ethr-did-resolver / community drafts.
 * This implementation follows the simplest workable semantics: ENS name -> address ->
 * synthesize a DIDDocument with the address as the controller.
 *
 * NOTE: This is a stretch-goal implementation. It is intentionally minimal:
 *  - Uses viem's normalize() + getEnsAddress / getEnsResolver where available
 *  - Falls back to throwing a clear "not supported" error if RPC unreachable
 *  - Does NOT yet resolve ENS text records into service endpoints
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet, base } from "viem/chains";
import { normalize } from "viem/ens";
import { parseDID } from "../did.js";
import { resolvePKH } from "./pkh.js";
import {
  DIDResolutionError,
  type DIDDocument,
  type ParsedDID,
  type ResolverOptions,
} from "../types.js";

/**
 * Resolve a did:ens DID to a DIDDocument by looking up the underlying address.
 */
export async function resolveENS(parsed: ParsedDID, options: ResolverOptions = {}): Promise<DIDDocument> {
  if (parsed.method !== "ens") {
    throw new DIDResolutionError(`Expected did:ens, got did:${parsed.method}`, parsed.did, "methodNotSupported");
  }

  const { chain, name } = parseENSIdentifier(parsed.methodSpecificId, parsed.did);
  const normalizedName = safeNormalize(name, parsed.did);

  const client = makePublicClient(chain, options);

  let address: `0x${string}` | null;
  try {
    address = await client.getEnsAddress({ name: normalizedName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DIDResolutionError(
      `did:ens lookup for "${normalizedName}" failed: ${message}`,
      parsed.did,
      "networkError",
    );
  }

  if (!address) {
    throw new DIDResolutionError(
      `did:ens name "${normalizedName}" does not resolve to an address on ${chain}`,
      parsed.did,
      "notFound",
    );
  }

  const chainId = chain === "mainnet" ? "1" : "8453";

  // Synthesize a did:pkh-style document for the resolved address.
  const pkhDid = `did:pkh:eip155:${chainId}:${address}`;
  const inner = await resolvePKH(
    { method: "pkh", methodSpecificId: `eip155:${chainId}:${address}`, did: pkhDid },
    options,
  );

  // Override id with the did:ens, but keep the verification methods.
  return {
    ...inner,
    id: parsed.did,
    alsoKnownAs: [pkhDid],
    controller: pkhDid,
  };
}

interface ParsedENS {
  chain: "mainnet" | "base";
  name: string;
}

function parseENSIdentifier(methodSpecificId: string, did: string): ParsedENS {
  // Possible forms:
  //   <name>            -> mainnet
  //   base:<name>       -> base
  //   mainnet:<name>    -> mainnet (explicit)
  const parts = methodSpecificId.split(":");
  if (parts.length === 1) {
    return { chain: "mainnet", name: parts[0]! };
  }
  if (parts.length === 2) {
    const [chainTag, name] = parts as [string, string];
    if (chainTag === "base") return { chain: "base", name };
    if (chainTag === "mainnet" || chainTag === "eth") return { chain: "mainnet", name };
    throw new DIDResolutionError(
      `did:ens chain tag "${chainTag}" not supported (expected: mainnet, eth, base)`,
      did,
      "methodNotSupported",
    );
  }
  throw new DIDResolutionError(
    `did:ens method-specific-id has too many segments: "${methodSpecificId}"`,
    did,
    "invalidDid",
  );
}

function safeNormalize(name: string, did: string): string {
  try {
    return normalize(name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DIDResolutionError(`did:ens name "${name}" failed normalization: ${message}`, did, "invalidDid");
  }
}

function makePublicClient(chain: "mainnet" | "base", options: ResolverOptions): PublicClient {
  // Cast to PublicClient — Base and mainnet PublicClient types are structurally
  // incompatible due to Base's `deposit` transaction type, but the ENS surface
  // we use (getEnsAddress) is the same.
  if (chain === "mainnet") {
    const rpc = options.ensRpcUrl ?? "https://cloudflare-eth.com";
    return createPublicClient({ chain: mainnet, transport: http(rpc) }) as unknown as PublicClient;
  }
  const rpc = options.baseRpcUrl ?? "https://mainnet.base.org";
  return createPublicClient({ chain: base, transport: http(rpc) }) as unknown as PublicClient;
}
