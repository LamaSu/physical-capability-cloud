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

// Tell React 18+ that act(...) calls are intentional. Without this flag
// React emits "current testing environment is not configured to support
// act(...)" warnings on every state transition during render-based tests
// (see ApprovalSheet.test.tsx). The flag is the documented way to enable
// act in non-RTL test runners.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
