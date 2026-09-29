import { create } from "zustand";
import { fetchWithKey } from "../lib/gateway-base.js";

const STORAGE_KEY = "pcc-api-key";

/**
 * The signed-in API key lives only in this module (and in localStorage, where
 * login puts it). It is deliberately NOT part of the store's state, so no
 * component or module can read it from the store (N50 round 2, astra). Its
 * only reader is lib/authorized-fetch.ts, through readApiKeyForAuthorizedFetch()
 * (enforced by __tests__/no-direct-auth-headers.test.ts).
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

interface AuthState {
  // -- API Key auth (primary gate) --
  /** Whether an API key is held. The key itself is never in the store. */
  isAuthenticated: boolean;
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
  isAuthenticated: !!storedApiKey,

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
    adoptApiKey(null);
    set({ address: null, sessionToken: null, error: null });
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
 * Hold `key` as the signed-in key (or sign out with null). login() calls it
 * after the gateway accepts the key; tests call it directly. Writing a key
 * cannot leak one.
 */
export function adoptApiKey(key: string | null): void {
  storedApiKey = key;
  writeStorage(key);
  useAuthStore.setState({ isAuthenticated: !!key });
}

/**
 * The signed-in key. ONLY lib/authorized-fetch.ts may call this: it hands the
 * key to fetchWithKey(), which sends it to the gateway and nowhere else.
 * Any other reference fails __tests__/no-direct-auth-headers.test.ts.
 */
export function readApiKeyForAuthorizedFetch(): string | null {
  return storedApiKey;
}
