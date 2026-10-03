import { fetchWithKey, installKeyEgressGuard, type EgressGuardOptions } from "./gateway-base.js";

const STORAGE_KEY = "pcc-api-key";

/**
 * The signed-in API key is held here and in no other module (N50; astra
 * rounds 2 and 3). No export returns it. It leaves this module in only two
 * ways:
 * - fetchWithKey, which sends it to the configured gateway and nowhere else
 *   (authorizedFetch);
 * - the egress guard, which compares outgoing requests against it.
 * Other modules can replace it (setStoredApiKey, used by the auth store) and
 * ask whether one is held (hasStoredApiKey). Neither reads it back out. Every
 * replacement is reported to onStoredKeyChange's listeners, without the key:
 * the auth store makes each one an identity change (astra A03d N1).
 * __tests__/no-direct-auth-headers.test.ts and lib/__tests__/key-boundary-r4
 * hold this module to that.
 *
 * It is persisted in localStorage so a reload keeps the user signed in. Any
 * script on this origin can still read that slot. Only an HttpOnly gateway
 * session would take the key out of JavaScript's reach, and that is a gateway
 * change awaiting the operator. Until then the ratchet keeps every other
 * module off this slot, and off storage it can't name.
 */
let storedApiKey: string | null = readStorage();

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(key: string | null): void {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the key lives for this page only.
  }
}

const keyListeners = new Set<() => void>();
/** Rounds of re-entrant changes delivered before setStoredApiKey gives up on listeners that keep changing the key. */
const MAX_KEY_CHANGE_ROUNDS = 32;
/** Changes not yet told to every listener, and whether a delivery is under way. */
let undelivered = 0;
let delivering = false;

/**
 * Hold `key` as the signed-in key, or clear it with null. Write-only: nothing
 * reads it back. Tells onStoredKeyChange's listeners.
 *
 * Every listener hears every change, even if another one throws (astra A03e
 * N1): the auth store's identity change can't be skipped by an observer that
 * failed before it. The first error is rethrown once all have heard. A
 * listener that changes the key again doesn't recurse: its change is told
 * to everyone after the current round, up to MAX_KEY_CHANGE_ROUNDS.
 */
export function setStoredApiKey(key: string | null): void {
  storedApiKey = key || null;
  writeStorage(storedApiKey);
  undelivered += 1;
  if (delivering) return;
  delivering = true;
  let failed = false;
  let failure: unknown;
  try {
    for (let round = 0; undelivered > 0; round++) {
      if (round === MAX_KEY_CHANGE_ROUNDS) {
        undelivered = 0;
        throw new Error("Key listeners kept changing the key; stopped telling them.");
      }
      undelivered -= 1;
      for (const listener of [...keyListeners]) {
        try {
          listener();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }
  } finally {
    delivering = false;
  }
  if (failed) throw failure;
}

/** Calls `onChange` after every change of the stored key, whoever makes it. It is told that the key changed, never what it is. */
export function onStoredKeyChange(onChange: () => void): () => void {
  keyListeners.add(onChange);
  return () => keyListeners.delete(onChange);
}

/** Whether a signed-in key is held. Never the key itself. */
export function hasStoredApiKey(): boolean {
  return storedApiKey !== null;
}

/**
 * fetch() as the signed-in user: the stored key is attached only when
 * `target` resolves to the configured gateway, and anything else is refused
 * before a request is made (lib/gateway-base.ts). Every module that sends the
 * key does it through here.
 */
export function authorizedFetch(target: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithKey(target, storedApiKey, init);
}

/** Install the defence-in-depth egress guard over the stored key (main.tsx, at startup). */
export function installGatewayKeyGuard(options: EgressGuardOptions = {}): () => void {
  return installKeyEgressGuard(() => storedApiKey, options);
}
