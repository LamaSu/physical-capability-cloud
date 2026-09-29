/**
 * The URL decides what renders.
 *
 * Renders the real <App /> (BrowserRouter, real shells, real pages) at a
 * given address with `fetch` stubbed to fail, and checks which surface
 * appears. On master:
 * - the default in-memory mode was "spatial", so every signed-in URL
 *   (/dashboard, /jobs/:id, /settings) rendered the empty spatial canvas;
 * - the sidebar's "Dashboard" item pointed at "/", the public landing;
 * - "Agent mode" rendered AgentChatPage, a showcase of hard-coded counts;
 * - /legacy/* rendered a shell whose routes never matched;
 * - a signed-in /login rendered the landing page.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // The spatial canvas and particles call into APIs jsdom lacks.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
});

async function settle() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

/** Settle until `text` appears (lazy pages load their chunk first), up to `ms`. */
async function waitForText(text: string, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((container.textContent ?? "").includes(text)) return true;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  return (container.textContent ?? "").includes(text);
}

async function renderAt(path: string, { signedIn }: { signedIn: boolean }) {
  window.history.replaceState(null, "", path);
  const { adoptApiKey } = await import("../stores/auth-store.js");
  adoptApiKey(signedIn ? "pcc_test_key" : null);
  const { App } = await import("../App.js");
  await act(async () => {
    root.render(<App />);
  });
  await settle();
  return {
    text: () => container.textContent ?? "",
    path: () => window.location.pathname,
    spatial: () => container.querySelector('[data-shell="spatial"]') !== null,
  };
}

const DASHBOARD_NAV_MARK = "Protocol Library"; // a sidebar item only the dashboard shell renders

describe("signed-in deep links open their page, not the spatial canvas", () => {
  // "Command Center" is also a sidebar group title, so these check each
  // page's own subtitle (setPageMeta), which only that page sets.
  it("/dashboard renders the dashboard shell and the Command Center page", async () => {
    const r = await renderAt("/dashboard", { signedIn: true });
    expect(r.text()).toContain(DASHBOARD_NAV_MARK);
    expect(await waitForText("System overview and active operations")).toBe(true);
    expect(r.spatial()).toBe(false);
  });

  it("/jobs/:id renders that job's page inside the dashboard shell", async () => {
    const r = await renderAt("/jobs/job-123", { signedIn: true });
    expect(r.text()).toContain(DASHBOARD_NAV_MARK);
    expect(await waitForText("Job progress, evidence, and escrow details")).toBe(true);
    expect(r.text()).toContain("Back to jobs");
    expect(r.spatial()).toBe(false);
  });

  it("/settings renders the settings page", async () => {
    const r = await renderAt("/settings", { signedIn: true });
    expect(r.text()).toContain(DASHBOARD_NAV_MARK);
    expect(r.text()).toContain("Settings");
  });

  it("an unknown app path says so instead of rendering a blank area", async () => {
    const r = await renderAt("/no-such-page", { signedIn: true });
    expect(r.text()).toContain("Page not found");
  });

  it.each(["/app/no-such-page", "/app/jobs/job-123"])(
    "%s is not a spatial page: it says Page not found (astra round 2, #354 finding 1)",
    async (path) => {
      const r = await renderAt(path, { signedIn: true });
      expect(r.spatial()).toBe(false);
      expect(r.text()).toContain("Page not found");
    },
  );
});

describe("one account's cached reads never reach the next (astra round 2, #354 finding 3)", () => {
  it("signing out and in as someone else shows only the new account's jobs", async () => {
    const jobsFor: Record<string, string> = { pcc_test_key: "job-first-account", pcc_test_key_b: "job-second-account" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("/api/jobs")) throw new TypeError("Failed to fetch");
        const key = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /, "");
        const id = jobsFor[key];
        return new Response(JSON.stringify({ jobs: id ? [{ id, status: "in_progress", capabilityId: "cap-1" }] : [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const r = await renderAt("/jobs", { signedIn: true });
    expect(await waitForText("job-first-account")).toBe(true);

    const { adoptApiKey } = await import("../stores/auth-store.js");
    await act(async () => adoptApiKey(null));
    await settle();
    expect(r.text()).not.toContain("job-first-account");

    await act(async () => adoptApiKey("pcc_test_key_b"));
    expect(await waitForText("job-second-account")).toBe(true);
    expect(r.text()).not.toContain("job-first-account");
  });
});

describe("workspaces have addresses", () => {
  it("/app renders the spatial workspace", async () => {
    const r = await renderAt("/app", { signedIn: true });
    expect(r.spatial()).toBe(true);
  });

  it("/app does not call itself a limited fallback (product-qa #21; launch owns the copy)", async () => {
    const r = await renderAt("/app", { signedIn: true });
    expect(r.text()).not.toMatch(/limited web interface|better interface than this/);
  });

  it("/agent renders the live agent conversation, not the retired showcase", async () => {
    const r = await renderAt("/agent", { signedIn: true });
    expect(r.text()).toContain("PCC agent");
    expect(r.text()).toContain("What do you need?");
    // AgentChatPage's hard-coded network counts and bounties
    expect(r.text()).not.toMatch(/Explore the Network|Electron Beam Welding|BioLab SF|12,438/);
  });

  it("the mode toggle navigates: dashboard -> spatial -> agent -> dashboard", async () => {
    const r = await renderAt("/dashboard", { signedIn: true });
    const toggle = () => container.querySelector<HTMLButtonElement>("button[data-workspace]")!;

    expect(toggle().dataset.workspace).toBe("dashboard");
    await act(async () => toggle().click());
    await settle();
    expect(r.path()).toBe("/app");
    expect(r.spatial()).toBe(true);

    await act(async () => toggle().click());
    await settle();
    expect(r.path()).toBe("/agent");
    expect(r.text()).toContain("PCC agent");

    await act(async () => toggle().click());
    await settle();
    expect(r.path()).toBe("/dashboard");
    expect(r.text()).toContain(DASHBOARD_NAV_MARK);
  });
});

describe("redirects", () => {
  it("/legacy/* goes to the page's current address", async () => {
    const r = await renderAt("/legacy/jobs", { signedIn: true });
    expect(r.path()).toBe("/jobs");
    expect(r.text()).toContain(DASHBOARD_NAV_MARK);
  });

  it("/spatial goes to /app, the spatial workspace's one address", async () => {
    const r = await renderAt("/spatial", { signedIn: true });
    expect(r.path()).toBe("/app");
    expect(r.spatial()).toBe(true);
  });

  it("a signed-in /login goes to the app home, not the landing page", async () => {
    const r = await renderAt("/login", { signedIn: true });
    expect(r.path()).toBe("/dashboard");
    expect(r.text()).toContain(DASHBOARD_NAV_MARK);
  });

  it("a signed-out app path asks for an API key", async () => {
    const r = await renderAt("/jobs", { signedIn: false });
    expect(container.querySelector('input[placeholder="pcc_..."]')).not.toBeNull();
    expect(r.text()).not.toContain(DASHBOARD_NAV_MARK);
  });
});

describe("navigation config", () => {
  it("the sidebar's Dashboard item points at /dashboard, not the public landing", async () => {
    const { navGroups } = await import("../components/nav-config.js");
    const items = navGroups.flatMap((g) => g.items);
    expect(items.find((i) => i.label === "Dashboard")?.path).toBe("/dashboard");
    expect(items.some((i) => i.path === "/")).toBe(false);
  });
});
