import { fetchWithKey, installKeyEgressGuard, type EgressGuardOptions } from "./gateway-base.js";

const STORAGE_KEY = "pcc-api-key";
const CONFIRMED_KEY = "pcc-wallet-session-confirmed";

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
 * The slot holds the ACCOUNT RECORD (DECISIONS 05:04): the key, and the
 * account generation it was stored under, as one JSON value written by one
 * setItem. A storage item reads as one value, so one read gives the key with
 * its generation, and no other tab's write can fall between them (astra 19l).
 * A key stored before the record existed (a plain bearer token) reads as that
 * key, with generation "". Anything that is neither is no key (astra 19m).
 *
 * The key leaves this module in two ways only, and no export returns it:
 * - fetchWithKey, which sends it to the configured gateway and nowhere else
 *   (authorizedFetch);
 * - the egress guard, which compares outgoing requests against it.
 * Other modules can change the slot (setStoredApiKey, used by the auth store),
 * ask whether it holds a key (hasStoredApiKey), and read its generation
 * (accountGeneration). None reads the key back out. Every change is reported
 * to onStoredKeyChange's listeners, without the key. They drive the UI and the
 * account teardown (the auth store, App); they hold no authority.
 * __tests__/no-direct-auth-headers.test.ts and lib/__tests__/key-boundary-r4
 * hold this module to that.
 *
 * Any script on this origin can still read the slot. Only an HttpOnly gateway
 * session would take the key out of JavaScript's reach, and that is a gateway
 * change awaiting the operator. Until then the ratchet keeps every other
 * module off this slot, and off storage it can't name.
 */
interface AccountRecord {
  key: string | null;
  generation: string;
}

/** A bearer token's characters (RFC 6750 b64token): what a key stored before the record can be. */
const PLAIN_KEY = /^[A-Za-z0-9\-._~+/]+=*$/;

/** The slot's record, from one read; null when the slot can't be read. */
function readRecord(): AccountRecord | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return { key: null, generation: "" };
  if (PLAIN_KEY.test(raw)) return { key: raw, generation: "" }; // stored before the record
  return parseRecord(raw) ?? { key: null, generation: "" }; // not a record this module wrote: no key (fail closed)
}

/**
 * The record exactly as this module writes it: an object with only `key`
 * (null, or a non-empty string) and `generation` (a string). Anything else is
 * null, as a whole: no field is filled in or defaulted, so a part of a record
 * can't pass as one (astra 19m).
 */
function parseRecord(raw: string): AccountRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = Object.keys(value);
  if (fields.length !== 2 || !fields.includes("key") || !fields.includes("generation")) return null;
  const { key, generation } = value as { key: unknown; generation: unknown };
  if (typeof generation !== "string") return null;
  if (key !== null && (typeof key !== "string" || key === "")) return null;
  return { key, generation };
}

function readKey(): string | null {
  return readRecord()?.key ?? null;
}

/** The last generation a teardown confirmed ("" before any), or null when it can't be read. */
function confirmedGeneration(): string | null {
  try {
    return localStorage.getItem(CONFIRMED_KEY) ?? "";
  } catch {
    return null;
  }
}

/**
 * The key a request carries now: the record's, once the teardown for the
 * generation it was stored under is confirmed (DECISIONS 05:02, 05:04). Every
 * login and logout moves the generation in the same write as the key, and the
 * change stays pending until a teardown confirms the previous wallet session's
 * SIWE cookie is gone. Until then no tab sends the key, whether or not it has
 * heard of the change, so the next account's key never goes out beside the
 * previous account's cookie (astra 19f, 19g).
 *
 * The key and its generation come from ONE read, so another tab's login can't
 * fall between them (astra 19l). The confirmed marker is a second read, and
 * the order doesn't matter: the marker only ever names a generation whose
 * teardown finished, so a change landing between the two reads can only make
 * them differ, which withholds the key. Both reads are of storage, at use: the
 * pending change can only withhold the key, never choose one.
 */
function keyToSend(): string | null {
  const record = readRecord();
  if (record === null || record.key === null) return null;
  return confirmedGeneration() === record.generation ? record.key : null;
}

/** The account generation now ("" before the first change), or null when storage can't be read. Never the key. */
export function accountGeneration(): string | null {
  return readRecord()?.generation ?? null;
}

/** Whether a teardown is pending: the record's generation is past the last one confirmed. When storage can't be read, it may be (fail closed). */
export function walletSessionEnding(): boolean {
  const generation = accountGeneration();
  const confirmed = confirmedGeneration();
  return generation === null || confirmed === null || generation !== confirmed;
}

/**
 * Records that the wallet session ended, as of `generation`, and says whether
 * storage shows it: true only when the marker reads back as `generation`, the
 * value the request gate compares (astra 19m). Only a teardown holding the
 * wallet-session lock calls this, after the gateway confirmed its logout, with
 * the generation it read before sending it. It is a slot of its own: a
 * teardown never rewrites the account record, so it can't undo a login
 * another tab makes meanwhile (localStorage has no compare-and-swap).
 */
export function confirmWalletSessionEnded(generation: string): boolean {
  try {
    localStorage.setItem(CONFIRMED_KEY, generation);
  } catch {
    // Not proof that it didn't land: the read below decides.
  }
  return confirmedGeneration() === generation;
}

function newGeneration(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * How a change of the slot came out:
 * - "committed": the slot reads back as the record written;
 * - "unconfirmed": it doesn't, so the change may or may not have been made.
 *   Neither a write that threw nor a read of the old value proves the slot is
 *   unchanged: a write can go through and then throw, and a stale read looks
 *   the same as a dropped write (astra 19j, 19k). The listeners are told all
 *   the same, so the account boundary runs and its teardown can confirm a
 *   change that did land (astra 19l). This tab acts as whatever the slot
 *   holds when it is next read;
 * - "busy": another change was being told to the listeners, so this one was
 *   refused before anything was written (DECISIONS 04:14: transitions are
 *   serialized).
 */
export type KeyWrite = "committed" | "unconfirmed" | "busy";

const keyListeners = new Set<() => void>();
/** How many deliveries are under way; a change asked for during one is refused. */
let delivering = 0;

/**
 * Write `key` to the record, or empty it with null, and say how it came out
 * (KeyWrite). Write-only: nothing reads the key back out.
 *
 * Every write is an account change unless it says otherwise (astra 19m): the
 * next key, or none, and a new generation land together, and every tab
 * withholds the key until a teardown confirms the change. A write that keeps
 * the account passes `accountChange: false`, and the record keeps its
 * generation: only tests do, through the auth store's adoptApiKey.
 *
 * Every change that may have been made is told to every listener, even if one
 * of them throws (astra A03e N1); the first error is rethrown once all have
 * heard. One change at a time: a change asked for while another is being told
 * (a listener changing the key again) is refused before it touches the slot,
 * so no listener can sign in again in the middle of a sign-out (astra 19j,
 * 19k).
 */
export function setStoredApiKey(key: string | null, options: { accountChange?: boolean } = {}): KeyWrite {
  if (delivering > 0) return "busy";
  const record: AccountRecord = {
    key: key || null,
    generation: options.accountChange === false ? (readRecord()?.generation ?? "") : newGeneration(),
  };
  const written = JSON.stringify(record);
  try {
    localStorage.setItem(STORAGE_KEY, written);
  } catch {
    // Not proof that nothing changed: the read below decides.
  }
  let confirmed = false;
  try {
    confirmed = localStorage.getItem(STORAGE_KEY) === written;
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
// this tab's account boundary runs (App.tsx; #354, astra 19d). The record
// carries the generation, so one event brings both. Without a key kept here
// there is nothing to compare an event with, so every event for the slot
// counts as a change: at worst a spare teardown, which fails closed. A page
// restored from the back/forward cache missed the events of its time away, so
// it counts as a change too.
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
