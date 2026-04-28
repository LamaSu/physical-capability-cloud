import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setPluginForTests,
  getApiKey,
  getRole,
  isNative,
  migrateLegacyApiKey,
  removeApiKey,
  setApiKey,
  setRole,
} from "./secure-api-key.js";

interface FakeStore {
  data: Map<string, string>;
}

function fakePlugin(store: FakeStore) {
  return {
    get: vi.fn(async ({ key }: { key: string }) => {
      const value = store.data.get(key);
      if (value === undefined) {
        throw new Error("not found");
      }
      return { value };
    }),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.data.set(key, value);
      return { value: true };
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      const had = store.data.delete(key);
      if (!had) throw new Error("not found");
      return { value: true };
    }),
    keys: vi.fn(async () => ({ value: Array.from(store.data.keys()) })),
    clear: vi.fn(async () => {
      store.data.clear();
      return { value: true };
    }),
  };
}

beforeEach(() => {
  // Reset Capacitor + localStorage between tests
  (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  };
  _setPluginForTests(null);
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

afterEach(() => {
  _setPluginForTests(null);
});

function setNativeWithPlugin(): { store: FakeStore } {
  const store: FakeStore = { data: new Map() };
  (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
  };
  _setPluginForTests(fakePlugin(store));
  return { store };
}

describe("isNative", () => {
  it("returns false in plain PWA mode", () => {
    expect(isNative()).toBe(false);
  });

  it("returns true when Capacitor reports native platform", () => {
    setNativeWithPlugin();
    expect(isNative()).toBe(true);
  });
});

describe("PWA fallback (localStorage)", () => {
  it("returns null when nothing stored", async () => {
    expect(await getApiKey()).toBeNull();
  });

  it("setApiKey + getApiKey round-trips via localStorage", async () => {
    await setApiKey("pcc_live_test123");
    expect(localStorage.getItem("pcc-api-key")).toBe("pcc_live_test123");
    expect(await getApiKey()).toBe("pcc_live_test123");
  });

  it("removeApiKey clears localStorage", async () => {
    await setApiKey("pcc_live_test123");
    await removeApiKey();
    expect(await getApiKey()).toBeNull();
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });

  it("getRole defaults to 'user'", async () => {
    expect(await getRole()).toBe("user");
  });

  it("setRole + getRole round-trips", async () => {
    await setRole("operator");
    expect(await getRole()).toBe("operator");
    await setRole("user");
    expect(await getRole()).toBe("user");
  });

  it("getRole returns 'user' for invalid stored values", async () => {
    localStorage.setItem("pcc-role", "garbage");
    expect(await getRole()).toBe("user");
  });
});

describe("Native storage (Capacitor)", () => {
  it("setApiKey writes to native and not to localStorage", async () => {
    const { store } = setNativeWithPlugin();
    await setApiKey("pcc_live_native");
    expect(store.data.get("pcc-api-key")).toBe("pcc_live_native");
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });

  it("getApiKey reads from native", async () => {
    const { store } = setNativeWithPlugin();
    store.data.set("pcc-api-key", "pcc_live_native");
    expect(await getApiKey()).toBe("pcc_live_native");
  });

  it("getApiKey returns null when key absent in native", async () => {
    setNativeWithPlugin();
    expect(await getApiKey()).toBeNull();
  });

  it("removeApiKey clears both native and localStorage", async () => {
    const { store } = setNativeWithPlugin();
    store.data.set("pcc-api-key", "pcc_live_native");
    localStorage.setItem("pcc-api-key", "stale_localstorage");
    await removeApiKey();
    expect(store.data.has("pcc-api-key")).toBe(false);
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });

  it("setApiKey on native ALSO clears any legacy localStorage copy", async () => {
    const { store } = setNativeWithPlugin();
    localStorage.setItem("pcc-api-key", "stale");
    await setApiKey("fresh");
    expect(store.data.get("pcc-api-key")).toBe("fresh");
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });

  it("setRole writes to native and to localStorage (WebView readable)", async () => {
    const { store } = setNativeWithPlugin();
    await setRole("operator");
    expect(store.data.get("pcc-role")).toBe("operator");
    // Role is also kept in localStorage on native so the WebView at
    // /operator/mobile can read it without round-tripping through the
    // Capacitor bridge.
    expect(localStorage.getItem("pcc-role")).toBe("operator");
  });

  it("getRole prefers native value over localStorage", async () => {
    const { store } = setNativeWithPlugin();
    store.data.set("pcc-role", "operator");
    localStorage.setItem("pcc-role", "user");
    expect(await getRole()).toBe("operator");
  });
});

describe("migrateLegacyApiKey", () => {
  it("returns 'pwa' when not running in Capacitor", async () => {
    expect(await migrateLegacyApiKey()).toBe("pwa");
  });

  it("returns 'no-key' when neither store has one", async () => {
    setNativeWithPlugin();
    expect(await migrateLegacyApiKey()).toBe("no-key");
  });

  it("returns 'already-native' when native has a key", async () => {
    const { store } = setNativeWithPlugin();
    store.data.set("pcc-api-key", "pcc_live_already_native");
    expect(await migrateLegacyApiKey()).toBe("already-native");
  });

  it("migrates a localStorage key to native storage", async () => {
    const { store } = setNativeWithPlugin();
    localStorage.setItem("pcc-api-key", "pcc_live_legacy");
    expect(await migrateLegacyApiKey()).toBe("migrated");
    expect(store.data.get("pcc-api-key")).toBe("pcc_live_legacy");
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });

  it("is idempotent", async () => {
    const { store } = setNativeWithPlugin();
    localStorage.setItem("pcc-api-key", "pcc_live_legacy");
    expect(await migrateLegacyApiKey()).toBe("migrated");
    // Second call: already in native
    expect(await migrateLegacyApiKey()).toBe("already-native");
    expect(store.data.get("pcc-api-key")).toBe("pcc_live_legacy");
  });

  it("clears stale localStorage on already-native", async () => {
    const { store } = setNativeWithPlugin();
    store.data.set("pcc-api-key", "pcc_live_native");
    localStorage.setItem("pcc-api-key", "pcc_live_stale");
    expect(await migrateLegacyApiKey()).toBe("already-native");
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });
});
