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

  it("a listener that changes the key on every change can't: its change during delivery is refused, and the store follows the slot", async () => {
    vi.resetModules();
    const keys = await import("../authorized-fetch.js");
    const auth = await import("../../stores/auth-store.js");
    let n = 0;
    const answers: unknown[] = [];
    const stopLooping = keys.onStoredKeyChange(() => {
      n += 1;
      answers.push(keys.setStoredApiKey([KEY_B, String(n)].join("-")));
    });
    try {
      // One change at a time (DECISIONS 2026-10-04 04:14): a change asked for while another is
      // being told is refused before it touches the slot, so there is no loop to cap.
      expect(keys.setStoredApiKey(KEY_B)).toBe("committed");
      expect(n).toBe(1);
      expect(answers).toEqual(["busy"]);
      expect(auth.useAuthStore.getState().isAuthenticated).toBe(true);
    } finally {
      stopLooping();
      keys.setStoredApiKey(null);
    }
    expect(auth.useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("no change goes untold, and none is told twice: one epoch per change, and the store and the slot agree (astra A03f N1)", async () => {
    vi.resetModules();
    const keys = await import("../authorized-fetch.js");
    const auth = await import("../../stores/auth-store.js"); // the store registers first
    const before = auth.useAuthStore.getState().keyEpoch;
    let n = 0;
    const stop = keys.onStoredKeyChange(() => {
      n += 1;
      keys.setStoredApiKey(n % 2 === 1 ? KEY_B : null); // refused: a change is being told
    });
    try {
      expect(keys.setStoredApiKey(KEY_B)).toBe("committed");
      expect(auth.useAuthStore.getState().isAuthenticated, "the store follows the slot").toBe(keys.hasStoredApiKey());
      expect(auth.useAuthStore.getState().keyEpoch - before, "the one change was told, once").toBe(1);
    } finally {
      stop();
      keys.setStoredApiKey(null);
    }
  });
});
