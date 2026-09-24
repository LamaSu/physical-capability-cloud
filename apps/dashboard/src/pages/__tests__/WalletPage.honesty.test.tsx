/**
 * Wallet & Funding: no invented balances and no money action that only looks
 * like it worked.
 *
 * Before this change the page opened on a wallet balance, 2 pending deposits,
 * a total funded and 14,150 API credits that no route serves; listed six
 * invented ramp sessions and five credit-usage rows; quoted local-currency
 * amounts from hard-coded rates; and posted its card, bank, withdrawal and
 * credit forms with `.catch(() => {})` behind a 1.5 s spinner. The withdraw
 * form sent account numbers to /api/fiat-ramp/yellowcard/withdrawal, which the
 * gateway does not serve. The Funded Key tab called a simulated, keyless
 * wallet "usable" and offered real card funding into it.
 *
 * The real page renders with only `fetch` replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { WalletPage } from "../WalletPage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
}

function stubFetch(routes: Routes, fallback: Reply = "network-error") {
  const stub = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const reply = routes[pathOf(input)] ?? fallback;
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: reply.status === 200 ? "OK" : "Error",
      headers: { get: () => null },
      json: async () => reply.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

/** Every request the page made, as "METHOD /path". */
function requests(stub: ReturnType<typeof stubFetch>): string[] {
  return stub.mock.calls.map(([input, init]) => `${(init?.method ?? "GET").toUpperCase()} ${pathOf(input)}`);
}

// ── render harness ───────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

async function renderPage(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WalletPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return container.textContent ?? "";
}

function text(): string {
  return container.textContent ?? "";
}

function button(label: string | RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => {
    const t = (b.textContent ?? "").trim();
    return typeof label === "string" ? t === label : label.test(t);
  });
}

async function click(el: HTMLElement | undefined): Promise<void> {
  if (!el) throw new Error("element to click was not rendered");
  await act(async () => {
    el.click();
  });
  await settle();
}

function typeInto(input: Element | null | undefined, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error("input was not rendered");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Values the old page invented, as it rendered them.
const INVENTED = /14,150|1,234\.56|1234\.56|6,420|\$1\.00|1,617\.30|Settlement contract|0x91E6/;
const PROTOTYPE_ROWS = /fr_00\d|Agent job submission|323,460|1 USD = 100 credits/;
const MONEY_BUTTONS = /Fund via Stripe|Deposit via Yellowcard|Submit Withdrawal|Buy Credits|Configure Wise Payout/;

// ── production (demo mode off) ───────────────────────────────────────────────

describe("outside demo mode, with the gateway unreachable", () => {
  it("shows no invented balance, credits or exchange rate, and says the balance isn't live", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Your wallet balance isn't connected to live data yet");
    expect(t).toContain("GET /api/wallet/balance is not served");
    expect(t).not.toMatch(INVENTED);
    // No route serves balances or the viewer's sessions, so none is called.
    expect(requests(stub)).toEqual([]);
  });

  it("each money tab says what is missing and renders no fixtures", async () => {
    stubFetch({});
    await renderPage();
    const tabs: Array<[tab: string, heading: string, why: RegExp]> = [
      ["Fund Wallet", "Funding by card or bank transfer", /Stripe deposit route needs a wallet address/],
      ["Withdraw", "Withdrawal to a bank or mobile money", /\/api\/fiat-ramp\/yellowcard\/withdrawal, which the gateway doesn't serve/],
      ["API Credits", "API credits", /API credits are retired/],
      ["Activity", "Your funding activity", /every session in the gateway's memory, for all accounts/],
    ];
    for (const [tab, heading, why] of tabs) {
      await click(button(tab));
      expect(text()).toContain(`${heading} isn't connected to live data yet`);
      expect(text()).toMatch(why);
      expect(text()).not.toMatch(INVENTED);
      expect(text()).not.toMatch(PROTOTYPE_ROWS);
    }
  });

  it("offers no money action: no submit button, no account field, nothing sent", async () => {
    const stub = stubFetch({});
    await renderPage();
    for (const tab of ["Fund Wallet", "Withdraw", "API Credits", "Activity"]) {
      await click(button(tab));
      expect(text()).not.toMatch(MONEY_BUTTONS);
      // Nothing to type an amount, a name or an account number into.
      expect(container.querySelectorAll("input, select").length).toBe(0);
    }
    expect(requests(stub)).toEqual([]);
  });
});

// ── demo mode ────────────────────────────────────────────────────────────────

describe("demo mode (?demo=1)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/wallet?demo=1");
  });

  it("renders the prototype's sample values under the demo banner", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Demo data");
    expect(t).toContain("Wallet & Funding: sample values, not live PCC state.");
    expect(t).toContain("1234.56");
    expect(t).toContain("14,150");
    await click(button("Activity"));
    expect(text()).toContain("fr_001");
    await click(button("API Credits"));
    expect(text()).toContain("Agent job submission — kernel-03");
    expect(requests(stub)).toEqual([]);
  });

  it("its money buttons are disabled and send nothing, even with the form filled in", async () => {
    const stub = stubFetch({});
    await renderPage();

    typeInto(container.querySelector("input"), "100");
    const stripe = button("Fund via Stripe");
    expect(stripe?.disabled).toBe(true);
    await click(stripe);

    await click(button("Withdraw"));
    const [amount, holder, account] = [...container.querySelectorAll("input")];
    typeInto(amount, "100");
    typeInto(holder, "Ada Obi");
    typeInto(account, "0123456789");
    const submit = button("Submit Withdrawal");
    expect(submit?.disabled).toBe(true);
    await click(submit);

    expect(text()).toContain("Demo: this button doesn't submit anything.");
    expect(requests(stub)).toEqual([]);
  });
});

// ── Funded Key tab (live) ────────────────────────────────────────────────────

describe("Funded Key tab: shows what the gateway returns", () => {
  it("a simulated wallet is labelled, never called usable, and can't be funded by card", async () => {
    const stub = stubFetch({
      "/api/fiat-ramp/cdp/wallet": {
        status: 200,
        body: {
          walletAddress: "0x1111111111111111111111111111111111111111",
          network: "base-sepolia",
          smartAccount: true,
          mock: true,
          usableNow: true,
        },
      },
    });
    await renderPage();
    await click(button("Funded Key"));
    await click(button("Create wallet — no card"));
    expect(text()).toContain("0x1111111111111111111111111111111111111111");
    expect(text()).toContain("MOCK");
    expect(text()).toContain("Simulated wallet");
    expect(text()).not.toContain("Usable on PCC now");
    expect(button(/Add funds with a card/)).toBeUndefined();
    expect(requests(stub)).toEqual(["POST /api/fiat-ramp/cdp/wallet"]);
  });

  it("a real wallet links to the checkout URL the gateway returned", async () => {
    const checkout = "https://pay.coinbase.com/buy/select-asset?appId=app-123&defaultNetwork=base";
    const stub = stubFetch({
      "/api/fiat-ramp/cdp/wallet": {
        status: 200,
        body: { walletAddress: "0x2222222222222222222222222222222222222222", network: "base", smartAccount: true, mock: false },
      },
      "/api/fiat-ramp/coinbase/onramp": {
        status: 200,
        body: { provider: "coinbase", onrampUrl: checkout, walletAddress: "0x2222222222222222222222222222222222222222", mock: false },
      },
    });
    await renderPage();
    await click(button("Funded Key"));
    await click(button("Create wallet — no card"));
    expect(text()).toContain("Usable on PCC now");
    await click(button(/Add funds with a card/));
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Open card checkout"));
    expect(link?.getAttribute("href")).toBe(checkout);
    expect(requests(stub)).toEqual(["POST /api/fiat-ramp/cdp/wallet", "POST /api/fiat-ramp/coinbase/onramp"]);
  });

  it("a gateway error is shown with its reason, and no wallet appears", async () => {
    stubFetch({
      "/api/fiat-ramp/cdp/wallet": {
        status: 403,
        body: { error: "insufficient_scope", message: "This endpoint requires one of the following scopes: operator, admin." },
      },
    });
    await renderPage();
    await click(button("Funded Key"));
    await click(button("Create wallet — no card"));
    expect(text()).toContain("This endpoint requires one of the following scopes: operator, admin.");
    expect(text()).not.toContain("Usable on PCC now");
    expect(button("Create wallet — no card")).toBeDefined();
  });
});
