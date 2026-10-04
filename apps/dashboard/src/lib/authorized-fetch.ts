import { fetchWithKey, installKeyEgressGuard, type EgressGuardOptions } from "./gateway-base.js";
import { walletSessionEnding } from "./account-generation.js";

const STORAGE_KEY = "pcc-api-key";

/**
 * The signed-in API key's owner (N50; #354).
 *
 * The browser's storage is the ONE authority (DECISIONS 2026-10-04 04:14). No
 * module keeps the key between uses, this one included: every request reads
 * the slot as it is made, so this tab acts as the account the slot holds, the
 * account every other tab and the next load act as, or as no one. A slot that
 * can't be read holds no key, and the request goes without one (fail closed).
 * Ten review rounds (astra 19 to 19j) each found another way a key held in
 * memory could part from the slot; with none held, nothing can.
 *
 * The key leaves this module in two ways only, and no export returns it:
 * - fetchWithKey, which sends it to the configured gateway and nowhere else
 *   (authorizedFetch);
 * - the egress guard, which compares outgoing requests against it.
 * Other modules can change the slot (setStoredApiKey, used by the auth store)
 * and ask whether it holds a key (hasStoredApiKey). Neither reads it back out.
 * Every change is reported to onStoredKeyChange's listeners, without the key.
 * They drive the UI and the account teardown (the auth store, App); they hold
 * no authority. __tests__/no-direct-auth-headers.test.ts and
 * lib/__tests__/key-boundary-r4 hold this module to that.
 *
 * Any script on this origin can still read the slot. Only an HttpOnly gateway
 * session would take the key out of JavaScript's reach, and that is a gateway
 * change awaiting the operator. Until then the ratchet keeps every other
 * module off this slot, and off storage it can't name.
 */
function readKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * The key a request carries now: the slot's, unless an account change is
 * still pending for the browser (lib/account-generation.ts). A login moves the
 * generation before it stores the next key, and the change stays pending
 * until a teardown confirms the previous wallet session's SIWE cookie is gone.
 * Until then no tab sends a key, whether or not it has heard of the change, so
 * the next account's key never goes out beside the previous account's cookie
 * (astra 19f, 19g). Both are read from storage here, at use: the pending
 * change can only withhold the key, never choose one.
 */
function keyToSend(): string | null {
  return walletSessionEnding() ? null : readKey();
}

/**
 * How a change of the slot came out:
 * - "committed": the slot reads as the new value;
 * - "unconfirmed": it doesn't, so the change may or may not have been made.
 *   Neither a write that threw nor a read of the old value proves the slot is
 *   unchanged: a write can go through and then throw, and a stale read looks
 *   the same as a dropped write (astra 19j, 19k). The listeners are told all
 *   the same, and this tab acts as whatever the slot holds when it is next
 *   read;
 * - "busy": another change was being told to the listeners, so this one was
 *   refused before anything was written (DECISIONS 04:14: transitions are
 *   serialized).
 */
export type KeyWrite = "committed" | "unconfirmed" | "busy";

const keyListeners = new Set<() => void>();
/** How many deliveries are under way; a change asked for during one is refused. */
let delivering = 0;

/**
 * Write `key` to the slot, or empty it with null, and say how it came out
 * (KeyWrite). Write-only: nothing reads the key back out.
 *
 * Every change that may have been made is told to every listener, even if one
 * of them throws (astra A03e N1); the first error is rethrown once all have
 * heard. One change at a time: a change asked for while another is being told
 * (a listener changing the key again) is refused before it touches the slot,
 * so no listener can sign in again in the middle of a sign-out (astra 19j,
 * 19k).
 */
export function setStoredApiKey(key: string | null): KeyWrite {
  if (delivering > 0) return "busy";
  const next = key || null;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not proof that nothing changed: the read below decides.
  }
  let confirmed = false;
  try {
    confirmed = localStorage.getItem(STORAGE_KEY) === next;
  } catch {
    // Unreadable: unconfirmed.
  }
  tellListeners();
  return confirmed ? "committed" : "unconfirmed";
}

/** Tell every listener the slot may have changed: every one hears, and the first error is rethrown after. */
function tellListeners(): void {
  delivering += 1;
  let failed = false;
  let failure: unknown;
  try {
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
  } finally {
    delivering -= 1;
  }
  if (failed) throw failure;
}

// The key is the browser's, not one tab's: every tab reads the same slot, and
// shares the gateway's SIWE cookie. When another tab signs in, out or as
// someone else, this tab's next request already follows the slot (keyToSend);
// its storage event tells the listeners, so the auth store moves keyEpoch and
// this tab's account boundary runs (App.tsx; #354, astra 19d). Without a key
// kept here there is nothing to compare an event with, so every event for the
// slot counts as a change: at worst a spare teardown, which fails closed.
// A page restored from the back/forward cache missed the events of its time
// away, so it counts as a change too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return; // null: another tab cleared storage
    tellListeners();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) tellListeners();
  });
}

/** Calls `onChange` after every change of the stored key, whoever makes it, in this tab or another. It is told that the key changed, never what it is. */
export function onStoredKeyChange(onChange: () => void): () => void {
  keyListeners.add(onChange);
  return () => keyListeners.delete(onChange);
}

/** Whether the slot holds a key now. Never the key itself. */
export function hasStoredApiKey(): boolean {
  return readKey() !== null;
}

/**
 * fetch() as the signed-in user: the key read now (keyToSend) is attached
 * only when `target` resolves to the configured gateway, and anything else is
 * refused before a request is made (lib/gateway-base.ts). Every module that
 * sends the key does it through here.
 */
export function authorizedFetch(target: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithKey(target, keyToSend(), init);
}

/** Install the defence-in-depth egress guard over the slot's key, pending change or not (main.tsx, at startup). */
export function installGatewayKeyGuard(options: EgressGuardOptions = {}): () => void {
  return installKeyEgressGuard(readKey, options);
}
