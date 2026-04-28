// Vitest setup — wires fake-indexeddb so the offline queue can be tested
// without a real browser, and stubs Capacitor's native bridge so the
// SecureStorage code path can be unit-tested in PWA-fallback mode.
import "fake-indexeddb/auto";

// Default to PWA-fallback (Capacitor.isNativePlatform() === false). Individual
// tests can override this by re-defining globalThis.Capacitor.
(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
  isNativePlatform: () => false,
  getPlatform: () => "web",
};
