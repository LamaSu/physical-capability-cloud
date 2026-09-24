/**
 * Sponsor telemetry renders what GET /api/status/integrations returns, and
 * nothing else.
 *
 * The gateway reports configuration only: `configured`, mode, network and
 * addresses per integration, plus Lit's in-process counters
 * (packages/gateway/src/routes/status.ts). The page still read an older shape
 * with a `status` string and usage counters the gateway stopped sending when
 * its invented counters were removed. So a live answer crashed the page, an
 * integration without a status rendered as "Mock", and an outage showed an
 * error line above six loading skeletons that never resolved.
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

import { SponsorTelemetryPage } from "../SponsorTelemetryPage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;

function stubFetch(routes: Routes, fallback: Reply = "network-error") {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
    const reply = routes[path] ?? fallback;
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

/** A response in the shape status.ts serves today. */
const LIVE_BODY = {
  timestamp: "2026-09-24T12:00:00.000Z",
  storacha: { configured: false, mode: "helia", spaceId: null },
  starknet: {
    configured: true,
    network: "sepolia",
    contractAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  litProtocol: {
    configured: false,
    mode: "local-aes",
    live: {
      connected: true,
      mode: "mock-aes",
      network: "chipotle",
      hasPKP: false,
      apiKeyPresent: false,
      encryptCount: 7,
      decryptCount: 2,
      lastError: null,
    },
  },
  flow: { configured: true, chainId: 545, escrowAddress: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" },
  near: { configured: false, endpoint: "https://1click.chaindefuser.com/v0/" },
  protocol: {
    escrowAddress: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
    feeBps: 235,
    feeRecipient: "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B",
  },
};

const ROUTE = "/api/status/integrations";

// Usage counters the page used to show; the gateway serves none of them.
const OLD_COUNTERS = /Evidence Bundles|CIDs Generated|Proofs Anchored|Bundles Encrypted|Cross-chain Quotes|Intents Submitted|Total Escrows|Total Fees/;

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
  const tick = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  for (let i = 0; i < 12; i++) {
    await tick();
    if (client.isFetching() === 0) break;
  }
  // react-query batches its notifications on a timer; let the last one render.
  await tick();
}

async function renderPage(): Promise<{ text: () => string; client: QueryClient }> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SponsorTelemetryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return { text: () => container.textContent ?? "", client };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("gateway unreachable", () => {
  it("says the status couldn't be loaded and shows no status or counts", async () => {
    stubFetch({});
    const { text } = await renderPage();
    expect(text()).toContain("Couldn't load integration status");
    expect(text()).not.toMatch(/Configured|Mock|Active Integrations/);
    expect(text()).not.toMatch(OLD_COUNTERS);
  });
});

describe("live data", () => {
  it("renders the fields the gateway returns", async () => {
    stubFetch({ [ROUTE]: { status: 200, body: LIVE_BODY } });
    const { text } = await renderPage();
    const t = text();
    // Starknet, Flow and the protocol escrow are configured; Storacha, Lit and NEAR are not.
    expect(t).toMatch(/Configured\s*3\s*of 6 integrations/);
    expect(t).toMatch(/Not Configured\s*3/);
    expect(t).toMatch(/Not Reported\s*0/);
    expect(t).toContain("Helia (in-process IPFS)");
    expect(t).toContain("Sepolia testnet");
    expect(t).toContain("Local AES-256-GCM (mock service)");
    expect(t).toContain("7 encrypted · 2 decrypted");
    expect(t).toContain("545");
    expect(t).toContain("https://1click.chaindefuser.com/v0/");
    expect(t).toContain("2.35% (235 bps)");
    expect(t).toContain("0xdDF4...4b6B");
    expect(t).not.toMatch(OLD_COUNTERS);
    const starkscan = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Starkscan"));
    expect(starkscan?.getAttribute("href")).toBe(`https://sepolia.starkscan.co/contract/${LIVE_BODY.starknet.contractAddress}`);
  });

  it("an integration the gateway didn't give a status for reads Unknown, never Mock", async () => {
    stubFetch({
      [ROUTE]: {
        status: 200,
        body: {
          ...LIVE_BODY,
          near: { endpoint: "https://1click.chaindefuser.com/v0/" },
          protocol: { feeBps: 235 },
        },
      },
    });
    const { text } = await renderPage();
    expect(text()).toContain("Unknown");
    expect(text()).toMatch(/Not Reported\s*2/);
    expect(text()).toContain("Not reported");
    expect(text()).not.toContain("Mock");
  });

  it("an answer that names no integration shows an empty state, not zeros", async () => {
    stubFetch({ [ROUTE]: { status: 200, body: { timestamp: "2026-09-24T12:00:00.000Z" } } });
    const { text } = await renderPage();
    expect(text()).toContain("No integrations reported");
    expect(text()).not.toMatch(/of 6 integrations|Couldn't load/);
  });

  it("a failed refresh keeps the last answer and labels it stale", async () => {
    stubFetch({ [ROUTE]: { status: 200, body: LIVE_BODY } });
    const { text, client } = await renderPage();
    expect(text()).toContain("2.35% (235 bps)");

    stubFetch({ [ROUTE]: { status: 503, body: { error: "unavailable" } } });
    const refresh = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Refresh"));
    await act(async () => {
      refresh?.click();
    });
    await settle(client);
    expect(text()).toContain("Couldn't refresh integration status");
    expect(text()).toContain("2.35% (235 bps)");
  });
});

describe("demo mode", () => {
  it("changes nothing on this live page: no demo banner, the gateway's answer is shown", async () => {
    window.history.replaceState(null, "", "/sponsors?demo=1");
    const stub = stubFetch({ [ROUTE]: { status: 200, body: LIVE_BODY } });
    const { text } = await renderPage();
    expect(text()).not.toContain("Demo data");
    expect(text()).toContain("2.35% (235 bps)");
    expect(stub).toHaveBeenCalled();
  });
});
