/**
 * ROI Calculator: an estimate computed from the viewer's own numbers, and
 * nothing else.
 *
 * Before this change the page showed pre-filled figures nobody had typed
 * ($5,000 equipment, $200 a month, $30 a job, 65% utilization) and took its
 * projection from api/mock-onboarding-data.ts, which returns nothing, so it
 * always read "Break-Even N/A" and "$0". It ignored the equipment cost it
 * asked for. Now the inputs start blank, the estimate is arithmetic over the
 * four numbers entered, and the page says it uses no PCC market data. It
 * requests nothing, in or out of demo mode.
 *
 * implementer-foxtrot. The real page renders with only `fetch` replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ROICalculatorPage } from "../ROICalculatorPage.js";
import { useMarketplaceStore } from "../../stores/marketplace-store.js";

// ── render harness ───────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
let fetchStub: ReturnType<typeof vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The calculator calls no route; any request fails loudly here.
  fetchStub = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", fetchStub);
  // jsdom has no ResizeObserver, which the chart's ResponsiveContainer (recharts) needs.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // The store outlives a render; start every test from a blank form.
  useMarketplaceStore.setState({
    roiInputs: { equipmentCost: "", monthlyCost: "", avgJobValue: "", jobsPerMonth: "" },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

// Two idle ticks in a row within 2 s: a query can read as idle for one tick between retries.
async function settle(client: QueryClient) {
  let idleTicks = 0;
  for (let i = 0; i < 200 && idleTicks < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    idleTicks = client.isFetching() === 0 ? idleTicks + 1 : 0;
  }
}

async function renderPage(): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ROICalculatorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return client;
}

function typeInto(input: Element | null | undefined, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error("input was not rendered");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

type Inputs = { equipmentCost: string; monthlyCost: string; avgJobValue: string; jobsPerMonth: string };

function enter(values: Partial<Inputs>) {
  for (const [key, value] of Object.entries(values)) typeInto(container.querySelector(`#roi-${key}`), value!);
}

/** The figure under a KPI label, e.g. kpi("Break-Even"). */
function kpi(label: string): string | null {
  const labelEl = [...container.querySelectorAll("div")].find((d) => d.children.length === 0 && d.textContent === label);
  return labelEl?.nextElementSibling?.textContent ?? null;
}

const text = () => container.textContent ?? "";

// ── (a) nothing shown that the viewer didn't enter ───────────────────────────

describe("before the viewer enters numbers", () => {
  it("starts blank, shows no figures, and asks for the four numbers", async () => {
    await renderPage();
    const values = [...container.querySelectorAll("input")].map((i) => i.value);
    expect(values).toEqual(["", "", "", ""]);
    expect(text()).toContain("Enter all four numbers, each zero or more, to see an estimate.");
    expect(kpi("Break-Even")).toBeNull();
    expect(text()).not.toMatch(/N\/A|\$\d/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("says the estimate is from the viewer's numbers and uses no PCC market data", async () => {
    await renderPage();
    expect(text()).toContain("A planning estimate from the numbers you enter. It uses no PCC market data");
    expect(text()).toContain("Fees and taxes are not included.");
  });

  it("a partly filled or negative input shows no estimate", async () => {
    await renderPage();
    enter({ equipmentCost: "5000", monthlyCost: "200", avgJobValue: "50" });
    expect(kpi("Break-Even")).toBeNull();
    enter({ jobsPerMonth: "-5" });
    expect(kpi("Break-Even")).toBeNull();
    expect(text()).toContain("Enter all four numbers, each zero or more, to see an estimate.");
  });
});

// ── (c) the estimate is arithmetic over the inputs ───────────────────────────

describe("with four numbers entered", () => {
  it("projects revenue, costs and break-even from them, and requests nothing", async () => {
    await renderPage();
    // $1,000 a month in, $200 out, $5,000 up front: $800 a month back.
    enter({ equipmentCost: "5000", monthlyCost: "200", avgJobValue: "50", jobsPerMonth: "20" });
    expect(kpi("Monthly Revenue")).toBe("$1,000");
    expect(kpi("Break-Even")).toBe("Month 7"); // -5000 + 6 × 800 = -200; -5000 + 7 × 800 = +600
    expect(kpi("Net After 24 Months")).toBe("$14,200"); // -5000 + 24 × 800
    expect(text()).toContain("Estimate from your inputs");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("uses the equipment cost it asks for", async () => {
    await renderPage();
    enter({ equipmentCost: "0", monthlyCost: "100", avgJobValue: "10", jobsPerMonth: "20" });
    expect(kpi("Break-Even")).toBe("Month 0");
    expect(kpi("Net After 24 Months")).toBe("$2,400");
    enter({ equipmentCost: "1200" });
    expect(kpi("Break-Even")).toBe("Month 12");
    expect(kpi("Net After 24 Months")).toBe("$1,200");
  });

  it("a machine that costs more than it earns never breaks even, and shows the loss", async () => {
    await renderPage();
    enter({ equipmentCost: "5000", monthlyCost: "500", avgJobValue: "20", jobsPerMonth: "10" });
    expect(kpi("Monthly Revenue")).toBe("$200");
    expect(kpi("Break-Even")).toBe("Not within 24 months");
    expect(kpi("Net After 24 Months")).toBe("−$12,200"); // -5000 + 24 × (200 - 500)
  });

  it("no up-front cost but a monthly loss is not a break-even at month 0", async () => {
    await renderPage();
    enter({ equipmentCost: "0", monthlyCost: "300", avgJobValue: "10", jobsPerMonth: "20" });
    expect(kpi("Break-Even")).toBe("Not within 24 months");
    expect(kpi("Net After 24 Months")).toBe("−$2,400");
  });

  it("a break-even that lands exactly on a month is found despite decimal inputs", async () => {
    await renderPage();
    // 0.7 × 3 is 2.0999999999999996 in floating point.
    enter({ equipmentCost: "2.1", monthlyCost: "0", avgJobValue: "0.7", jobsPerMonth: "3" });
    expect(kpi("Break-Even")).toBe("Month 1");
  });
});

// ── (b) demo mode changes nothing: there is no sample data ───────────────────

describe("in demo mode", () => {
  it("is the same calculator: blank inputs, no demo banner, no requests", async () => {
    window.history.replaceState(null, "", "/marketplace/roi?demo=1");
    await renderPage();
    expect([...container.querySelectorAll("input")].map((i) => i.value)).toEqual(["", "", "", ""]);
    expect(container.querySelector('[data-live-state="demo"]')).toBeNull();
    enter({ equipmentCost: "5000", monthlyCost: "200", avgJobValue: "50", jobsPerMonth: "20" });
    expect(kpi("Break-Even")).toBe("Month 7");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
