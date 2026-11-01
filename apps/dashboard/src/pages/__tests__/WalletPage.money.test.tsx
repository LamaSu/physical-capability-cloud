/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassPanel } from "@pcc/ui";
import { WalletPage } from "../WalletPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVITY_LABEL = "Your funding activity isn't shown here yet.";

let host: HTMLDivElement;
let root: Root;
let calls: { path: string; method: string }[];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    const data = method === "GET" && path === "/api/wallet/balance"
      ? { balance: "9,876.54", pendingDeposits: 7, totalFunded: "8,765.43", creditBalance: 76543 }
      : method === "GET" && path === "/api/fiat-ramp/sessions"
        ? { sessions: [
          { id: "fr_live_7f3a", provider: "stripe", direction: "deposit", amountUsd: "4321.09", status: "completed", createdAt: 1_700_000_000_000 },
          { id: "fr_live_9b2c", provider: "yellowcard", direction: "withdrawal", amountUsd: "65.43", amountLocal: "105,000", localCurrency: "NGN", status: "pending", createdAt: 1_700_000_060_000 },
        ] }
        : {};
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode) {
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
}

async function click(text: string, selector = "button") {
  const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find((b) => b.textContent?.includes(text));
  expect(button, `button ${text}`).toBeDefined();
  expect(button!.disabled, `button ${text} enabled`).toBe(false);
  await act(async () => button!.click());
}

async function fill(selector: string, value: string, index = 0) {
  const element = host.querySelectorAll(selector)[index] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  expect(element, selector).not.toBeNull();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function expectAbsent(text: string, values: string[]) {
  for (const value of values) {
    expect(text.includes(value), `unsupported text: ${value}`).toBe(false);
  }
}

function greenGlows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("*")]
    .filter((element) => element.style.boxShadow.includes("0, 255, 136"));
}

describe("WalletPage money", () => {
  it("T1 removes unverified balances and their reads", async () => {
    await mount(<WalletPage />);
    const text = host.textContent!;
    expect(text, "funding control present").toContain("Fund via Stripe");
    expectAbsent(text, [
      "Wallet Balance", "Pending Deposits", "Total Funded", "API Credits",
      "1,234.56", "6,420.00", "14,150", "9,876.54", "8,765.43", "76,543", "76543",
    ]);
    expect(calls.filter(({ path }) => path === "/api/wallet/balance" || path.startsWith("/api/credits/")), "no balance or credits reads").toEqual([]);
  });

  it("T2 shows only the activity label until N48's fix merges", async () => {
    await mount(<WalletPage />);
    await click("Activity");
    const text = host.textContent!;
    expect(text.split(ACTIVITY_LABEL).length, "activity label appears exactly once").toBe(2);
    expectAbsent(text, [
      "fr_live_", "4,321.09", "4321.09", "65.43", "105,000",
      "fr_001", "fr_002", "fr_003", "fr_004", "fr_005", "fr_006", "transactions",
    ]);
    expect(calls.filter(({ path }) => path === "/api/fiat-ramp/sessions"), "no sessions read").toEqual([]);
  });

  it("T3 keeps funding enabled without constant conversions", async () => {
    await mount(<WalletPage />);
    await fill('input[placeholder="50.00"]', "20");
    const text = host.textContent!;
    expect(text, "deposit control present").toContain("Deposit via Yellowcard");
    const deposit = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Deposit via Yellowcard");
    expect(deposit, "deposit button present").toBeDefined();
    expect(deposit!.disabled, "deposit enabled after amount entry").toBe(false);
    expectAbsent(text, ["1 USD =", "You pay", "32,346", "1,617.30"]);
    await fill("select", "1", 0);
    expect(host.textContent, "changed country has no constant conversion").not.toContain("129.50");
  });

  it("T4 keeps the withdrawal amount without unsupported summary values", async () => {
    await mount(<WalletPage />);
    await click("Withdraw");
    await fill('input[placeholder="100.00"]', "20");
    const text = host.textContent!;
    expect(text, "withdrawal amount control present").toContain("$20.00");
    expect(/fee/i.test(text), "unsupported summary wording removed").toBe(false);
    expectAbsent(text, ["You receive", "$19.70", "Converts to", "32,346"]);
  });

  it("T5 removes the withdrawal summary's green glow", async () => {
    await mount(<WalletPage />);
    await click("Withdraw");
    await fill('input[placeholder="100.00"]', "20");
    expect(host.textContent, "withdrawal amount control present").toContain("$20.00");
    const control = document.createElement("div");
    const controlRoot = createRoot(control);
    try {
      await act(async () => controlRoot.render(<GlassPanel glow="green" />));
      expect(greenGlows(control).length, "real GlassPanel green glow is detectable").toBe(1);
      expect(greenGlows(host).length, "wallet has no inline green glow").toBe(0);
    } finally {
      await act(async () => controlRoot.unmount());
    }
  });

  it("T6 retains the private key notice without network or contract claims", async () => {
    await mount(<WalletPage />);
    const text = host.textContent!;
    expect(text.split("No private keys shared").length, "private key notice appears exactly once").toBe(2);
    expectAbsent(text, ["All funds held", "Base L2", "Settlement contract", "on Base"]);
    expect(text, "factory address removed").not.toMatch(/91e6/i);
    await click("Withdraw");
    expect(host.textContent, "withdrawal KYC control present").toContain("KYC may be required for large amounts.");
    expect(host.textContent!.includes("on Base"), "withdrawal network claim removed").toBe(false);
  });

  it("T7 removes the Credits tab and purchase content", async () => {
    await mount(<WalletPage />);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.slice(0, 4).map((button) => button.textContent), "wallet tabs remain in order").toEqual(["Fund Wallet", "Withdraw", "Activity", "Funded Key"]);
    expect(buttons.filter((button) => button.textContent?.includes("Credits")), "no Credits button").toEqual([]);
    expectAbsent(host.textContent!, ["Buy Credits", "100 credits", "Recent Usage"]);
  });
});
