/**
 * Demo mode: the only way fixture data may appear in the dashboard.
 *
 * A production surface never substitutes fixtures for real data (product
 * invariant 3). Some prototype pages have no live source yet. Those pages
 * show their fixtures only when the viewer asked for a demo, and they say so
 * on screen (components/DemoState.tsx). Otherwise they say they are not
 * connected to live data.
 *
 * Demo mode is on when either:
 *   - the build set VITE_PCC_DEMO=1 (a dedicated demo deployment), or
 *   - the viewer opened a page with ?demo=1, which lasts for this browser
 *     tab's session; ?demo=0 turns it off again.
 * It is never on by default, in development or in production.
 *
 * Fixtures live under src/demo/ and are imported only by code that checks
 * isDemoMode(). The no-production-mock test (src/__tests__) enforces that.
 */

const SESSION_KEY = "pcc-demo-mode";

function readSession(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSession(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(SESSION_KEY, "1");
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable: demo mode then lasts only while ?demo=1 is in the URL.
  }
}

function buildFlag(): boolean {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_PCC_DEMO === "1";
}

export function isDemoMode(): boolean {
  if (buildFlag()) return true;
  if (typeof window === "undefined") return false;
  const param = new URLSearchParams(window.location.search).get("demo");
  if (param === "1") {
    writeSession(true);
    return true;
  }
  if (param === "0") {
    writeSession(false);
    return false;
  }
  return readSession();
}

/** The current URL with demo mode switched on or off. */
export function demoModeHref(on: boolean): string {
  if (typeof window === "undefined") return on ? "?demo=1" : "?demo=0";
  const url = new URL(window.location.href);
  url.searchParams.set("demo", on ? "1" : "0");
  return url.pathname + url.search + url.hash;
}
