/**
 * An in-memory EvidencePhotoStore for /prove tests. `blobs` receives what was
 * placed (CID -> bytes), keyed by the real CIDv1 of the bytes, as the local
 * store would. `pending()` counts photos staged but neither placed nor
 * discarded. `beforeStage` runs at the start of each stage step (e.g. to hold
 * a request there).
 */

import { computeCid } from "../../services/cid-blob-storage.js";
import type { EvidencePhotoStore } from "../../routes/onboard-evidence.js";

export function memoryPhotoStore(
  blobs: Map<string, Uint8Array>,
  opts: { beforeStage?: () => Promise<void> | void } = {},
): EvidencePhotoStore & { pending(): number } {
  let pending = 0;
  return {
    async stage(bytes) {
      await opts.beforeStage?.();
      const cid = computeCid(bytes);
      pending++;
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          pending--;
        }
      };
      return {
        cid,
        commit() {
          settle();
          if (blobs.has(cid)) return false;
          blobs.set(cid, bytes);
          return true;
        },
        discard() {
          settle();
        },
      };
    },
    pending: () => pending,
  };
}
