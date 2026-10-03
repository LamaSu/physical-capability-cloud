import { create } from "zustand";
import { beginAccountChange } from "../lib/account-generation.js";

const API = import.meta.env.VITE_PCC_URL ?? "";
const STORAGE_KEY = "pcc-api-key";

interface AuthState {
  // -- API Key auth (primary gate) --
  apiKey: string | null;
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

export const useAuthStore = create<AuthState>((set, get) => {
  // Hydrate API key from localStorage on store creation
  const storedKey = localStorage.getItem(STORAGE_KEY);

  return {
    // -- API Key auth --
    apiKey: storedKey,
    isAuthenticated: !!storedKey,

    login: async (key: string): Promise<boolean> => {
      try {
        const res = await fetch(`${API}/api/auth/validate`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.ok) {
          // The generation moves first, so a tab that sees this key sees the change pending (astra 19g).
          // If it can't move, no tab would know: store nothing (fail closed).
          if (key !== get().apiKey && !beginAccountChange()) return false;
          localStorage.setItem(STORAGE_KEY, key);
          set({ apiKey: key, isAuthenticated: true });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },

    logout: () => {
      localStorage.removeItem(STORAGE_KEY);
      if (get().apiKey !== null) beginAccountChange();
      set({ apiKey: null, isAuthenticated: false, address: null, sessionToken: null, error: null });
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
  };
});

// The key is the browser's, not one tab's: every tab reads the same
// localStorage, and shares the gateway's SIWE cookie. When another tab signs
// in, out or as someone else, this tab follows, so its own account boundary
// runs (App.tsx). A tab left as the previous account could otherwise start a
// SIWE sign-in whose cookie the new account's tabs would carry.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return; // null: another tab cleared storage
    const key = localStorage.getItem(STORAGE_KEY);
    if (key === useAuthStore.getState().apiKey) return;
    useAuthStore.setState({ apiKey: key, isAuthenticated: !!key });
  });
}

/**
 * Calls `onChange` whenever the signed-in identity changes: a key signed in or out, a
 * different key, wallet or SIWE session. A cached read must not outlive the identity that
 * made it, so App clears the query cache here (review r3 of #353).
 */
export function onIdentityChange(onChange: () => void): () => void {
  return useAuthStore.subscribe((s, prev) => {
    if (s.apiKey !== prev.apiKey || s.address !== prev.address || s.sessionToken !== prev.sessionToken) onChange();
  });
}

/**
 * Calls `onChange` whenever the signed-in account changes: a key signed in or
 * out, or a different key, including login() with another key while signed
 * in. App resets every account-scoped store on it and remounts the signed-in
 * shell (astra 19c). The account follows the key, not isAuthenticated: a key
 * replaced while signed in is a different account. Zustand calls this inside
 * the set() that changed the key, so it runs before anything renders for the
 * next account.
 */
export function onAccountChange(onChange: () => void): () => void {
  return useAuthStore.subscribe((s, prev) => {
    if (s.apiKey !== prev.apiKey) onChange();
  });
}

/**
 * Returns auth headers for API calls.
 * Call outside of React components (in fetch helpers, etc).
 */
export function getAuthHeaders(): Record<string, string> {
  const { apiKey } = useAuthStore.getState();
  if (apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {};
}
