/**
 * Stored emitter declarations are served and preserved only in the closed grammar (N128 r2, finding 2).
 *
 * A device row written before N128 may hold declarations the open grammar accepted: an unknown param key,
 * a free-text bind or via. Setup validated only what a caller sent, so a re-registration without `emits`
 * preserved such a row and returned it, and GET /api/devices/:kernelId served it.
 *
 * `closeStoredDeviceEmits` wraps EVERY method of the kernels repository once, when the store is initialised,
 * so every device row the gateway reads or writes back passes through ONE mapper, `closeDeviceRows`. That is
 * by construction, not by a list of names (N128 r3): a device-returning method added later is closed too, and
 * a test checks every method of the repository class.
 *
 * Each row's `emits` is re-parsed with spec's EmitterDeclsSchema (a descriptor-only copy, then each
 * declaration closed). A stored list that doesn't parse is withheld WHOLE (null), never served, preserved or used. A
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

/** Marks a repository method this module wrapped, so a test can show that none was missed. */
const CLOSED = Symbol("pcc.closedDeviceEmits");

/**
 * The ONE device-row mapper: a repository result with every device row in it closed. That covers a row, a
 * list of rows, or a promise of either. A value without its own `emits` passes unchanged, so the mapper is
 * safe on every method's result (kernel rows carry no `emits`).
 */
export function closeDeviceRows(result: unknown): unknown {
  if (result instanceof Promise) return result.then(closeDeviceRows);
  if (Array.isArray(result)) return result.map(withClosedEmits);
  return withClosedEmits(result);
}

/** Every method a repository instance answers with, own or inherited, except its constructor (data properties only). */
export function repositoryMethodNames(repo: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = repo; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(o, name);
      if (descriptor !== undefined && typeof descriptor.value === "function") names.add(name);
    }
  }
  return [...names];
}

/**
 * Route EVERY method of `kernels` through closeDeviceRows. Call once, on the store's own repository instance,
 * before anything else holds it. Calling again is a no-op.
 */
export function closeStoredDeviceEmits(kernels: object): void {
  for (const name of repositoryMethodNames(kernels)) {
    const original = (kernels as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
    if (isClosedRepositoryMethod(original)) continue;
    const closed = (...args: unknown[]): unknown => closeDeviceRows(original.apply(kernels, args));
    Object.defineProperty(closed, CLOSED, { value: true });
    Object.defineProperty(kernels, name, { value: closed, configurable: true, writable: true });
  }
}

/** Whether `method` is one that closeStoredDeviceEmits wrapped. */
export function isClosedRepositoryMethod(method: unknown): boolean {
  return typeof method === "function" && (method as { [CLOSED]?: unknown })[CLOSED] === true;
}
