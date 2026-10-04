/**
 * Test helpers for the key's account record (lib/authorized-fetch.ts,
 * DECISIONS 2026-10-04 05:04): one storage item holds the API key and the
 * account generation it was stored under, written in one write. Tests only;
 * no production module names the slot (__tests__/no-direct-auth-headers).
 */

export const KEY_SLOT = "pcc-api-key";

/** The key the slot's record holds, read as lib/authorized-fetch.ts reads it (a plain string is a key stored before the record). */
export function storedKey(): string | null {
  const raw = localStorage.getItem(KEY_SLOT);
  if (!raw) return null;
  if (!raw.startsWith("{")) return raw;
  try {
    const value = JSON.parse(raw) as { key?: unknown };
    return typeof value.key === "string" && value.key ? value.key : null;
  } catch {
    return null;
  }
}

/** The generation the slot's record holds ("" for a plain key or none). */
export function storedGeneration(): string {
  const raw = localStorage.getItem(KEY_SLOT);
  if (!raw || !raw.startsWith("{")) return "";
  try {
    const value = JSON.parse(raw) as { generation?: unknown };
    return typeof value.generation === "string" ? value.generation : "";
  } catch {
    return "";
  }
}

/** The record a login or logout writes, as the one value stored in the slot. */
export function recordValue(key: string | null, generation: string): string {
  return JSON.stringify({ key, generation });
}

/** Write the slot's record in one write, as another tab's login or logout does, through `setItem` (the real one by default). */
export function storeRecord(key: string | null, generation: string, setItem: Storage["setItem"] = Storage.prototype.setItem): void {
  setItem.call(localStorage, KEY_SLOT, recordValue(key, generation));
}
