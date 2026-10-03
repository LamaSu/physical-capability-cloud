import { create } from "zustand";
import { fetchWithKey } from "../lib/gateway-base.js";
import { hasStoredApiKey, setStoredApiKey } from "../lib/authorized-fetch.js";

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
  /** Bumped on every sign-in, sign-out or key replacement (adoptApiKey, logout). Never the key. */
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
      adoptApiKey(key);
      return true;
    } catch {
      return false;
    }
  },

  logout: () => {
    // One set(), so an identity change is reported once (onIdentityChange).
    setStoredApiKey(null);
    set((s) => ({ isAuthenticated: false, keyEpoch: s.keyEpoch + 1, address: null, sessionToken: null, error: null }));
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

/**
/**
 * Hold `key` as the signed-in key, or sign out with null. login() calls it
 * after the gateway accepts the key; tests call it directly. It is
 * write-only: writing a key cannot leak one. Every call is an identity change
 * (keyEpoch), even with the same key: telling "same key" from "another key"
 * would make this an equality test on the stored key.
 */
export function adoptApiKey(key: string | null): void {
  setStoredApiKey(key);
  useAuthStore.setState((s) => ({ isAuthenticated: hasStoredApiKey(), keyEpoch: s.keyEpoch + 1 }));
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

