import { create } from "zustand";
import { fetchWithKey } from "../lib/gateway-base.js";

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

export const useAuthStore = create<AuthState>((set) => {
  // Hydrate API key from localStorage on store creation
  const storedKey = localStorage.getItem(STORAGE_KEY);

  return {
    // -- API Key auth --
    apiKey: storedKey,
    isAuthenticated: !!storedKey,

    login: async (key: string): Promise<boolean> => {
      try {
        // The candidate key goes to the configured gateway and nowhere else.
        const res = await fetchWithKey("/api/auth/validate", key);
        if (res.ok) {
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

/**
 * Legacy: returns the Authorization header without knowing where the request
 * goes. Use authorizedFetch (lib/authorized-fetch.ts), which attaches the key
 * only for the configured gateway. The startup egress guard stops the
 * remaining callers from carrying the key anywhere else, and
 * __tests__/no-direct-auth-headers.test.ts ratchets them out.
 */
export function getAuthHeaders(): Record<string, string> {
  const { apiKey } = useAuthStore.getState();
  if (apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {};
}
