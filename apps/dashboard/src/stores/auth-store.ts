import { create } from "zustand";
import { fetchWithKey, gatewayUrl } from "../lib/gateway-base.js";
import { authorizedFetch, hasStoredApiKey, onStoredKeyChange, setStoredApiKey } from "../lib/authorized-fetch.js";
import { configureSessionKeyRecovery } from "../lib/session-key-recovery.js";

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
  signOutWallet: () => Promise<void>;
  mintSessionKey: () => Promise<boolean>;

  // -- Wallet/SIWE auth (secondary, for on-chain features) --
  /** Connected wallet address */
  address: string | null;
  /** Session token from SIWE verification */
  sessionToken: string | null;
  sessionEpoch: number;
  /** Volatile metadata; the credential remains in authorized-fetch. */
  sessionKeyId: string | null;
  sessionKeyExpiresAt: string | null;
  authNotice: string | null;
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
    // The key change below clears the wallet fields in the same set(), so the
    // identity change is reported once (onIdentityChange).
    if (useAuthStore.getState().sessionKeyId) {
      void signOutWallet();
    } else {
      adoptApiKey(null);
    }
  },
  signOutWallet,
  mintSessionKey: () => mintSessionKey(false),

  // -- Wallet/SIWE auth --
  address: null,
  sessionToken: null,
  sessionEpoch: 0,
  sessionKeyId: null,
  sessionKeyExpiresAt: null,
  authNotice: null,
  isVerifying: false,
  error: null,

  setAddress: (address) => set({ address, error: null }),
  setSession: (token) => set((s) => ({ sessionToken: token, sessionEpoch: s.sessionEpoch + (s.sessionToken === token ? 0 : 1), isVerifying: false })),
  setVerifying: (v) => set({ isVerifying: v }),
  setError: (e) => set({ error: e, isVerifying: false }),
}));

// Every change of the stored key is an identity change, whoever makes it
// (astra A03d N1). setStoredApiKey() is exported, so a module that called it
// directly used to replace the key behind onIdentityChange: reads cached
// under the previous key survived while authorizedFetch sent the new one. Now
// the key's owner reports each change, and this one set() follows it: the
// epoch moves, isAuthenticated follows the key, and a sign-out clears the
// wallet session's fields with it. Every change counts, even to the same key:
// telling "same key" from "another key" would make this an equality test on
// the stored key.
onStoredKeyChange(() => {
  if (renewalTimer !== undefined) clearTimeout(renewalTimer);
  renewalTimer = undefined;
  const signedIn = hasStoredApiKey();
  useAuthStore.setState((s) => ({
    isAuthenticated: signedIn,
    keyEpoch: s.keyEpoch + 1,
    sessionKeyId: null,
    sessionKeyExpiresAt: null,
    authNotice: null,
    ...(signedIn ? {} : { address: null, sessionToken: null, sessionEpoch: s.sessionEpoch + 1, error: null }),
  }));
});

let renewalTimer: ReturnType<typeof setTimeout> | undefined;
let mintFlight: Promise<boolean> | null = null;
let mintKeyEpoch = -1;
let mintSessionEpoch = -1;
let signOutFlight: Promise<void> | null = null;
let signingOut = false;

function scheduleRenewal(expiresAt: string): void {
  const delay = Date.parse(expiresAt) - Date.now() - 5 * 60 * 1000;
  // Do not spin if a session is already within its final five minutes.
  if (delay > 0) renewalTimer = setTimeout(() => { void mintSessionKey(true); }, delay);
}

function mintSessionKey(checkSession: boolean): Promise<boolean> {
  const state = useAuthStore.getState();
  if (signingOut || !state.sessionToken || (hasStoredApiKey() && !state.sessionKeyId)) return Promise.resolve(false);
  if (mintFlight && mintKeyEpoch === state.keyEpoch && mintSessionEpoch === state.sessionEpoch) return mintFlight;
  const epoch = state.keyEpoch;
  const session = state.sessionToken;
  const sessionEpoch = state.sessionEpoch;
  const current = () => !signingOut && useAuthStore.getState().keyEpoch === epoch && useAuthStore.getState().sessionEpoch === sessionEpoch && useAuthStore.getState().sessionToken === session;
  mintKeyEpoch = epoch;
  mintSessionEpoch = sessionEpoch;
  const flight = (async () => {
    try {
      if (checkSession) {
        const me = await fetch(gatewayUrl("/api/auth/me"), { credentials: "include" });
        if (!current()) return false;
        const data = me.ok ? await me.json().catch(() => null) : null;
        if (!current()) return false;
        if (!me.ok || typeof data?.address !== "string" || !state.address || data.address.toLowerCase() !== state.address.toLowerCase()) {
          if (me.status === 401 || me.status === 403 || me.ok) {
            adoptApiKey(null);
            useAuthStore.setState({ authNotice: "Please sign in again to continue." });
          } else {
            useAuthStore.setState({ authNotice: "Your wallet is signed in. Operator access is temporarily unavailable; try again shortly." });
          }
          return false;
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(gatewayUrl("/api/auth/session-key"), {
          method: "POST",
          credentials: "include",
        });
        const data = await response.json().catch(() => ({}));
        if (!current()) return false;
        if (response.status === 201 && typeof data.api_key === "string" && typeof data.key_id === "string" && typeof data.expires_at === "string" && Number.isFinite(Date.parse(data.expires_at))) {
          adoptApiKey(data.api_key, false);
          useAuthStore.setState({ sessionKeyId: data.key_id, sessionKeyExpiresAt: data.expires_at, authNotice: null });
          scheduleRenewal(data.expires_at);
          return true;
        }
        if (response.status === 500 && data.error === "provision_failed" && attempt === 0) continue;
        const notice = data.error === "too_many_keys"
          ? "Your wallet is signed in. You have reached the active-key limit; remove an unused key to enable operator actions."
          : data.error === "session_required" || data.error === "api_key_required"
            ? "Your wallet is signed in. Sign in again to enable operator actions."
            : "Your wallet is signed in. Operator access is temporarily unavailable; try again shortly.";
        useAuthStore.setState({ authNotice: notice });
        return false;
      }
    } catch {
      if (current()) useAuthStore.setState({ authNotice: "Your wallet is signed in. Operator access is temporarily unavailable; try again shortly." });
    }
    return false;
  })().finally(() => { if (mintFlight === flight) mintFlight = null; });
  mintFlight = flight;
  return flight;
}

function signOutWallet(): Promise<void> {
  if (signOutFlight) return signOutFlight;
  signingOut = true;
  if (renewalTimer !== undefined) clearTimeout(renewalTimer);
  renewalTimer = undefined;
  const keyId = useAuthStore.getState().sessionKeyId;
  signOutFlight = (async () => {
    try {
      if (keyId) {
        try {
          await authorizedFetch(`/api/auth/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
        } catch { /* Continue signing out when revocation is unavailable. */ }
      }
      try {
        await fetch(gatewayUrl("/api/auth/logout"), { method: "POST", credentials: "include" });
      } catch { /* Clear local credentials even when the gateway is unavailable. */ }
    } finally {
      adoptApiKey(null);
      signingOut = false;
    }
  })().finally(() => { signOutFlight = null; });
  return signOutFlight;
}

configureSessionKeyRecovery({
  isActive: () => !signingOut && !!useAuthStore.getState().sessionKeyId,
  identity: () => useAuthStore.getState().sessionEpoch,
  renew: () => mintSessionKey(true),
});

/**
 * Hold `key` as the signed-in key, or sign out with null. login() calls it
 * after the gateway accepts the key; tests call it directly. It is
 * write-only: writing a key cannot leak one.
 */
export function adoptApiKey(key: string | null, persist = true): void {
  setStoredApiKey(key, persist);
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
