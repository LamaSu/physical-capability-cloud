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
 * EarnFromYourWorkPage sent the key it had just been issued to a hard-coded
 * origin: http://localhost:3200 in dev builds, and in production builds
 * https://capability.network even from staging.
 *
 * These render the real pages, record every fetch, and fail if a request
 * leaves the configured gateway (same origin here) or carries the key off it.
 * EarnFromYourWorkPage also shows the new key and, from the demo wallet
 * adapter, a recovery phrase: session recording (lib/telemetry.ts) must never
 * capture either, so both render only inside .ph-no-capture.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptApiKey } from "../../stores/auth-store.js";
import { SetupWizardPage } from "../SetupWizardPage.js";
import { SetupAgentPage } from "../SetupAgentPage.js";
import { EarnFromYourWorkPage } from "../EarnFromYourWorkPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const FRESH_KEY = ["pcc", "test", "fresh0123456789abcdef"].join("_");

interface Call {
  url: string;
  authorization: string | undefined;
}

let calls: Call[];
let container: HTMLDivElement;
let root: Root;
/** What the stubbed gateway answers, by path suffix; everything else gets the default. */
let replies: Record<string, unknown>;

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
  replies = {};
  // jsdom does not implement scrolling; the chat page scrolls to its last message.
  Element.prototype.scrollIntoView = () => {};
  adoptApiKey("pcc_test_secret_key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, authorization: headerOf(init, "Authorization") });
      const reply = Object.entries(replies).find(([path]) => url.endsWith(path))?.[1];
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => reply ?? { status: "ok", devices: [] },
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
  vi.unstubAllEnvs();
  adoptApiKey(null);
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

async function clickButton(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(button, `the "${text}" button`).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
}

/** Type into a React-controlled input the way a user would. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Every text node on the page whose trimmed text is exactly `text`. */
function textNodes(text: string): Node[] {
  const out: Node[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim() === text) out.push(n);
  return out;
}

/** `text` is on the page, and only inside an element session recording and autocapture skip. */
function expectHiddenFromRecording(text: string) {
  const nodes = textNodes(text);
  expect(nodes.length, `"${text.slice(0, 12)}…" is shown`).toBeGreaterThan(0);
  for (const n of nodes) expect(n.parentElement!.closest(".ph-no-capture"), "session recording never sees it").not.toBeNull();
}

function quickstartReply(apiKey: string, mnemonic: string | null) {
  return {
    apiKey,
    keyId: "key-1",
    walletAddress: "0xabc0000000000000000000000000000000000001",
    walletProvider: "privy",
    walletProviderUserId: "u-1",
    mnemonic,
    mnemonicWarning: null,
    scheduleHash: "0xhash",
    ratePercent: 10,
    bps: 1000,
    role: "developer",
    contributionDescription: null,
    profileId: "p-1",
    links: { viewSchedule: "/x", addUsdc: "/y", agentPackage: "/z" },
  };
}

/** Fill in the Earn form and submit it. */
async function submitEarnForm() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <EarnFromYourWorkPage />
      </MemoryRouter>,
    );
  });
  await flush();
  const email = container.querySelector('input[type="email"]') as HTMLInputElement | null;
  expect(email, "the email field").not.toBeNull();
  await typeInto(email!, "maker@example.com");
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
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
    expect(call!.authorization).toBe("Bearer pcc_test_secret_key");
  });

  it("SetupAgentPage sends the photo and the device registration to the configured gateway", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SetupAgentPage />
        </MemoryRouter>,
      );
    });
    await flush();
    await clickButton("Take or upload a photo");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input, "the photo input").not.toBeNull();
    const photo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "machine.png", { type: "image/png" });
    Object.defineProperty(input!, "files", { value: [photo] });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await clickButton("Identify This Machine");
    await clickButton("Confirm Configuration");
    expectNoKeyLeak();
    for (const path of ["/api/ai/identify-machine", "/api/setup/register-device"]) {
      const call = calls.find((c) => c.url.endsWith(path));
      expect(call, path).toBeDefined();
      expect(call!.url).toBe(path);
      expect(call!.authorization).toBe("Bearer pcc_test_secret_key");
    }
  });

  it("with a gateway configured, SetupAgentPage sends the key there and nowhere else", async () => {
    vi.stubEnv("VITE_PCC_URL", "https://gw.example.com");
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SetupAgentPage />
        </MemoryRouter>,
      );
    });
    await flush();
    await clickButton("Scan network");
    const keyed = calls.filter((c) => c.authorization);
    expect(keyed.map((c) => c.url)).toEqual(["https://gw.example.com/api/setup/scan-network"]);
  });

  it("EarnFromYourWorkPage sends the key it was just issued only to the gateway that issued it", async () => {
    const fresh = FRESH_KEY;
    replies["/api/contributors/quickstart"] = quickstartReply(fresh, null);
    adoptApiKey(null);
    vi.stubGlobal("alert", vi.fn());
    await submitEarnForm();
    const quickstart = calls.find((c) => c.url.endsWith("/api/contributors/quickstart"));
    expect(quickstart, "quickstart request").toBeDefined();
    expect(quickstart!.url).toBe("/api/contributors/quickstart");
    expect(quickstart!.authorization).toBeUndefined();
    expectHiddenFromRecording(fresh);

    await clickButton("Add $20 USDC");
    expectNoKeyLeak();
    const onramp = calls.find((c) => c.url.endsWith("/api/fiat-ramp/onramp/session"));
    expect(onramp, "onramp request").toBeDefined();
    expect(onramp!.url).toBe("/api/fiat-ramp/onramp/session");
    expect(onramp!.authorization).toBe(`Bearer ${fresh}`);
  });

  it("EarnFromYourWorkPage keeps the recovery words out of session recording", async () => {
    const words = "zebra zoo wrist yard yellow young zone vapor vendor vivid walnut wasp".split(" ");
    replies["/api/contributors/quickstart"] = quickstartReply(FRESH_KEY, words.join(" "));
    adoptApiKey(null);
    await submitEarnForm();
    expect(container.textContent).toContain("it's your wallet key");
    for (const w of words) expectHiddenFromRecording(w);
  });
});
