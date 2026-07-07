/**
 * Shared helper for batch (IN-list) finders.
 *
 * SQLite caps bound parameters per statement (999 on older builds), so batch
 * finders chunk their id lists and concatenate the results. One query per
 * chunk — for typical page-sized inputs that is exactly one query, which is
 * the point of the batch APIs (the previous "batch" helpers issued one query
 * PER id).
 */

export const BATCH_CHUNK_SIZE = 500;

/** Run `query` once per ≤BATCH_CHUNK_SIZE slice of `ids`, concatenating results. */
export function inChunks<T>(ids: string[], query: (chunk: string[]) => T[]): T[] {
  if (ids.length === 0) return [];
  if (ids.length <= BATCH_CHUNK_SIZE) return query(ids);
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
    out.push(...query(ids.slice(i, i + BATCH_CHUNK_SIZE)));
  }
  return out;
}
