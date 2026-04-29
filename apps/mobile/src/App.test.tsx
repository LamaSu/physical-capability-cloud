/**
 * Tests for App.tsx — mainly: the shell renders without crashing when
 * ApprovalSheet is mounted, and the dev-mode fake-trigger gates correctly.
 *
 * The Week 1 baseline did not include an App.test.tsx because the wiring
 * was trivial; Week 3 adds the ApprovalSheet hook so a smoke test is
 * worth having.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App.js";
import { setRole } from "./storage/secure-api-key.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
  // Default to user mode so the React shell renders (operator mode does
  // a window.location.replace which we don't want during a render test).
  await setRole("user");
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("App smoke", () => {
  it("renders the user shell without crashing", async () => {
    act(() => {
      root.render(<App />);
    });
    await flush();
    // Either UserMobilePage or the loading placeholder must render.
    expect(container.textContent ?? "").toMatch(
      /Your agent sessions live here|Loading/i,
    );
  });

  it("renders without an ApprovalSheet when no pending approval is set", async () => {
    act(() => {
      root.render(<App />);
    });
    await flush();
    // No ApprovalSheet should be in the DOM yet — the dev-mode trigger
    // either won't fire (jsdom default) or fires only after 3s. This
    // sub-second test catches it before that.
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).toBeNull();
  });

  it("renders ApprovalSheet when dev-mode trigger flag is set + timer elapses", async () => {
    vi.useFakeTimers();
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("pcc-mobile-dev-approval", "1");
    }
    act(() => {
      root.render(<App />);
    });
    // Let the role-load useEffect resolve
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Advance the dev-mode 3-second timer
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).not.toBeNull();
    vi.useRealTimers();
  });
});
