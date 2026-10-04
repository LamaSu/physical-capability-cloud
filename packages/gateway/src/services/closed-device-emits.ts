/**
 * Stored emitter declarations are served and preserved only in the closed grammar (N128 r2, finding 2).
 *
 * A device row written before N128 may hold declarations the open grammar accepted: an unknown param key,
 * a free-text bind or via. Setup validated only what a caller sent, so a re-registration without `emits`
 * preserved such a row and returned it, and GET /api/devices/:kernelId served it.
 *
 * `closeStoredDeviceEmits` wraps the kernels repository's device readers and writers once, when the store
 * is initialised, so EVERY device row the gateway reads or writes back passes through `withClosedEmits`.
 * Its `emits` are re-parsed with spec's EmitterDeclsSchema (a descriptor-only copy, then each declaration
 * closed). A stored list that doesn't parse is withheld WHOLE (null), never served, preserved or used. A
 * partly valid list is not trimmed: that would change what the device declared.
 *
 * The stored value itself is not migrated here. Setup's preserve path (`existing.emits`) now reads null for
 * it, so nothing re-serves it; a later registration that sends `emits` replaces it.
 */

import { EmitterDeclsSchema, type EmitterDecl } from "@pcc/spec";

/** A stored `emits` value in the closed grammar, or null when it is absent or doesn't parse. */
export function closedStoredEmits(stored: unknown): EmitterDecl[] | null {
  if (stored === null || stored === undefined) return null;
  const parsed = EmitterDeclsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** `row` with its `emits` closed (see closedStoredEmits). A value without its own `emits` field is returned as is. */
export function withClosedEmits<T>(row: T): T {
  if (typeof row !== "object" || row === null || !Object.prototype.hasOwnProperty.call(row, "emits")) return row;
  return { ...row, emits: closedStoredEmits((row as { emits?: unknown }).emits) };
}

/** `result` closed by `close`, awaiting it first when a repository answers with a promise. */
function closeResult(result: unknown, close: (value: unknown) => unknown): unknown {
  return result instanceof Promise ? result.then(close) : close(result);
}

const closeRows = (rows: unknown): unknown => (Array.isArray(rows) ? rows.map(withClosedEmits) : rows);

/** The kernels repository methods that return device rows. */
const DEVICE_ROW_METHODS = ["findDeviceById", "insertDevice", "updateDevice"] as const;
const DEVICE_LIST_METHODS = ["findDevicesByKernel", "findDevicesByAdapter"] as const;

/**
 * Route every device row `kernels` returns through withClosedEmits. Call once, on the store's own
 * repository instance, before anything else holds it. A method the instance lacks is left alone.
 */
export function closeStoredDeviceEmits(kernels: object): void {
  const repo = kernels as Record<string, unknown>;
  for (const name of DEVICE_ROW_METHODS) {
    const original = repo[name];
    if (typeof original !== "function") continue;
    const bound = (original as (...args: unknown[]) => unknown).bind(kernels);
    Object.defineProperty(kernels, name, {
      value: (...args: unknown[]) => closeResult(bound(...args), withClosedEmits),
      configurable: true,
      writable: true,
    });
  }
  for (const name of DEVICE_LIST_METHODS) {
    const original = repo[name];
    if (typeof original !== "function") continue;
    const bound = (original as (...args: unknown[]) => unknown).bind(kernels);
    Object.defineProperty(kernels, name, {
      value: (...args: unknown[]) => closeResult(bound(...args), closeRows),
      configurable: true,
      writable: true,
    });
  }
}
