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
 * It is persisted in localStorage so a reload keeps the user signed in, and
 * that slot is the account every tab and every load act as (#354). A change
 * the browser won't save is not made (astra 19i): the held key changes only
 * after the slot holds the new value. A change that may or may not have been
 * saved leaves this tab holding no key (astra 19j). Any script on this origin
 * can still read that slot. Only an HttpOnly gateway
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

/**
 * How a change of the key's slot came out (astra 19j):
 * - "committed": the slot holds the new value;
 * - "unchanged": the browser refused the write, and the slot still holds what
 *   it held;
 * - "unconfirmed": neither can be told. The write may have gone through, and
 *   the read after it failed or returned an old value (a stale read looks the
 *   same as a dropped write).
 */
export type KeyWrite = "committed" | "unchanged" | "unconfirmed";

/** Not a value the slot can hold: it couldn't be read. */
const UNREADABLE = Symbol("unreadable");

function slotValue(): string | null | typeof UNREADABLE {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return UNREADABLE;
  }
}

/** Write `key` to the slot (null removes it), and say how it came out. */
function writeStorage(key: string | null): KeyWrite {
  const before = slotValue();
  let refused = false;
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    refused = true;
  }
  const after = slotValue();
  if (after === key) return "committed";
  // Unchanged only when the browser refused it (the call threw) and the slot still reads as it did.
  if (refused && before !== UNREADABLE && after === before) return "unchanged";
  return "unconfirmed";
}

const keyListeners = new Set<() => void>();
/** Rounds of delivery one setStoredApiKey call runs before it refuses listeners' further changes. */
const MAX_KEY_CHANGE_ROUNDS = 32;
/** Changes not yet told to every listener; the round being delivered, or -1 when none is. */
let undelivered = 0;
let round = -1;

/**
 * Hold `key` as the signed-in key, or clear it with null. Write-only: nothing
 * reads it back. Tells onStoredKeyChange's listeners.
 *
 * Every listener hears every change, even if another one throws (astra A03e
 * N1): the auth store's identity change can't be skipped by an observer that
 * failed before it. The first error is rethrown once all have heard. A
 * listener that changes the key again doesn't recurse: its change is told to
 * everyone in the next round. A change made in the last round is refused
 * before it touches the key (astra A03f N1), so the key never holds a value
 * its listeners weren't told of.
 *
 * Says how the slot's change came out (KeyWrite). This tab can't act as one
 * account while every other tab and the next load act as another, so:
 * - "unchanged": nothing changed here either, and no one is told (astra 19i);
 * - "unconfirmed": the slot may hold the new key or the old, so neither stays
 *   live here. This tab holds no key, and every listener hears it (astra 19j).
 */
export function setStoredApiKey(key: string | null): KeyWrite {
  return replaceStoredKey(key, true);
}

/**
 * Replace the held key and tell every listener, by the rules above. `persist`
 * writes it to the slot; a change another tab already wrote there is taken
 * without writing it back.
 */
function replaceStoredKey(key: string | null, persist: boolean): KeyWrite {
  if (round >= MAX_KEY_CHANGE_ROUNDS - 1) {
    throw new Error("Key listeners kept changing the key; this change was refused.");
  }
  let next = key || null;
  let outcome: KeyWrite = "committed";
  if (persist) {
    outcome = writeStorage(next);
    if (outcome === "unchanged") return outcome; // refused before the held key changes or anyone is told
    if (outcome === "unconfirmed") next = null; // neither the old key nor the new one stays live here
  }
  storedApiKey = next;
  undelivered += 1;
  if (round >= 0) return outcome; // a delivery is under way: the next round tells everyone
  let failed = false;
  let failure: unknown;
  try {
    for (round = 0; undelivered > 0; round++) {
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
    round = -1;
  }
  if (failed) throw failure;
  return outcome;
}

// The key is the browser's, not one tab's: every tab reads the same slot, and
// shares the gateway's SIWE cookie. When another tab signs in, out or as
// someone else, this tab takes the slot's new value and tells its listeners
// like any other change, so the auth store moves keyEpoch and this tab's
// account boundary runs (App.tsx; #354, astra 19d). A tab left on the previous
// account could otherwise start a SIWE sign-in whose cookie the next account's
// tabs would carry. The slot is read here, in the module that owns it (N50).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return; // null: another tab cleared storage
    const next = readStorage();
    if (next === storedApiKey) return;
    replaceStoredKey(next, false);
  });
}

/** Calls `onChange` after every change of the stored key, whoever makes it, in this tab or another. It is told that the key changed, never what it is. */
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
