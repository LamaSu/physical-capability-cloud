/**
 * N50: the setup pages must never send the user's API key anywhere but the
 * configured gateway.
 *
 * SetupWizardPage fetched http://localhost:3200/api/capabilities with the
 * Authorization header on every /setup load. SetupAgentPage defaulted every
 * key-bearing request (scan-network, identify-machine, register-device) to
 * http://localhost:3200. In production both handed a signed-in user's key to
 * whatever listens on port 3200 of their own machine.
 *
 * These render the real pages, record every fetch, and fail if a request
 * leaves the configured gateway (same origin here) or carries the key off it.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/auth-store.js";
import { SetupWizardPage } from "../SetupWizardPage.js";
import { SetupAgentPage } from "../SetupAgentPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  url: string;
  authorization: string | undefined;
}

let calls: Call[];
let container: HTMLDivElement;
let root: Root;

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const entries = Array.isArray(h) ? h : Object.entries(h as Record<string, string>);
  const hit = entries.find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit?.[1];
}

beforeEach(() => {
  calls = [];
  // jsdom does not implement scrolling; the chat page scrolls to its last message.
  Element.prototype.scrollIntoView = () => {};
  useAuthStore.setState({ apiKey: "pcc_test_secret_key", isAuthenticated: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, authorization: headerOf(init, "Authorization") });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ status: "ok", devices: [] }),
        text: async () => "",
      } as unknown as Response;
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useAuthStore.setState({ apiKey: null, isAuthenticated: false });
});

async function flush() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

/** Same-origin requests are relative ("/api/...") or on this document's origin. */
function isConfiguredGateway(url: string): boolean {
  if (url.startsWith("/")) return true;
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}

function expectNoKeyLeak() {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.url, "request left the configured gateway").not.toMatch(/localhost:3200|127\.0\.0\.1/);
    if (c.authorization) expect(isConfiguredGateway(c.url), `key sent to ${c.url}`).toBe(true);
  }
}

describe("N50: setup pages keep the API key on the configured gateway", () => {
  it("SetupWizardPage checks liveness on the configured gateway without the key", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SetupWizardPage />
        </MemoryRouter>,
      );
    });
    await flush();
    expectNoKeyLeak();
    const health = calls.find((c) => c.url.endsWith("/api/health"));
    expect(health, "liveness check").toBeDefined();
    expect(health!.authorization).toBeUndefined();
    expect(container.textContent ?? "").not.toContain("localhost:3200");
  });

  it("SetupAgentPage sends its key-bearing scan request to the configured gateway", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SetupAgentPage />
        </MemoryRouter>,
      );
    });
    await flush();
    const scan = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Scan network"));
    expect(scan, "the Scan network option").toBeDefined();
    await act(async () => {
      scan!.click();
    });
    await flush();
    expectNoKeyLeak();
    const call = calls.find((c) => c.url.endsWith("/api/setup/scan-network"));
    expect(call, "scan-network request").toBeDefined();
    expect(call!.url).toBe("/api/setup/scan-network");
  });
});
