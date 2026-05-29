/**
 * CID handoff — content-addressable adapter for Storacha / IPFS.
 *
 * See design §5.6.
 *
 * The actual CID generation + pinning is injected (pin/fetch fns). v0.1
 * ships with a pure-TS helper `makeSha256CidHandoff()` for tests — it
 * generates a deterministic `sha256:<hex>` pseudo-CID and stores values in a
 * Map. Production consumers (gateway, etc.) inject storacha's w3up-client
 * via the `pin`/`fetch` function options.
 *
 * The `toDataLocation()` helper returns a shape ready for DataLocationStore
 * registration; the caller performs the actual insert.
 */

import type { DataLocation } from '../shared/types.js';
import { sha256Hex } from '../shared/hash.js';
import { canonicalJSON, type JsonLike } from '../shared/canonical-json.js';
import type { Store, DataLocationRegisterArgs } from '../store/types.js';

export interface CidHandoff<T> {
  pin(value: T): Promise<string>;
  fetch(cid: string): Promise<T>;
  toDataLocation(
    cid: string,
    portId: string,
    runId?: string,
  ): Promise<Omit<DataLocationRegisterArgs, 'dataType' | 'scheme'>>;
}

export interface CreateCidHandoffOptions<T> {
  pin: (value: T) => Promise<string>;
  fetch: (cid: string) => Promise<T>;
  store: Store;
  /** Kernel id to record when staging the DataLocation. Default 'storacha'. */
  kernelId?: string;
  /** Scheme — 'storacha' or 'ipfs'. Default 'storacha'. */
  scheme?: 'storacha' | 'ipfs';
}

class CidHandoffImpl<T> implements CidHandoff<T> {
  constructor(private readonly opts: CreateCidHandoffOptions<T>) {}

  async pin(value: T): Promise<string> {
    return this.opts.pin(value);
  }

  async fetch(cid: string): Promise<T> {
    return this.opts.fetch(cid);
  }

  async toDataLocation(
    cid: string,
    portId: string,
    runId?: string,
  ): Promise<Omit<DataLocationRegisterArgs, 'dataType' | 'scheme'>> {
    return {
      portId,
      kernelId: this.opts.kernelId ?? 'storacha',
      path: cid,
      available: true,
      ...(runId !== undefined ? { runId } : {}),
    };
  }
}

export function createCidHandoff<T>(opts: CreateCidHandoffOptions<T>): CidHandoff<T> {
  return new CidHandoffImpl<T>(opts);
}

/**
 * Convenience: a test-only CidHandoff that computes deterministic
 * `sha256:<hex>` pseudo-CIDs from the canonical JSON form of the value.
 *
 * Useful in tests + the example in §8 — production code injects real
 * Storacha adapters via createCidHandoff().
 */
export function makeSha256CidHandoff<T extends JsonLike>(store: Store): CidHandoff<T> {
  const storage = new Map<string, T>();
  return createCidHandoff<T>({
    store,
    async pin(value) {
      const cid = 'sha256:' + sha256Hex(canonicalJSON(value));
      storage.set(cid, value);
      return cid;
    },
    async fetch(cid) {
      const v = storage.get(cid);
      if (v === undefined) throw new Error(`CID not found: ${cid}`);
      return v;
    },
  });
}
