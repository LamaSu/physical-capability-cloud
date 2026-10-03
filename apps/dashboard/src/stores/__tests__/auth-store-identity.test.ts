/**
 * Review r3 of #353: a cached protected read must not outlive the identity that made it.
 * onIdentityChange fires exactly when the signed-in identity changes (App clears the query
 * cache on it), and not on unrelated auth state.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

beforeAll(() => {
  // The store reads the saved key at creation; tests run without a browser.
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("onIdentityChange", () => {
  it("fires on sign-in, a different key, wallet or session, and sign-out; never on unrelated state", async () => {
    const { useAuthStore, onIdentityChange } = await import("../auth-store.js");
    let changes = 0;
    const stop = onIdentityChange(() => changes++);
    useAuthStore.setState({ apiKey: "k1", isAuthenticated: true });
    expect(changes).toBe(1);
    useAuthStore.getState().setVerifying(true);
    useAuthStore.getState().setError("x");
    expect(changes).toBe(1);
    useAuthStore.getState().setAddress("0xabc");
    useAuthStore.getState().setSession("token-1");
    useAuthStore.setState({ apiKey: "k2" });
    expect(changes).toBe(4);
    useAuthStore.getState().logout();
    expect(changes).toBe(5);
    stop();
    useAuthStore.setState({ apiKey: "k3" });
    expect(changes).toBe(5);
  });
});
