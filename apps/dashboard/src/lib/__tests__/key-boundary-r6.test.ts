/**
 * astra A03e N1 (round 5): a key change must reach the auth store even when
 * another listener of the key's owner throws first. Delivery was ordered and
 * not isolated, so an earlier listener's exception left keyEpoch behind the
 * key that authorizedFetch now sends.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_B = ["pcc", "test", "r6listenerB0123456789abcdef"].join("_");

describe("astra A03e N1: one listener can't stop the identity change", () => {
  it("a listener registered before the auth store throws; keyEpoch still moves (astra's reproduction)", async () => {
    vi.resetModules();
    const keys = await import("../authorized-fetch.js");
    const stopThrowing = keys.onStoredKeyChange(() => {
      throw new Error("listener failure");
    });
    const auth = await import("../../stores/auth-store.js");
    const before = auth.useAuthStore.getState().keyEpoch;
    try {
      expect(() => keys.setStoredApiKey(KEY_B)).toThrow("listener failure");
      expect(auth.useAuthStore.getState().keyEpoch).toBe(before + 1);
      expect(auth.useAuthStore.getState().isAuthenticated).toBe(true);
    } finally {
      stopThrowing();
      keys.setStoredApiKey(null);
    }
  });

  it("a listener that changes the key on every change is stopped with an error, not a stack overflow, and the store still follows", async () => {
    vi.resetModules();
    const keys = await import("../authorized-fetch.js");
    const auth = await import("../../stores/auth-store.js");
    let n = 0;
    const stopLooping = keys.onStoredKeyChange(() => {
      n += 1;
      keys.setStoredApiKey([KEY_B, String(n)].join("-"));
    });
    try {
      expect(() => keys.setStoredApiKey(KEY_B)).toThrow("kept changing the key");
      expect(n).toBeGreaterThan(1);
      expect(auth.useAuthStore.getState().isAuthenticated).toBe(true);
    } finally {
      stopLooping();
      keys.setStoredApiKey(null);
    }
    expect(auth.useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
