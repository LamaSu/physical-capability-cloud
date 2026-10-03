/**
 * Review r3 of #353: a cached protected read must not outlive the identity that made it.
 * onIdentityChange fires exactly when the signed-in identity changes (App clears the query
 * cache on it), and not on unrelated auth state. With N50 (#368) the key is never in the
 * store, so keys go in through adoptApiKey, and a key change shows as keyEpoch.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

beforeAll(() => {
  // The store reads the saved key at creation; tests run without a browser.
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("onIdentityChange", () => {
  it("fires on sign-in, a different key, wallet or session, and sign-out; never on unrelated state", async () => {
    const { useAuthStore, onIdentityChange, adoptApiKey } = await import("../auth-store.js");
    let changes = 0;
    const stop = onIdentityChange(() => changes++);
    adoptApiKey("pcc_test_identity_k1");
    expect(changes).toBe(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    useAuthStore.getState().setVerifying(true);
    useAuthStore.getState().setError("x");
    expect(changes).toBe(1);
    useAuthStore.getState().setAddress("0xabc");
    useAuthStore.getState().setSession("token-1");
    adoptApiKey("pcc_test_identity_k2");
    expect(changes).toBe(4);
    useAuthStore.getState().logout();
    expect(changes).toBe(5);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    stop();
    adoptApiKey("pcc_test_identity_k3");
    expect(changes).toBe(5);
    // The identity signal is a counter, never the key (N50).
    expect(Object.values(useAuthStore.getState()).some((v) => typeof v === "string" && v.startsWith("pcc_"))).toBe(false);
  });
});
