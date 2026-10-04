import { create } from "zustand";
import { fetchWithKey } from "../lib/gateway-base.js";
import { hasStoredApiKey, onStoredKeyChange, setStoredApiKey } from "../lib/authorized-fetch.js";
import { beginAccountChange } from "../lib/account-generation.js";

/**
 * Sign-in state. The API key itself is not here, not in the state and not in
 * this module: lib/authorized-fetch.ts holds it, and no export anywhere
 * returns it (N50; astra rounds 2 and 3). This store only knows whether a
 * key is held.
 */
interface AuthState {
  // -- API Key auth (primary gate) --
  /** Whether an API key is held. The key itself is never in the store. */
  isAuthenticated: boolean;
  /** Bumped on every change of the stored key, whoever makes it (onStoredKeyChange). Never the key. */
  keyEpoch: number;
  login: (key: string) => Promise<boolean>;
  logout: () => void;

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

export const useAuthStore = create<AuthState>((set) => ({
  // -- API Key auth --
  isAuthenticated: hasStoredApiKey(),
  keyEpoch: 0,

  login: async (key: string): Promise<boolean> => {
    try {
      // The candidate key goes to the configured gateway and nowhere else.
      const res = await fetchWithKey("/api/auth/validate", key);
      if (!res.ok) return false;
      // The generation moves first, so a tab that sees this key sees the
      // change pending (astra 19g). If it can't move, no tab would know: store
      // nothing (fail closed). This store can't tell the key from the one held
      // (N50 keeps the key out of its reach), so every login is a change: a
      // second login with the same key ends the wallet session and remounts,
      // which fails closed.
      if (!beginAccountChange()) return false;
      adoptApiKey(key);
      return true;
    } catch {
      return false;
    }
  },

  logout: () => {
    // The key goes first, then the generation moves, so every tab ends the
    // wallet session (astra 19e; the state between the two writes has no
    // authenticated shell, 19h). The key change clears the wallet fields in the
    // same set(), so the identity change is reported once (onIdentityChange).
    // The teardown it starts reads the generation only after its first await,
    // under the wallet-session lock (lib/wallet-session.ts), so it sees the move.
    const hadKey = hasStoredApiKey();
    setStoredApiKey(null);
    if (hadKey) beginAccountChange();
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
// (astra A03d N1), in this tab or another (lib/authorized-fetch.ts follows the
// slot across tabs). setStoredApiKey() is exported, so a module that called it
// directly used to replace the key behind onIdentityChange: reads cached under
// the previous key survived while authorizedFetch sent the new one. Now the
// key's owner reports each change, and this one set() follows it: the epoch
// moves, isAuthenticated follows the key, and a sign-out clears the wallet
// session's fields with it. Every change counts, even to the same key: telling
// "same key" from "another key" would make this an equality test on the
// stored key.
onStoredKeyChange(() => {
  const signedIn = hasStoredApiKey();
  useAuthStore.setState((s) => ({
    isAuthenticated: signedIn,
    keyEpoch: s.keyEpoch + 1,
    ...(signedIn ? {} : { address: null, sessionToken: null, error: null }),
  }));
});

/**
 * Hold `key` as the signed-in key, or sign out with null. login() calls it
 * after the gateway accepts the key; tests call it directly. It is
 * write-only: writing a key cannot leak one.
 */
export function adoptApiKey(key: string | null): void {
  setStoredApiKey(key);
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
