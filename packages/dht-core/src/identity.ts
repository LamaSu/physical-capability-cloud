/**
 * Identity primitives shared by all DHT modes.
 *
 * Wraps PeerIdentity / PeerEndpoint from @pcc/spec with small helpers
 * for canonicalisation, key formatting, and peer-id derivation. No
 * crypto is performed here — signing lives in @pcc/a2a, used by domain
 * modules (`packages/dht`, `packages/federation`).
 *
 * Why a shared module: both the existing gossip DHT (`packages/dht`) and
 * the Phase 1 federation runtime (`packages/federation`) need to read /
 * write PeerIdentity objects, derive peer IDs from public keys, and
 * compare endpoints. Extracting this avoids two copies drifting.
 */

import type { PeerIdentity, PeerEndpoint, TransportType } from "@pcc/spec";

// Re-export for convenience so dependants only need @pcc/dht-core
export type { PeerIdentity, PeerEndpoint, TransportType };

/**
 * Build a PeerIdentity from raw inputs. Convenience constructor that
 * sets sane defaults and normalises field order so callers don't depend
 * on object-literal ordering for tests.
 */
export function createPeerIdentity(opts: {
  did: string;
  publicKey: string;
  endpoints?: PeerEndpoint[];
  kernelId?: string;
  agentId?: string;
}): PeerIdentity {
  return {
    did: opts.did,
    publicKey: opts.publicKey,
    kernelId: opts.kernelId,
    agentId: opts.agentId,
    endpoints: opts.endpoints ?? [],
  };
}

/**
 * Derive a short peer-id string from a DID. Used in transport-layer
 * peer-tracking maps where the full DID is awkward as a key.
 *
 * For `did:pcc:agent:abc123` returns the last segment `abc123`. For
 * unparseable DIDs returns the entire input (callers should be tolerant
 * — DIDs from external networks may not follow our convention).
 */
export function peerIdFromDid(did: string): string {
  const parts = did.split(":");
  return parts.length > 0 ? parts[parts.length - 1]! : did;
}

/**
 * Compare two PeerEndpoint arrays for equality, ignoring order.
 * Returns true iff the two sets contain the same (transport, url, priority)
 * triples.
 */
export function endpointsEqual(
  a: PeerEndpoint[],
  b: PeerEndpoint[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (e: PeerEndpoint): string =>
    `${e.transport}|${e.url}|${e.priority}`;
  const seen = new Set(a.map(key));
  for (const e of b) {
    if (!seen.has(key(e))) return false;
  }
  return true;
}

/**
 * Sort endpoints by priority (asc), with stable secondary sort on URL
 * so the result is fully deterministic regardless of input ordering.
 * Lower priority value = preferred.
 */
export function sortedEndpoints(endpoints: PeerEndpoint[]): PeerEndpoint[] {
  return [...endpoints].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.url.localeCompare(b.url);
  });
}

/**
 * Pick the preferred endpoint for a given transport. Returns undefined
 * if no endpoint of that transport exists.
 */
export function preferredEndpoint(
  identity: PeerIdentity,
  transport: TransportType,
): PeerEndpoint | undefined {
  return sortedEndpoints(
    identity.endpoints.filter((e) => e.transport === transport),
  )[0];
}

/**
 * Canonical JSON of a PeerIdentity for hashing / signing purposes.
 *
 * Fields ordered alphabetically; endpoints sorted with `sortedEndpoints`.
 * Mirrors @pcc/a2a's signAnnouncement canonicalisation pattern so the
 * shape stays stable when the federation runtime hashes peer identities
 * for the Kademlia routing-table key.
 */
export function canonicalIdentityJson(identity: PeerIdentity): string {
  const canonical = {
    agentId: identity.agentId ?? null,
    did: identity.did,
    endpoints: sortedEndpoints(identity.endpoints),
    kernelId: identity.kernelId ?? null,
    publicKey: identity.publicKey,
  };
  return JSON.stringify(canonical);
}
