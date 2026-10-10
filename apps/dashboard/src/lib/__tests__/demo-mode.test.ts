/**
 * Demo mode is opt-in only: never on by default, on with ?demo=1 for the
 * tab's session, off again with ?demo=0.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from "vitest";
import { demoModeHref, isDemoMode } from "../demo-mode.js";

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("isDemoMode", () => {
  it("is off by default", () => {
    window.history.replaceState(null, "", "/swf");
    expect(isDemoMode()).toBe(false);
  });

  it("turns on with ?demo=1 and stays on for the session", () => {
    window.history.replaceState(null, "", "/swf?demo=1");
    expect(isDemoMode()).toBe(true);
    window.history.replaceState(null, "", "/depin");
    expect(isDemoMode()).toBe(true);
  });

  it("turns off with ?demo=0", () => {
    window.history.replaceState(null, "", "/swf?demo=1");
    expect(isDemoMode()).toBe(true);
    window.history.replaceState(null, "", "/swf?demo=0");
    expect(isDemoMode()).toBe(false);
    window.history.replaceState(null, "", "/swf");
    expect(isDemoMode()).toBe(false);
  });

  it("ignores other values", () => {
    window.history.replaceState(null, "", "/swf?demo=true");
    expect(isDemoMode()).toBe(false);
  });
});

describe("demoModeHref", () => {
  it("keeps the path and other params", () => {
    window.history.replaceState(null, "", "/wallet?tab=fund#top");
    expect(demoModeHref(true)).toBe("/wallet?tab=fund&demo=1#top");
    expect(demoModeHref(false)).toBe("/wallet?tab=fund&demo=0#top");
  });
});
