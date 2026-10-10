/**
 * Negotiations: no invented proposals, floors or timelines presented as the
 * operator's own, and no control that only pretends to act.
 *
 * Before this change the page always rendered three hard-coded proposals (an
 * $18.50 Prusa MK4 print from user-agent@alpha.pcc, a $42.00 Epilog laser cut,
 * a countered $12.00 print), three price floors and two negotiation timelines
 * as the operator's own state. Accept, Counter, Reject, the split presets and
 * the floor controls changed only local state, so a click read as done. No
 * gateway route serves any of it: nothing lists priced proposals or counters
 * one, nothing stores a default split or price floors, and negotiation
 * sessions are read one at a time by ID. The page now says so outside demo
 * mode and makes no request; in demo mode it shows its samples under a banner
 * with every control that would change PCC state disabled.
 *
 * The real page renders with the real providers; only `fetch` is replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { NegotiationPage } from "../NegotiationPage.js";

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

async function settle(client: QueryClient): Promise<void> {
  // Two idle ticks in a row: a query can read as idle for one tick between retries.
  let idleTicks = 0;
  for (let i = 0; i < 200 && idleTicks < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    idleTicks = client.isFetching() === 0 ? idleTicks + 1 : 0;
  }
}

async function renderPage(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <NegotiationPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return text();
}

function text(): string {
  return container.textContent ?? "";
}

/** Buttons whose text is exactly `label`. */
function buttons(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

async function clickButton(label: string): Promise<void> {
  const [button] = buttons(label);
  if (!button) throw new Error(`No "${label}" button was rendered`);
  await click(button);
}

/** How many status badges read exactly `status`. */
function badges(status: string): number {
  return [...container.querySelectorAll("span")].filter((s) => s.children.length === 0 && s.textContent === status)
    .length;
}

// What the old page showed as the operator's own proposals, floors and history.
const PROPOSAL_SAMPLES = /Prusa MK4|Epilog Fusion|user-agent@alpha\.pcc|broker-agent@beta\.pcc|user-agent@gamma\.pcc|18\.50|42\.00/;
const FLOOR_SAMPLES = /CNC 3-Axis|cnc-3axis|laser-cut|auto-reject/;
const HISTORY_SAMPLES = /user-agent@delta\.pcc|broker-agent@epsilon\.pcc/;

// ── (a) production: demo mode off ────────────────────────────────────────────

describe("outside demo mode", () => {
  it("with the gateway unreachable: says the proposal inbox isn't live and shows no sample or action", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Not live");
    expect(t).toContain("The proposal inbox isn't connected to live data yet");
    expect(t).toContain("No gateway route lists priced proposals sent to your kernels");
    expect(t).not.toMatch(PROPOSAL_SAMPLES);
    expect(t).not.toMatch(FLOOR_SAMPLES);
    expect(t).not.toMatch(HISTORY_SAMPLES);
    // No KPI counts drawn from samples, and nothing to accept, counter or reject.
    expect(t).not.toContain("awaiting response");
    expect([...buttons("Accept"), ...buttons("Counter"), ...buttons("Reject")]).toEqual([]);
    // There is no live source, so nothing is requested.
    expect(requests(stub)).toEqual([]);
  });

  it("each tab names what is missing and shows no sample values or controls", async () => {
    const stub = stubFetch({});
    await renderPage();

    await clickButton("Revenue Splits");
    expect(text()).toContain("Your default revenue split isn't connected to live data yet");
    expect(text()).toContain("No gateway route stores a default revenue split for new contracts");
    expect(text()).not.toContain("Global Revenue Split");
    expect(text()).not.toContain("Machine Operator");

    await clickButton("Pricing Floors");
    expect(text()).toContain("Price-floor configuration isn't connected to live data yet");
    expect(text()).toContain("No gateway route stores price floors.");
    expect(text()).not.toMatch(FLOOR_SAMPLES);
    expect(container.querySelectorAll("input")).toHaveLength(0);

    await clickButton("History");
    expect(text()).toContain("Negotiation history isn't connected to live data yet");
    expect(text()).toContain("GET /api/negotiate/session/:id reads one session by its ID.");
    expect(text()).not.toMatch(HISTORY_SAMPLES);

    expect(text()).not.toContain("Demo data");
    expect(requests(stub)).toEqual([]);
  });

  it("offers the labelled demo instead of sample values", async () => {
    stubFetch({});
    await renderPage();
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("View the demo version"));
    expect(link?.getAttribute("href")).toContain("demo=1");
  });
});

// ── (b) demo mode, and (d) no control pretends to act ───────────────────────

describe("demo mode (?demo=1)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/negotiate?demo=1");
  });

  it("renders the sample proposals under the demo banner", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Demo data");
    expect(t).toContain("Negotiations: sample values, not live PCC state.");
    expect(t).toContain("FDM 3D Print — Prusa MK4");
    expect(t).toContain("user-agent@alpha.pcc");
    expect(t).toContain("18.50");
    expect(buttons("Proposals (3)")).toHaveLength(1);
    expect(t).not.toContain("isn't connected to live data yet");
    expect(requests(stub)).toEqual([]);
  });

  it("Accept and Reject are disabled, say why, and change nothing when clicked", async () => {
    const stub = stubFetch({});
    await renderPage();
    const accepts = buttons("Accept");
    const rejects = buttons("Reject");
    expect(accepts).toHaveLength(3);
    expect(rejects).toHaveLength(3);
    for (const b of [...accepts, ...rejects]) expect(b.disabled).toBe(true);
    expect(accepts[0]!.title).toBe("No gateway route accepts a proposal");
    expect(rejects[0]!.title).toBe("No gateway route rejects a proposal");
    expect(text()).toContain("Demo: Accept and Reject are disabled, and Send Counter sends nothing.");

    await click(accepts[0]!);
    await click(rejects[1]!);
    expect(badges("pending")).toBe(2);
    expect(badges("accepted")).toBe(0);
    expect(badges("rejected")).toBe(0);
    expect(requests(stub)).toEqual([]);
  });

  it("the counter form can be filled in, but Send Counter is disabled and sends nothing", async () => {
    const stub = stubFetch({});
    await renderPage();
    await clickButton("Counter");
    expect(text()).toContain("Counter Proposal");
    const [send] = buttons("Send Counter");
    expect(send?.disabled).toBe(true);
    expect(send?.title).toBe("No gateway route sends a counter-offer");
    expect(text()).toContain("Demo: Send Counter doesn't send anything.");

    await click(send!);
    // The form stays open and no proposal became "countered" locally.
    expect(text()).toContain("Counter Proposal");
    expect(badges("countered")).toBe(1);
    expect(badges("pending")).toBe(2);
    expect(requests(stub)).toEqual([]);
  });

  it("split and floor controls are disabled and say why", async () => {
    const stub = stubFetch({});
    await renderPage();

    await clickButton("Revenue Splits");
    expect(text()).toContain("Demo: this split can't be changed here. No gateway route stores a default revenue split.");
    const quickApply = buttons("Single-Step (10/70/10/10)");
    expect(quickApply).toHaveLength(1);
    expect(quickApply[0]!.disabled).toBe(true);
    expect(quickApply[0]!.title).toBe("No gateway route stores a default revenue split");

    await clickButton("Pricing Floors");
    expect(text()).toContain("Demo: floors can't be changed here. No gateway route stores price floors.");
    expect(text()).toContain("CNC 3-Axis");
    const inputs = [...container.querySelectorAll("input")];
    expect(inputs).toHaveLength(9);
    for (const input of inputs) expect(input.disabled).toBe(true);
    const toggle = container.querySelector<HTMLButtonElement>('button[title^="Auto-reject on"]');
    expect(toggle?.disabled).toBe(true);
    await click(toggle!);
    expect(container.querySelectorAll('button[title^="Auto-reject on"]')).toHaveLength(2);

    expect(text()).toContain("Demo data");
    expect(requests(stub)).toEqual([]);
  });

  it("shows the sample negotiation timelines, still under the banner", async () => {
    stubFetch({});
    await renderPage();
    await clickButton("History");
    expect(text()).toContain("user-agent@delta.pcc");
    expect(text()).toContain("broker-agent@epsilon.pcc");
    expect(text()).toContain("Demo data");
  });
});
