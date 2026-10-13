import { fetchWithKey, installKeyEgressGuard, type EgressGuardOptions } from "./gateway-base.js";
import { isSessionKeyActive, renewSessionKey, sessionIdentity } from "./session-key-recovery.js";

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
 * Pasted keys persist in localStorage so a reload keeps the user signed in;
 * wallet session keys remain in memory for this page only. Any script on
 * this origin can still read the persisted slot. The ratchet keeps every
 * other module off this slot, and off storage it can't name.
 */
let storedApiKey: string | null = readStorage();
let keyVersion = 0;

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
 */
export function setStoredApiKey(key: string | null, persist = true): void {
  if (round >= MAX_KEY_CHANGE_ROUNDS - 1) {
    throw new Error("Key listeners kept changing the key; this change was refused.");
  }
  storedApiKey = key || null;
  keyVersion += 1;
  writeStorage(persist ? storedApiKey : null);
  undelivered += 1;
  if (round >= 0) return; // a delivery is under way: the next round tells everyone
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
export async function authorizedFetch(target: string, init: RequestInit = {}): Promise<Response> {
  const version = keyVersion;
  const sessionKey = isSessionKeyActive();
  const identity = sessionIdentity();
  const response = await fetchWithKey(target, storedApiKey, init);
  if (response.status !== 401 || !sessionKey || !isSessionKeyActive() || identity !== sessionIdentity()) return response;
  // A late response may belong to the key another request already renewed.
  if (version === keyVersion && !await renewSessionKey()) return response;
  if (!isSessionKeyActive() || identity !== sessionIdentity()) return response;
  return fetchWithKey(target, storedApiKey, init);
}

/** Install the defence-in-depth egress guard over the stored key (main.tsx, at startup). */
export function installGatewayKeyGuard(options: EgressGuardOptions = {}): () => void {
  return installKeyEgressGuard(() => storedApiKey, options);
}
