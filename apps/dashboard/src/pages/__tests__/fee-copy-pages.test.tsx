// @vitest-environment jsdom
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { economics } from "@pcc/spec";
import { SystemDashboardPage } from "../SystemDashboardPage.js";
import { SponsorTelemetryPage } from "../SponsorTelemetryPage.js";
import { LandingPage } from "../LandingPage.js";
import { EconomicAgreementsPage } from "../EconomicAgreementsPage.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let originalUI: ReturnType<typeof useUIStore.getState>;

function fetchRoutes(routes: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, window.location.href).pathname;
    return new Response(JSON.stringify(routes[path] ?? {}), { status: path in routes ? 200 : 503 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  originalUI = useUIStore.getState();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  fetchRoutes();
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  useUIStore.setState(originalUI);
  vi.unstubAllGlobals();
});

async function renderPage(page: ReactElement) {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter>{page}</MemoryRouter></QueryClientProvider>,
  ));
  let idle = 0;
  for (let tries = 0; tries < 200 && idle < 2; tries++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    idle = client.isFetching() === 0 ? idle + 1 : 0;
  }
  expect(client.isFetching()).toBe(0);
}

describe("dashboard pages without fee copy", () => {
  it("the system page shows no protocol fee card, even on its fallback data", async () => {
    const fetchMock = fetchRoutes();
    await renderPage(<SystemDashboardPage />);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/telemetry/system"))).toBe(true);
    expect(container.textContent).toContain("/api/telemetry/system not available — showing static defaults. The endpoint is still being deployed.");
    expect(["Protocol Fee", "Fee Rate", "Fee Recipient", "Rate (bps)", "1.50%"]
      .filter((text) => container.textContent?.includes(text))).toEqual([]);
  });

  it("the sponsor page's PCCProtocol card shows no fee rows", async () => {
    const sponsors = {
      timestamp: new Date(0).toISOString(),
      storacha: { status: "active", mode: "storacha", totalUploads: 0, totalCIDs: 0, lastUploadAt: null, spaceId: null, details: "" },
      starknet: { status: "active", network: "sepolia", totalAnchored: 0, lastAnchorAt: null, contractAddress: null, details: "" },
      litProtocol: { status: "active", mode: "real", network: null, totalEncrypted: 0, lastEncryptAt: null, details: "" },
      flow: { status: "active", chainId: 0, rpcUrl: "", contracts: { milestoneEscrow: null, mockUSDC: null }, explorerUrl: "", details: "" },
      near: { status: "active", network: "testnet", totalQuotes: 0, totalIntents: 0, lastIntentAt: null, oneClickEndpoint: "", details: "" },
      protocol: { status: "active", feeRecipient: "", feeBps: 235, totalEscrows: 1, totalFeesCollected: "", details: "" },
    };
    fetchRoutes({ "/api/status/integrations": sponsors });
    await renderPage(<SponsorTelemetryPage />);
    expect(container.textContent).toContain("PCCProtocol");
    expect(container.textContent).toContain("Root escrow");
    expect(container.textContent).toContain("Total Escrows");
    expect(["Protocol Fee", "Fee Recipient", "Total Fees", "fee settlement", "2.35%"]
      .filter((text) => container.textContent?.includes(text))).toEqual([]);
  });

  it("the landing page names no PCC fee", async () => {
    await renderPage(<LandingPage />);
    expect(["Oracle fee", "Minimal protocol fee", "no setup fee"]
      .filter((text) => container.textContent?.includes(text))).toEqual([]);
  });

  it("the economics page's note names no fee, and the agreement keeps its fee term", async () => {
    const template = economics.AGREEMENT_TEMPLATES.find((t) => t.templateId === "print-and-mail")!;
    const agreement = template.build();
    const compiled = economics.compileEconomics(agreement, template.compileOptions);
    const preview = economics.buildEconomicPreview(agreement, compiled, { feeVerified: true });
    fetchRoutes({
      "/api/economics/templates": { templates: [template] },
      "/api/economics/preview": { preview },
    });
    await renderPage(<EconomicAgreementsPage />);
    expect(container.querySelector("p")?.textContent).toBe("A preview, computed by the server from its own rate schedules. It shows the agreement as proposed: accepting re-checks it against PCC's records. Nothing here accepts, funds or pays anything.");
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === template.title);
    expect(button).toBeDefined();
    await act(async () => button!.click());
    const row = Array.from(container.querySelectorAll("tr")).find((node) => node.textContent?.includes("PCC protocol fee ("));
    expect(row).toBeDefined();
    expect(row!.querySelectorAll("td")[1]?.textContent).toBe(preview.totals!.protocolFee.display);
  });
});
