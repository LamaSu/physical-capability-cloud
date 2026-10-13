/**
 * astra A03d N1 (round 4): every change of the stored key is an identity
 * change. setStoredApiKey() is exported, because the store writes the key
 * through it, and a module that called it directly replaced the key behind
 * onIdentityChange: reads cached under the previous key survived, while
 * authorizedFetch sent the new one.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptApiKey, onIdentityChange, useAuthStore } from "../../stores/auth-store.js";
import { setStoredApiKey } from "../authorized-fetch.js";

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "r5identityA0123456789abcdef"].join("_");
const KEY_B = ["pcc", "test", "r5identityB0123456789abcdef"].join("_");

afterEach(() => {
  adoptApiKey(null);
});

describe("astra A03d N1: the key can't change behind the identity signal", () => {
  it("setStoredApiKey() called directly is an identity change (astra's reproduction)", () => {
    adoptApiKey(KEY_A);
    const onChange = vi.fn();
    const stop = onIdentityChange(onChange);
    try {
      setStoredApiKey(KEY_B);
      expect(onChange).toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("a key cleared directly signs the store out", () => {
    adoptApiKey(KEY_A);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    setStoredApiKey(null);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("a sign-out clears the wallet session's fields with the key, in one change", () => {
    adoptApiKey(KEY_A);
    useAuthStore.getState().setAddress("0xabc");
    useAuthStore.getState().setSession("siwe-token");
    const onChange = vi.fn();
    const stop = onIdentityChange(onChange);
    try {
      useAuthStore.getState().logout();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, address: null, sessionToken: null, error: null });
    } finally {
      stop();
    }
  });

  it("a key set directly signs the store in", () => {
    setStoredApiKey(KEY_A);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
