/**
 * Secure storage for the PCC `pcc-api-key` Bearer token.
 *
 * Today the dashboard stores the API key in localStorage (see
 * apps/dashboard/src/stores/auth-store.ts). On a stolen-but-unlocked phone
 * that means full operator API access — the substrate's bearer-token model
 * leaks through the browser's web platform.
 *
 * This module wraps capacitor-secure-storage-plugin (Keychain on iOS,
 * EncryptedSharedPreferences on Android) with two important properties:
 *
 * 1. When running inside Capacitor (Capacitor.isNativePlatform() === true),
 *    reads/writes/migrates go through the native plugin. The localStorage
 *    copy is removed once migrated.
 * 2. When running as a plain PWA (no Capacitor bridge), falls back to
 *    localStorage so the existing PWA continues to work unchanged. This
 *    matches the v1 strategy of "PWA continues to function indefinitely"
 *    from 15-MOBILE-APP-FIRST-PRINCIPLES.md § 13 question 5.
 *
 * The first time the app launches under Capacitor with an existing
 * localStorage key, we migrate it: read from localStorage, write to native
 * SecureStorage, remove from localStorage. The dashboard's auth-store
 * remains the source of truth at runtime — this module is the durable
 * store under it.
 */

const STORAGE_KEY = "pcc-api-key";
const ROLE_KEY = "pcc-role";
/**
 * Week 4 passkey-verify mints an opaque session token. The mobile app
 * persists it under this key so subsequent requests (notably the Week 5
 * SSE approval listener) can authenticate. Stored in the same secure
 * store as the API key — secure-enclave on native, localStorage fallback
 * on PWA. Same dual-write semantics as `pcc-api-key`.
 */
const SESSION_TOKEN_KEY = "pcc-session-token";

export type Role = "user" | "operator";

interface SecureStoragePlugin {
  get(opts: { key: string }): Promise<{ value: string }>;
  set(opts: { key: string; value: string }): Promise<{ value: boolean }>;
  remove(opts: { key: string }): Promise<{ value: boolean }>;
  keys(): Promise<{ value: string[] }>;
  clear(): Promise<{ value: boolean }>;
}

interface CapacitorBridge {
  isNativePlatform: () => boolean;
  getPlatform?: () => string;
}

/**
 * Detect whether we're running inside a Capacitor native shell (iOS/Android)
 * or as a plain PWA in a browser. Reads `globalThis.Capacitor` defensively
 * because the tests stub it and there are environments where it's just
 * absent.
 */
export function isNative(): boolean {
  const cap = (globalThis as unknown as { Capacitor?: CapacitorBridge })
    .Capacitor;
  return !!cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform();
}

let _plugin: SecureStoragePlugin | null = null;
let _pluginLoadAttempted = false;

/**
 * Lazy-load the native plugin. Returns null when running as a plain PWA or
 * if the plugin import fails (e.g. tests without the package installed).
 */
async function getPlugin(): Promise<SecureStoragePlugin | null> {
  if (!isNative()) return null;
  if (_plugin) return _plugin;
  if (_pluginLoadAttempted) return _plugin;
  _pluginLoadAttempted = true;
  try {
    // dynamic import so the plain-PWA bundle doesn't drag the native plugin in
    const mod = await import(
      /* @vite-ignore */ "capacitor-secure-storage-plugin"
    );
    const candidate = (mod as { SecureStoragePlugin?: SecureStoragePlugin })
      .SecureStoragePlugin;
    if (candidate) {
      _plugin = candidate;
    }
  } catch {
    // Plugin not present (e.g. running outside Capacitor for the first time).
    // Fall through to the localStorage fallback.
  }
  return _plugin;
}

/**
 * For tests: inject a fake plugin and force isNative() detection.
 */
export function _setPluginForTests(p: SecureStoragePlugin | null): void {
  _plugin = p;
  _pluginLoadAttempted = true;
}

/**
 * Read the stored API key. Returns null if unset or if the secure store
 * threw (which is how the plugin signals "not found").
 */
export async function getApiKey(): Promise<string | null> {
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      try {
        const { value } = await plugin.get({ key: STORAGE_KEY });
        return value || null;
      } catch {
        return null;
      }
    }
  }
  // PWA fallback
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

/**
 * Write the API key. On native, the key persists in Keychain /
 * EncryptedSharedPreferences and is also removed from localStorage if
 * present (one-time migration cleanup). On PWA, falls back to
 * localStorage.
 */
export async function setApiKey(value: string): Promise<void> {
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      await plugin.set({ key: STORAGE_KEY, value });
      // Defensively also remove the legacy localStorage copy so it can't
      // leak via web inspectors.
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // localStorage may be disabled (private mode); fine.
        }
      }
      return;
    }
  }
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, value);
}

/**
 * Remove the API key everywhere we know about it.
 */
export async function removeApiKey(): Promise<void> {
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      try {
        await plugin.remove({ key: STORAGE_KEY });
      } catch {
        // Plugin throws if key absent; safe to ignore.
      }
    }
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }
}

/**
 * One-time migration: if running in Capacitor and there's a localStorage
 * key, copy it to secure storage and remove the localStorage entry.
 *
 * Idempotent — safe to call on every app launch.
 *
 * Returns:
 *   - "migrated" — moved from localStorage to native storage
 *   - "already-native" — native storage already has the key
 *   - "no-key" — neither store has a key
 *   - "pwa" — running as PWA, no migration needed
 */
export async function migrateLegacyApiKey(): Promise<
  "migrated" | "already-native" | "no-key" | "pwa"
> {
  if (!isNative()) return "pwa";
  const plugin = await getPlugin();
  if (!plugin) return "pwa"; // Plugin not loaded, treat as PWA fallback

  // Check native first
  try {
    const { value } = await plugin.get({ key: STORAGE_KEY });
    if (value) {
      // Already native; clear any leftover localStorage value as a
      // belt-and-braces cleanup.
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Ignore.
        }
      }
      return "already-native";
    }
  } catch {
    // Not present in native — keep going.
  }

  // Check localStorage for a legacy value
  if (typeof localStorage === "undefined") return "no-key";
  const legacy = localStorage.getItem(STORAGE_KEY);
  if (!legacy) return "no-key";

  await plugin.set({ key: STORAGE_KEY, value: legacy });
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
  return "migrated";
}

/**
 * Read the persisted role (user|operator). Defaults to "user" if absent or
 * if the stored value isn't a known role.
 */
export async function getRole(): Promise<Role> {
  let raw: string | null = null;
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      try {
        const { value } = await plugin.get({ key: ROLE_KEY });
        raw = value || null;
      } catch {
        raw = null;
      }
    }
  }
  if (raw === null && typeof localStorage !== "undefined") {
    raw = localStorage.getItem(ROLE_KEY);
  }
  if (raw === "operator" || raw === "user") return raw;
  return "user";
}

/**
 * Read the persisted Week-4 passkey session token, if any. Returns null
 * when no token has been minted yet (i.e. user has never approved on
 * this device, or the token was cleared on logout).
 *
 * Same dual-store semantics as `getApiKey`: native secure storage when
 * running inside Capacitor, localStorage fallback on PWA.
 */
export async function getSessionToken(): Promise<string | null> {
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      try {
        const { value } = await plugin.get({ key: SESSION_TOKEN_KEY });
        return value || null;
      } catch {
        return null;
      }
    }
  }
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(SESSION_TOKEN_KEY);
}

/** Write the Week-4 passkey session token. Mirrors setApiKey semantics. */
export async function setSessionToken(value: string): Promise<void> {
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      await plugin.set({ key: SESSION_TOKEN_KEY, value });
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.removeItem(SESSION_TOKEN_KEY);
        } catch {
          /* ignore */
        }
      }
      return;
    }
  }
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SESSION_TOKEN_KEY, value);
}

/** Remove the persisted Week-4 passkey session token everywhere. */
export async function removeSessionToken(): Promise<void> {
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      try {
        await plugin.remove({ key: SESSION_TOKEN_KEY });
      } catch {
        /* ignore — plugin throws if key absent */
      }
    }
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(SESSION_TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Persist the role. Same dual-write semantics as setApiKey except we keep
 * the role in localStorage too on native because the WebView (which loads
 * /operator/mobile) needs to read it as well; the native shell and the
 * dashboard share the role through the URL + a localStorage-readable copy
 * is acceptable for non-secret state.
 */
export async function setRole(role: Role): Promise<void> {
  if (isNative()) {
    const plugin = await getPlugin();
    if (plugin) {
      await plugin.set({ key: ROLE_KEY, value: role });
    }
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(ROLE_KEY, role);
  }
}
