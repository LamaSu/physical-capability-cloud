import { create } from "zustand";
import { fetchWithKey } from "../lib/gateway-base.js";
import { hasStoredApiKey, onStoredKeyChange, setStoredApiKey, type KeyWrite } from "../lib/authorized-fetch.js";

/**
 * How a sign-out came out (DECISIONS 2026-10-04 04:14). Every surface that
 * offers one renders `reason` when there is one: the shell's Disconnect,
 * ConnectWallet and useAuth().logout.
 * - "signed-out": the browser's slot reads empty;
 * - "unconfirmed": the browser didn't confirm the removal (astra 19i, 19j,
 *   19k). This tab acts as whatever the slot holds, which may still be the key;
 * - "refused": another sign-in or sign-out was under way, so nothing was done.
 */
export type SignOutResult = { status: "signed-out" } | { status: "unconfirmed" | "refused"; reason: string };

/**
 * Sign-in state. The API key itself is not here, not in the state and not in
 * this module: lib/authorized-fetch.ts reads it from the browser's slot at
 * each use, and no export anywhere returns it (N50; astra rounds 2 and 3;
 * DECISIONS 04:14). This store only knows whether the slot held a key at the
 * last change.
 */
interface AuthState {
  // -- API Key auth (primary gate) --
  /** Whether the slot held a key at the last change. The key itself is never in the store. */
  isAuthenticated: boolean;
  /** Bumped on every change of the stored key, whoever makes it (onStoredKeyChange). Never the key. */
  keyEpoch: number;
  login: (key: string) => Promise<boolean>;
  /** Signs out, and says how it came out. Also kept as lastSignOut. */
  logout: () => SignOutResult;
  /**
   * How this tab's last sign-out came out, until the key next changes. It is
   * kept here, above the account boundary: a sign-out the browser didn't
   * confirm still remounts the shell (every listener hears it), and the
   * surface that offered it must still say why.
   */
  lastSignOut: SignOutResult | null;

  // -- Wallet/SIWE auth (secondary, for on-chain features) --
  /** Connected wallet address */
  address: string | null;
  /** Session token from SIWE verification */
  sessionToken: string | null;
  /** Whether SIWE verification is in progress */
  isVerifying: boolean;
  /** Auth error message */
  error: string | null;

  setAddress: (address: string | null) => void;
  setSession: (token: string | null) => void;
  setVerifying: (v: boolean) => void;
  setError: (e: string | null) => void;
}

/** Why a sign-in or sign-out didn't go as asked (astra 19i, 19j, 19k; DECISIONS 04:14). */
const KEY_UNCONFIRMED_SAVE =
  "This browser couldn't confirm it saved your API key, so you may not be signed in as that account. Check that this site may store data, then sign in again.";
const KEY_UNCONFIRMED_REMOVAL =
  "This browser couldn't confirm it removed your saved API key, so you may still be signed in here or in another tab. Clear this site's data to sign out.";
const KEY_CHANGE_BUSY = "Another sign-in or sign-out was under way, so this one didn't happen. Try again.";

export const useAuthStore = create<AuthState>((set) => ({
  // -- API Key auth --
  isAuthenticated: hasStoredApiKey(),
  keyEpoch: 0,
  lastSignOut: null,

  login: async (key: string): Promise<boolean> => {
    set({ error: null }); // a reason left from before belongs to that attempt
    try {
      // The candidate key goes to the configured gateway and nowhere else.
      const res = await fetchWithKey("/api/auth/validate", key);
      if (!res.ok) return false;
      // The key and a new generation are ONE write (DECISIONS 05:04): a tab
      // that sees the key sees the change pending with it, and every tab
      // withholds the key until a teardown confirms the change (astra 19g,
      // 19l). The slot is the account every tab, this one included, and the
      // next load act as (DECISIONS 04:14). A save it didn't confirm is
      // reported, never taken as made or as refused (astra 19i, 19j, 19k), and
      // every listener hears it either way, so the account boundary runs and
      // its teardown can confirm a change that did land. This store can't tell
      // the key from the one in the slot (N50 keeps the key out of its reach),
      // so every login is a change: a second login with the same key ends the
      // wallet session and remounts, which fails closed.
      const saved = setStoredApiKey(key, { accountChange: true });
      if (saved === "committed") return true;
      set({ error: saved === "busy" ? KEY_CHANGE_BUSY : KEY_UNCONFIRMED_SAVE });
      return false;
    } catch {
      return false;
    }
  },

  logout: (): SignOutResult => {
    // The key's removal and a new generation are ONE write (DECISIONS 05:04),
    // so every tab ends the wallet session (astra 19e), with no state between
    // two writes (19h), whether or not a key was held before (19k). The key
    // change clears the wallet fields in the same set(), so the identity
    // change is reported once (onIdentityChange). The teardown it starts reads
    // the generation after its first await, under the wallet-session lock
    // (lib/wallet-session.ts). A change refused as "busy" wrote nothing. A
    // listener's error goes on after every listener heard (astra A03e N1).
    const removal: KeyWrite = setStoredApiKey(null, { accountChange: true });
    const result: SignOutResult =
      removal === "committed"
        ? { status: "signed-out" }
        : removal === "busy"
          ? { status: "refused", reason: KEY_CHANGE_BUSY }
          : { status: "unconfirmed", reason: KEY_UNCONFIRMED_REMOVAL };
    set({ lastSignOut: result });
    return result;
  },

  // -- Wallet/SIWE auth --
  address: null,
  sessionToken: null,
  isVerifying: false,
  error: null,

  setAddress: (address) => set({ address, error: null }),
  setSession: (token) => set({ sessionToken: token, isVerifying: false }),
  setVerifying: (v) => set({ isVerifying: v }),
  setError: (e) => set({ error: e, isVerifying: false }),
}));

// Every change of the stored key is an identity change, whoever makes it
// (astra A03d N1), in this tab or another (lib/authorized-fetch.ts tells its
// listeners of both). setStoredApiKey() is exported, so a module that called
// it directly used to replace the key behind onIdentityChange: reads cached
// under the previous key survived while authorizedFetch sent the new one. Now
// the key's owner reports each change, and this one set() follows it: the
// epoch moves, isAuthenticated follows the slot, and a sign-out clears the
// wallet session's fields with it. Every change counts, even to the same key:
// telling "same key" from "another key" would make this an equality test on
// the stored key.
onStoredKeyChange(() => {
  const signedIn = hasStoredApiKey();
  useAuthStore.setState((s) => ({
    isAuthenticated: signedIn,
    keyEpoch: s.keyEpoch + 1,
    lastSignOut: null, // it belonged to the key before this change; logout() records its own after
    ...(signedIn ? {} : { address: null, sessionToken: null, error: null }),
  }));
});

/**
 * Store `key` as the signed-in key, or sign out with null, without moving the
 * account generation: tests call it directly. login() and logout() store
 * through setStoredApiKey with the account change. It is write-only: writing
 * a key cannot leak one. Says how the browser's slot took the change
 * (KeyWrite: astra 19i, 19j, 19k; DECISIONS 04:14).
 */
export function adoptApiKey(key: string | null): KeyWrite {
  return setStoredApiKey(key);
}

/**
 * Calls `onChange` whenever the signed-in identity changes: a key signed in or
 * out, a different key, wallet or SIWE session. A cached read must not outlive
 * the identity that made it, so App clears the query cache here (review r3 of
 * #353). The key itself is never in this store (N50), so a key change shows as
 * keyEpoch.
 */
export function onIdentityChange(onChange: () => void): () => void {
  return useAuthStore.subscribe((s, prev) => {
    if (s.keyEpoch !== prev.keyEpoch || s.address !== prev.address || s.sessionToken !== prev.sessionToken) onChange();
  });
}

/**
 * Calls `onChange` whenever the signed-in account may have changed: any change
 * of the stored key, here or in another tab, including login() with a key
 * while signed in. App resets every account-scoped store on it and remounts
 * the signed-in shell (astra 19c). The account follows the key, not
 * isAuthenticated: a key replaced while signed in is a different account. The
 * store can't tell one key from another (N50), so every key change counts as
 * one. Zustand calls this inside the set() that moved keyEpoch, so it runs
 * before anything renders for the next account.
 */
export function onAccountChange(onChange: () => void): () => void {
  return useAuthStore.subscribe((s, prev) => {
    if (s.keyEpoch !== prev.keyEpoch) onChange();
  });
}
