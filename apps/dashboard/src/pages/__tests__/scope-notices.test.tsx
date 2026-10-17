/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletPage } from "../WalletPage.js";
import { CdpFundedKeyOnramp } from "../../components/CdpFundedKeyOnramp.js";
import { DisputeModal } from "../../components/escrow/DisputeModal.js";
import { OperatorA2APage } from "../../routes/operator/OperatorA2APage.js";
import { SettlementPage } from "../SettlementPage.js";
import { NegotiationSessionPage } from "../NegotiationSessionPage.js";
import { RateSchedulePublishPage } from "../RateSchedulePublishPage.js";
import { EarnFromYourWorkPage } from "../EarnFromYourWorkPage.js";
import { scopeErrorMessage } from "../../lib/scope-notice.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FUNDS_NOTICE = "Moving funds needs a key issued by PCC; your wallet sign-in can do everything else.";
const CONTRIBUTOR_NOTICE = "Publishing a rate schedule needs your contributor key with schedule:publish permission.";
const ADDRESS = `0x${"1".repeat(40)}`;
const wallet = { walletAddress: ADDRESS, network: "base", smartAccount: true };
const permission = {
  permissionId: "permission-1", spender: ADDRESS, allowanceUSDC: 50,
  periodSec: 3600, expiresAt: "2030-01-01T00:00:00Z", revoked: false,
};
const quickstart = {
  apiKey: ["pcc", "test", "contributor0123456789"].join("_"), keyId: "contributor-1",
  walletAddress: ADDRESS, walletProvider: "privy", walletProviderUserId: "user-1",
  mnemonic: null, mnemonicWarning: null, scheduleHash: "schedule-1", ratePercent: 1.5,
  bps: 150, role: "integrator", contributionDescription: null, profileId: "profile-1",
  links: { viewSchedule: "/schedule", addUsdc: "/add", agentPackage: "/agent" },
};

let host: HTMLDivElement;
let root: Root;
let target: string;
let responseStatus: number;
let responseBody: Record<string, string>;
let calls: { path: string; method: string }[];
let alerts: string[];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  alerts = [];
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("alert", (text: string) => alerts.push(text));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (path === target) {
      return new Response(JSON.stringify(responseBody), { status: responseStatus });
    }
    const data = path === "/api/fiat-ramp/cdp/wallet" ? wallet
      : path === "/api/fiat-ramp/cdp/spend-permission" ? permission
      : path === "/api/contributors/quickstart" ? quickstart : {};
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

async function cdpWallet() {
  await mount(<CdpFundedKeyOnramp />);
  await click("Create wallet");
}

async function schedule() {
  await mount(<RateSchedulePublishPage />);
  await fill('input[placeholder="0x… (40 hex)"]', ADDRESS, 1);
}

type Action = { name: string; path: string; generic: string | null; run: () => Promise<void> };
const actions: Action[] = [
  { name: "WalletPage Stripe", path: "/api/fiat-ramp/stripe/onramp", generic: null, run: async () => {
    await mount(<WalletPage />); await fill('input[placeholder="100.00"]', "20"); await click("Fund via Stripe");
  } },
  { name: "WalletPage deposit", path: "/api/fiat-ramp/yellowcard/deposit", generic: null, run: async () => {
    await mount(<WalletPage />); await fill('input[placeholder="50.00"]', "20"); await click("Deposit via Yellowcard");
  } },
  { name: "WalletPage withdrawal", path: "/api/fiat-ramp/yellowcard/withdrawal", generic: null, run: async () => {
    await mount(<WalletPage />); await click("Withdraw");
    await fill('input[placeholder="100.00"]', "20"); await fill('input[placeholder="Full legal name"]', "Maker");
    await fill('input[placeholder="Account number or IBAN"]', "1234"); await click("Submit Withdrawal");
  } },
  { name: "CdpFundedKeyOnramp wallet", path: "/api/fiat-ramp/cdp/wallet", generic: "POST /api/fiat-ramp/cdp/wallet → 500", run: async () => {
    await mount(<CdpFundedKeyOnramp />); await click("Create wallet");
  } },
  { name: "CdpFundedKeyOnramp onramp", path: "/api/fiat-ramp/coinbase/onramp", generic: "POST /api/fiat-ramp/coinbase/onramp → 500", run: async () => {
    await cdpWallet(); await click("Add funds with a card");
  } },
  { name: "CdpFundedKeyOnramp permission", path: "/api/fiat-ramp/cdp/spend-permission", generic: "POST /api/fiat-ramp/cdp/spend-permission → 500", run: async () => {
    await cdpWallet(); await fill('input[placeholder="Agent address (0x…)"]', ADDRESS); await click("Issue scoped key");
  } },
  { name: "CdpFundedKeyOnramp revoke", path: "/api/fiat-ramp/cdp/spend-permission/permission-1", generic: "DELETE /api/fiat-ramp/cdp/spend-permission/permission-1 → 500", run: async () => {
    await cdpWallet(); await fill('input[placeholder="Agent address (0x…)"]', ADDRESS); await click("Issue scoped key"); await click("Revoke");
  } },
  { name: "DisputeModal", path: "/api/escrow/escrow-1/dispute", generic: "Service unavailable", run: async () => {
    await mount(<DisputeModal escrowId="escrow-1" onClose={() => {}} />); await fill("textarea", "Please review"); await click("File dispute");
  } },
  { name: "OperatorA2APage", path: "/api/escrow/fund", generic: "Escrow lock failed (500). Try again", run: async () => {
    await mount(<OperatorA2APage />);
    for (const value of ["Ti-6Al-4V", "4 × 4 × 6", "1", "Tuesday", '±0.001" precision']) {
      await fill('[data-testid="operator-field-input"]', value); await click("Send", '[data-testid="operator-field-submit"]');
    }
    await click("Lock $");
  } },
  { name: "SettlementPage", path: "/api/settlement/flush", generic: null, run: async () => {
    await mount(<SettlementPage />); await click("Flush 7 ops");
  } },
  { name: "RateSchedulePublishPage onramp", path: "/api/api/fiat-ramp/onramp/session", generic: "Service unavailable", run: async () => {
    await schedule(); await click("+ $20 USDC");
  } },
  { name: "EarnFromYourWorkPage onramp", path: "/api/fiat-ramp/onramp/session", generic: "Stripe onramp is in mock mode on this server", run: async () => {
    await mount(<EarnFromYourWorkPage />); await fill('input[type="email"]', "maker@example.com");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await click("Add $20 USDC");
  } },
];

function shown() { return `${host.textContent ?? ""}\n${alerts.join("\n")}`; }

async function resetView() {
  await act(async () => root.unmount());
  root = createRoot(host);
  vi.clearAllTimers();
  calls = [];
  alerts = [];
}

async function negotiationFailure(status: number) {
  await resetView();
  target = "/api/negotiate/session"; responseStatus = status;
  responseBody = { error: "insufficient_scope", message: "Request refused" };
  await mount(<NegotiationSessionPage />); await click("Create New Session");
  await fill('input[placeholder="user-agent@alpha.pcc"]', "agent-1"); await fill('input[placeholder="kern-001"]', "kernel-1");
  await fill('input[placeholder="fdm"]', "fdm"); await click("Create Session");
  expect(shown()).toContain(`HTTP ${status}`);
  expect(shown()).not.toContain(FUNDS_NOTICE);
}

describe("money action notices", () => {
  for (const action of actions) {
    it(`${action.name} uses the error code and preserves other failure feedback`, async () => {
      target = action.path; responseStatus = 500; responseBody = { error: "insufficient_scope", message: "Service unavailable" };
      await action.run();
      expect(shown()).not.toContain(FUNDS_NOTICE);
      if (action.generic) expect(shown()).toContain(action.generic);
      else expect(shown()).not.toContain("Service unavailable");

      await resetView();
      target = action.path; responseStatus = 403; responseBody = { error: "another_error", message: "insufficient_scope" };
      await action.run();
      expect(shown()).not.toContain(FUNDS_NOTICE);

      await resetView();
      target = action.path; responseStatus = 403; responseBody = { error: "insufficient_scope", message: "Request refused" };
      await action.run();
      expect(calls.some((call) => call.path === target && call.method !== "GET"), "requested action").toBe(true);
      expect(shown()).toContain(FUNDS_NOTICE);
      expect(shown().split(FUNDS_NOTICE)).toHaveLength(2);

      if (action.name === "WalletPage Stripe") {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          target = "/api/escrow/action";
          const response = await fetch(target, { method });
          expect(await scopeErrorMessage(response, target, method)).toBe(FUNDS_NOTICE);
          expect(await response.json()).toEqual(responseBody);
        }
        for (const [method, path] of [
          ["GET", "/api/escrow/action"],
          ["POST", "/api/escrow-report"],
          ["POST", "/api/fiat-rampish/action"],
          ["POST", "/api/settlement-plan"],
          ["POST", "/api/negotiate/session"],
        ]) {
          target = path;
          const response = await fetch(target, { method });
          expect(await scopeErrorMessage(response, path, method)).toBeNull();
        }
        await negotiationFailure(403);
        await negotiationFailure(500);
      }
    });
  }
});

describe("contributor feedback", () => {
  it("RateSchedulePublishPage names the contributor permission and keeps other publish failures", async () => {
    target = "/api/contributors/schedules"; responseStatus = 500; responseBody = { error: "insufficient_scope", message: "Service unavailable" };
    await schedule(); await click("Publish Schedule");
    expect(shown()).toContain("Service unavailable");
    expect(shown()).not.toContain(CONTRIBUTOR_NOTICE);

    await resetView();
    target = "/api/contributors/schedules"; responseStatus = 403; responseBody = { error: "insufficient_scope", message: "Request refused" };
    await schedule(); await click("Publish Schedule");
    expect(shown()).toContain(CONTRIBUTOR_NOTICE);
    expect(shown()).not.toContain(FUNDS_NOTICE);
  });
});
