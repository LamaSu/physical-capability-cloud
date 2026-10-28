/**
 * Live catalog reads use the real query hooks and gateway client. Only fetch
 * is replaced, so unavailable, partial and skipped-row states exercise the
 * same checks as the dashboard.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KernelsPage } from "../KernelsPage.js";
import { DiscoverPage } from "../DiscoverPage.js";
import { KernelLeaderboardPage } from "../KernelLeaderboardPage.js";
import {
  CAPABILITIES_MAX_PAGES,
  useAllCapabilities,
  useCapabilities,
  type AllCapabilities,
} from "../../api/hooks/use-pcc-data.js";
import { KNOWN_KERNEL_STATUSES } from "../../api/wire-vocabulary.js";
import { describeReadError, StaleNotice, UnavailableState } from "../../components/ReadState.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;

function response(reply: Reply): Response {
  if (reply === "network-error") throw new TypeError("Failed to fetch");
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    statusText: reply.status === 200 ? "OK" : "Error",
    headers: { get: () => null },
    json: async () => reply.body,
  } as unknown as Response;
}

function requestUrl(input: RequestInfo | URL): URL {
  const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(value, "http://localhost");
}

function stubFetch(routes: Routes, fallback: Reply = "network-error") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => response(routes[requestUrl(input).pathname] ?? fallback));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function capability(id = "c1", overrides: Record<string, unknown> = {}) {
  return { id, name: `Capability ${id}`, kernelId: "k1", type: "fdm", queueDepth: 0, ...overrides };
}

function caps(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => capability(`c${from + i}`));
}

function page(items: unknown[], total = items.length, offset = 0) {
  return { items, total, offset, limit: 200, hasMore: offset + 200 < total };
}

const EMPTY: Routes = {
  "/api/kernels": { status: 200, body: { kernels: [] } },
  "/api/capabilities/templates": { status: 200, body: { templates: [] } },
  "/api/capabilities": { status: 200, body: page([]) },
};

/** Supply a page by requested offset, keeping every capability request for assertions. */
function stubCapabilityPages(
  pageFor: (offset: number, call: number) => Record<string, unknown>,
  kernels: unknown[] = [],
) {
  const calls: Array<{ offset: number; limit: number }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/capabilities") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "200");
      calls.push({ offset, limit });
      return response({ status: 200, body: pageFor(offset, calls.length - 1) });
    }
    if (url.pathname === "/api/kernels") return response({ status: 200, body: { kernels } });
    return response(EMPTY[url.pathname] ?? { status: 404, body: {} });
  }));
  return calls;
}

function stubPagedCapabilities(all: unknown[], total: number, kernels: unknown[] = []) {
  return stubCapabilityPages((offset) => page(all.slice(offset, offset + 200), total, offset), kernels);
}

let container: HTMLDivElement;
let root: Root;
const clients: QueryClient[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function newClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  clients.push(client);
  return client;
}

async function settle(client: QueryClient) {
  let idleTicks = 0;
  for (let i = 0; i < 200 && idleTicks < 2; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    idleTicks = client.isFetching() === 0 ? idleTicks + 1 : 0;
  }
  expect(client.isFetching(), "all catalog reads settled").toBe(0);
}

function LocationProbe() {
  return <output data-location>{useLocation().pathname}</output>;
}

async function renderPage(element: React.ReactElement, client: QueryClient = newClient()) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{element}<LocationProbe /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

function resetRoot() {
  act(() => root.unmount());
  root = createRoot(container);
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function button(text: string) {
  const found = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.trim() === text);
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function CapabilityProbe() {
  useAllCapabilities();
  return null;
}

describe("gateway unreachable: pages say so instead of showing empty or zero", () => {
  beforeEach(() => { stubFetch({}); });

  it("Kernels", async () => {
    const text = await renderPage(<KernelsPage />);
    expect(text).toContain("Couldn't load kernels");
    expect(text).not.toContain("No kernels registered");
    expect(container.querySelector('[data-live-state="unavailable"]')).not.toBeNull();
  });

  it("Discover", async () => {
    expect(await renderPage(<DiscoverPage />)).toContain("Couldn't load capabilities");
  });

  it("Kernel leaderboard", async () => {
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });
});

describe("gateway healthy and empty: pages show their real empty states", () => {
  beforeEach(() => { stubFetch(EMPTY); });

  it("Kernels", async () => {
    expect(await renderPage(<KernelsPage />)).toContain("No kernels registered");
    expect(container.querySelector('[data-live-state="unavailable"]')).toBeNull();
  });

  it("Discover renders after loading (hooks run in a stable order)", async () => {
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain("No capabilities listed yet");
    expect(text).not.toMatch(/Couldn't load|Rendered more hooks|Something went wrong/);
    expect(container.querySelector('[data-live-state="unavailable"]')).toBeNull();
  });

  it("Kernel leaderboard renders after loading (hooks run in a stable order)", async () => {
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(text).toContain("No kernels on the network yet");
    expect(text).not.toContain("Couldn't load");
    expect(container.querySelector('[data-live-state="unavailable"]')).toBeNull();
  });
});

describe("live data", () => {
  it("Kernels renders a kernel whose location is a {lat, lng} object", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [
      { id: "kernel-a", name: "Shop A", status: "online", isStale: false, location: { lat: 37.7749, lng: -122.4194 }, locationPrecision: "approximate", physicalAddress: "", capabilityCount: 2, capabilityTypes: ["fdm"] },
      { id: "kernel-b", name: "Shop B", status: "online", isStale: true, location: { lat: 1, lng: 2 }, locationPrecision: "approximate", physicalAddress: "12 Maker St", capabilityCount: 1, capabilityTypes: [] },
    ] } } });
    const text = await renderPage(<KernelsPage />);
    expect(text).toContain("Shop A");
    expect(text).toContain("Approximate (within about 5 km): 37.7749, -122.4194");
    expect(text).toContain("12 Maker St");
    expect(text).toContain("stale heartbeat");
    expect(text).toMatch(/Online\s*1\s*fresh heartbeat/);
    expect(text.indexOf("12 Maker St")).toBeLessThan(text.indexOf("Approximate (within about 5 km): 1.0000, 2.0000"));
    expect(text).toContain("fdm");
  });

  it("Kernels renders a kernel whose location is malformed, without crashing", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [
      { id: "kernel-c", name: "Shop C", status: "online", isStale: false, location: { lat: "37.7", lng: null }, locationPrecision: "exact", physicalAddress: null, capabilityCount: 0, capabilityTypes: [] },
    ] } } });
    const text = await renderPage(<KernelsPage />);
    expect(text).toContain("Shop C");
    expect(text).toContain("Location unreadable");
    expect(text).not.toContain("NaN");
  });

  it("a kernel the TTL sweeper expired is accepted and not counted online", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [
      { id: "k1", status: "expired", isStale: false },
      { id: "k2", status: "online", isStale: false },
    ] } } });
    const text = await renderPage(<KernelsPage />);
    expect(text).not.toContain("Couldn't load kernels");
    expect(text).toMatch(/Total Kernels\s*2/);
    expect(text).toMatch(/Online\s*1\s*fresh heartbeat/);
  });
});

describe("A. collection shapes and row checks", () => {
  it("an unexpected /api/kernels shape is unavailable, not 0 kernels", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { items: [{ id: "k1", status: "online", isStale: false }] } } });
    const text = await renderPage(<KernelsPage />);
    expect(text).toContain("Couldn't load kernels");
    expect(text).not.toMatch(/Total Kernels\s*0|No kernels registered/);
  });

  it("Discover: an empty object from /api/capabilities is unavailable, not empty", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: {} } });
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain("Couldn't load capabilities");
    expect(text).not.toContain("No capabilities listed yet");
  });

  it("Kernel leaderboard: /api/capabilities without a total is unavailable, not empty", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: { items: [] } } });
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });

  it.each([undefined, null, {}, "rows"])("a capability page whose items is %j is unavailable", async (items) => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: { ...page([]), items } } });
    expect(await renderPage(<DiscoverPage />)).toContain("Couldn't load capabilities");
  });

  it.each([-1, 1.5, "1", null, Number.NaN])("a capability page whose total is %j is unavailable", async (total) => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: { ...page([]), total } } });
    expect(await renderPage(<DiscoverPage />)).toContain("Couldn't load capabilities");
  });

  it.each([
    { id: "k1", status: "online" },
    { id: "k1", status: "online", isStale: "false" },
    { id: "k1", status: "unknown", isStale: false },
    { id: "", status: "online", isStale: false },
    { id: "k1", status: "", isStale: false },
    null,
  ])("one malformed kernel row fails the entire kernels read: %j", async (bad) => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [{ id: "good", name: "Good kernel", status: "online", isStale: false }, bad] } } });
    const text = await renderPage(<KernelsPage />);
    expect(text).toContain("Couldn't load kernels");
    expect(text).not.toContain("Good kernel");
    expect(text).not.toMatch(/Total Kernels\s*1/);
  });

  it("every known kernel status remains readable", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [...KNOWN_KERNEL_STATUSES].map((status, i) => ({ id: `k${i}`, status, isStale: false })) } } });
    const text = await renderPage(<KernelsPage />);
    expect(text).not.toContain("Couldn't load kernels");
    expect(text).toMatch(new RegExp(`Total Kernels\\s*${KNOWN_KERNEL_STATUSES.size}`));
    expect(text).toMatch(/Online\s*1\s*fresh heartbeat/);
  });
});

describe("B. data kept after a failed refresh is labelled", () => {
  it("Discover: a failed refresh keeps the capabilities on screen and says it couldn't refresh", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability()]) } });
    const client = newClient();
    await renderPage(<DiscoverPage />, client);
    stubFetch({});
    await act(async () => { await client.refetchQueries(); });
    await settle(client);
    expect(container.textContent).toContain("Couldn't refresh capabilities");
    expect(container.textContent).toContain("Capability c1");
    expect(container.querySelector('[data-live-state="stale"]')).not.toBeNull();
  });

  it("Kernel leaderboard: a failed refresh keeps the ranking on screen and says it couldn't refresh", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability()]) }, "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", name: "Kernel One", status: "online", isStale: false }] } } });
    const client = newClient();
    await renderPage(<KernelLeaderboardPage />, client);
    const capsUpdated = client.getQueryState(["capabilities", "all"])!.dataUpdatedAt;
    const kernelsUpdated = client.getQueryState(["kernels", undefined])!.dataUpdatedAt;
    stubFetch({});
    await act(async () => { await client.refetchQueries(); });
    await settle(client);
    expect(container.textContent).toContain("Couldn't refresh the leaderboard");
    expect(container.textContent).toContain("Kernel One");
    expect(container.textContent).toContain(new Date(Math.min(capsUpdated, kernelsUpdated)).toLocaleTimeString());
  });

  it("Kernels: a failed refresh keeps the kernels and labels the earlier read", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", name: "Kernel One", status: "online", isStale: false }] } } });
    const client = newClient();
    await renderPage(<KernelsPage />, client);
    stubFetch({});
    await act(async () => { await client.refetchQueries(); });
    await settle(client);
    expect(container.textContent).toContain("Couldn't refresh kernels");
    expect(container.textContent).toContain("Kernel One");
  });
});

describe("C. Discover says when site names are missing", () => {
  it("shows the capability but says site names couldn't be loaded when /api/kernels 503s", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability("c1", { name: "Cap One" })]) }, "/api/kernels": { status: 503, body: {} } });
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain("Cap One");
    expect(text).toContain("Site names couldn't be loaded, so the cards don't say where each capability runs.");
  });
});

describe("E. a kernel's capability total is unknown, not zero-filled", () => {
  it("one kernel missing capabilityCount makes the network total unavailable; all reporting sums it", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [
      { id: "k1", status: "online", isStale: false, capabilityCount: 2 },
      { id: "k2", status: "online", isStale: false },
    ] } } });
    const text = await renderPage(<KernelsPage />);
    expect(text).toContain("unavailable: a kernel didn't report its count");
    expect(text).toMatch(/Capabilities\s*—/);
    resetRoot();
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [
      { id: "k1", status: "online", isStale: false, capabilityCount: 2 },
      { id: "k2", status: "online", isStale: false, capabilityCount: 1 },
    ] } } });
    expect(await renderPage(<KernelsPage />)).toMatch(/Capabilities\s*3/);
  });
});

describe("F. the leaderboard reads every page of /api/capabilities", () => {
  it("250 rows over 2 pages: fetches offset=0 then offset=200, ranks all 5 kernels, no truncation notice", async () => {
    const kernels = Array.from({ length: 5 }, (_, i) => ({ id: `k${i + 1}`, name: `Kernel ${i + 1}`, status: "online", isStale: false }));
    const all = caps(0, 250).map((cap, i) => ({ ...cap, kernelId: `k${Math.floor(i / 50) + 1}` }));
    const calls = stubPagedCapabilities(all, 250, kernels);
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(calls).toEqual([{ offset: 0, limit: 200 }, { offset: 200, limit: 200 }, { offset: 0, limit: 200 }]);
    expect(calls.every(({ limit }) => limit <= 200)).toBe(true);
    expect(text).not.toContain("Ranked over the first");
    expect(text).toMatch(/Kernels\s*5(?!\+)/);
    expect(text).toContain("Read in 2 pages; the gateway gives no snapshot across pages.");
  });

  it("total 300 but the second page comes back empty: paging stops and the ranking is marked partial", async () => {
    const calls = stubPagedCapabilities(caps(0, 200), 300, [{ id: "k1", name: "Kernel One", status: "online", isStale: false }]);
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(calls).toEqual([{ offset: 0, limit: 200 }, { offset: 200, limit: 200 }]);
    expect(text).toContain("Ranked over the first 200 of the 300 capabilities the gateway lists. Kernels whose capabilities weren't read may be missing or placed differently.");
    expect(text).toMatch(/Kernels\s*1\+/);
    expect(text).toMatch(/With Scores\s*0\+/);
    expect(text).toContain("over the capabilities read");
  });
});

describe("R4: live capabilities and readable rows", () => {
  describe("F2: Discover presents live capabilities, never templates", () => {
    it("R2a: a template-only catalog isn't counted or shown as live capability supply", async () => {
      const template = { name: "Template Only", capabilityType: "hplc" };
      stubFetch({ ...EMPTY, "/api/capabilities/templates": { status: 200, body: { templates: [template] } }, "/api/capabilities": { status: 200, body: page([template]) } });
      const text = await renderPage(<DiscoverPage />);
      expect(text).not.toContain("Template Only");
      expect(text).not.toMatch(/[1-9]\d* capabilit(y|ies) found/);
      expect(text).toContain("1 listed capability couldn't be read and isn't shown.");
    });

    it("R2b: an empty template row is never counted as a capability found", async () => {
      stubFetch({ ...EMPTY, "/api/capabilities/templates": { status: 200, body: { templates: [{}] } }, "/api/capabilities": { status: 200, body: page([{}]) } });
      const text = await renderPage(<DiscoverPage />);
      expect(text).not.toContain("1 capability found");
      expect(text).toContain("1 listed capability couldn't be read and isn't shown.");
    });
  });

  describe("F3: off-schema capability rows are left out and counted", () => {
    it("R3e: a capability missing its type is left out of the leaderboard read", async () => {
      stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([{ id: "c1", kernelId: "k1", queueDepth: 0 }]) } });
      const text = await renderPage(<KernelLeaderboardPage />);
      expect(text).not.toContain("Couldn't load the leaderboard");
      expect(text).toContain("1 listed capability couldn't be read, so the ranking leaves it out.");
      expect(text).not.toContain("#1");
    });

    it("R3f: a capability with a negative queue depth is left out of the leaderboard read", async () => {
      stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability("c1", { queueDepth: -1 })]) } });
      const text = await renderPage(<KernelLeaderboardPage />);
      expect(text).not.toContain("Couldn't load the leaderboard");
      expect(text).toContain("1 listed capability couldn't be read, so the ranking leaves it out.");
    });
  });

  describe("F4: the pager never certifies an inconsistent multi-page read as complete", () => {
    it("R4a: a total that changes between pages is never certified as a complete ranking", async () => {
      stubCapabilityPages((offset) => offset === 0 ? page(caps(0, 200), 250) : page([], 100, offset));
      expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
    });

    it("R4b: rows repeated across pages are never certified as a complete ranking", async () => {
      stubCapabilityPages((offset) => page(offset === 0 ? caps(0, 200) : caps(0, 50), 250, offset));
      expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
    });
  });

  describe("F5: no categorical claim over a partial read", () => {
    it("R5a: the leaderboard never says there are no kernels when registered kernels list no capabilities", async () => {
      stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online", isStale: false }, { id: "k2", status: "online", isStale: false }] } } });
      const text = await renderPage(<KernelLeaderboardPage />);
      expect(text).not.toContain("No kernels on the network yet");
      expect(text).toContain("Nothing to rank yet");
      expect(text).toContain("2 kernels are registered, but none has listed a capability yet. Kernels are ranked by the capabilities they list.");
    });
  });
});

describe("the capability pager", () => {
  it("a total that changes between pages fails the read, even when the rows add up", async () => {
    stubCapabilityPages((offset) => offset === 0 ? page(caps(0, 200), 250) : page(caps(200, 50), 251, offset));
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(text).toContain("Couldn't load the leaderboard");
    expect(text).not.toContain("Ranked over the first");
  });

  it("a page that answers for another offset fails the read", async () => {
    stubCapabilityPages((offset) => ({ ...page(offset === 0 ? caps(0, 200) : caps(200, 50), 250, offset), offset: 0 }));
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });

  it("a page whose hasMore disagrees with its offset, limit and total fails the read", async () => {
    stubCapabilityPages(() => ({ ...page(caps(0, 1)), hasMore: true }));
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });

  it("more rows than the total fails the read", async () => {
    stubCapabilityPages(() => page(caps(0, 2), 1));
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });

  it("a consistent two-page read, with hasMore as the gateway sets it, is complete", async () => {
    stubCapabilityPages((offset) => page(offset === 0 ? caps(0, 200) : caps(200, 50), 250, offset));
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(text).not.toContain("Couldn't load the leaderboard");
    expect(text).not.toContain("Ranked over the first");
  });

  it("Discover counts a capped read as a lower bound and says only part was read", async () => {
    stubCapabilityPages((offset) => page(offset === 0 ? caps(0, 1) : [], 3, offset));
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain("Showing the first 1 of the 3 capabilities the gateway lists; search and filters cover only these.");
    expect(text).toContain("1+ capability found");
    expect(text).toContain("Read in 2 pages; the gateway gives no snapshot across pages.");
  });

  it("a read that changed between pages is never presented as complete", async () => {
    stubCapabilityPages((offset, call) => page(Array.from({ length: Math.min(200, 250 - offset) }, (_, i) => capability(`c${offset + i + call}`)), 250, offset));
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(text).toContain("Couldn't load the leaderboard");
    expect(text).not.toContain("Ranked over the first");
  });

  it("a read of three pages that shifted inside page 2 before page 3 is never presented as complete", async () => {
    let list = Array.from({ length: 500 }, (_, i) => `c${i}`);
    let shifted = false;
    stubCapabilityPages((offset) => {
      const result = page(list.slice(offset, offset + 200).map((id) => capability(id)), list.length, offset);
      if (offset === 200 && !shifted) {
        shifted = true;
        list = [...list.filter((id) => id !== "c210"), "c500"];
      }
      return result;
    });
    const client = newClient();
    await renderPage(<CapabilityProbe />, client);
    const data = client.getQueryData<AllCapabilities>(["capabilities", "all"]);
    expect(data?.complete).toBe(true);
    const ids = new Set(data!.items.map((cap) => cap.id));
    expect({ hasC210: ids.has("c210"), hasC400: ids.has("c400") }).toEqual({ hasC210: false, hasC400: true });
  });

  it.each(["offset", "limit", "hasMore"])("a page missing %s is unavailable, not silently trusted", async (field) => {
    stubCapabilityPages(() => {
      const body: Record<string, unknown> = page(caps(0, 1));
      delete body[field];
      return body;
    });
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });

  it("a changed total on a re-read fails the read", async () => {
    stubCapabilityPages((offset, call) => page(offset === 0 ? caps(0, 200) : caps(200, 50), call % 3 === 2 ? 251 : 250, offset));
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });

  it("a reordered row sequence on a re-read fails the read", async () => {
    stubCapabilityPages((offset, call) => {
      const items = offset === 0 ? caps(0, 200) : caps(200, 50);
      return page(call % 3 === 2 ? items.reverse() : items, 250, offset);
    });
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });

  it("a single page needs no re-read", async () => {
    const calls = stubPagedCapabilities(caps(0, 1), 1);
    const client = newClient();
    await renderPage(<CapabilityProbe />, client);
    expect(calls).toEqual([{ offset: 0, limit: 200 }]);
    expect(client.getQueryData<AllCapabilities>(["capabilities", "all"])).toMatchObject({ total: 1, complete: true, pages: 1, skipped: 0 });
  });

  it("the page cap ends the read as incomplete", async () => {
    const calls = stubCapabilityPages((offset) => page([capability(`c${offset}`)], 100, offset));
    const client = newClient();
    await renderPage(<CapabilityProbe />, client);
    expect(CAPABILITIES_MAX_PAGES).toBe(25);
    expect(calls).toHaveLength(25);
    expect(client.getQueryData<AllCapabilities>(["capabilities", "all"])).toMatchObject({ complete: false, pages: 25, total: 100 });
  });
});

describe("catalog cards and filters", () => {
  it("T1: type chips come only from distinct sorted listed types, and FDM filters the rows", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([
      capability("fdm1", { name: "FDM One", type: "fdm" }),
      capability("cnc1", { name: "CNC One", type: "cnc" }),
      capability("fdm2", { name: "FDM Two", type: "fdm" }),
    ]) } });
    await renderPage(<DiscoverPage />);
    expect(Array.from(button("All").parentElement!.querySelectorAll("button")).map((node) => node.textContent)).toEqual(["All", "CNC", "FDM"]);
    for (const label of ["HPLC", "PCR", "MICROSCOPY", "MASS SPEC", "SEQUENCING", "CELL CULTURE"]) {
      expect(Array.from(container.querySelectorAll("button")).some((node) => node.textContent?.trim() === label)).toBe(false);
    }
    await click(button("FDM"));
    expect(container.textContent).toContain("FDM One");
    expect(container.textContent).toContain("FDM Two");
    expect(container.textContent).not.toContain("CNC One");
    expect(container.textContent).toContain("2 capabilities found in fdm");
  });

  it("T2: a card opens its kernel route", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability("c1", { kernelId: "kernel-card", name: "Linked capability" })]) } });
    await renderPage(<DiscoverPage />);
    const name = Array.from(container.querySelectorAll("div")).find((node) => node.textContent === "Linked capability");
    expect(name).toBeDefined();
    await click(name!);
    expect(container.querySelector("[data-location]")?.textContent).toBe("/kernels/kernel-card");
  });

  it.each([
    ["online", false, " · online"],
    ["online", true, " · not online"],
    ["offline", false, " · not online"],
    ["expired", false, " · not online"],
  ])("T3: a %s kernel with isStale=%s has the right site suffix", async (status, isStale, suffix) => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability()]) }, "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", name: "Site One", status, isStale }] } } });
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain(`at Site One${suffix}`);
  });

  it("T4: Discover requests at most 200 rows and reaches offset 200 for 250 rows", async () => {
    const calls = stubPagedCapabilities(caps(0, 250), 250);
    const text = await renderPage(<DiscoverPage />);
    expect(calls.map(({ offset }) => offset)).toEqual([0, 200, 0]);
    expect(calls.every(({ limit }) => limit <= 200)).toBe(true);
    expect(text).toContain("250 capabilities found");
    expect(text).toContain("Read in 2 pages; the gateway gives no snapshot across pages.");
  });

  it("T5: capability pricing contributes no displayed value", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability("c1", { pricing: { currency: "USDC", amount: "98765.43", display: "$98765.43" } })]) } });
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain("Capability c1");
    expect(text).not.toMatch(/USDC|\$|98765\.43/);
  });

  it("search covers name, type and description, and minimum score and score sort use live rows", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([
      capability("a", { name: "Alpha", type: "fdm", description: "Polymer detail", assuranceScore: 0.4 }),
      capability("b", { name: "Bravo", type: "cnc", description: "Metal detail", assuranceScore: 0.9 }),
      capability("c", { name: "Charlie", type: "fdm" }),
    ]) } });
    await renderPage(<DiscoverPage />);
    const search = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(search.placeholder).toBe("Search by name, type or description");
    for (const [query, included, excluded] of [["alpha", "Alpha", "Bravo"], ["cnc", "Bravo", "Alpha"], ["polymer", "Alpha", "Bravo"]]) {
      await inputValue(search, query!);
      expect(container.textContent).toContain(included!);
      expect(container.textContent).not.toContain(excluded!);
    }
    await inputValue(search, "");
    await click(button("Score ↓"));
    expect(container.textContent!.indexOf("Bravo")).toBeLessThan(container.textContent!.indexOf("Alpha"));
    await click(button("Score ↑"));
    expect(container.textContent!.indexOf("Alpha")).toBeLessThan(container.textContent!.indexOf("Bravo"));
    await inputValue(container.querySelector<HTMLInputElement>('input[type="number"]')!, "70");
    expect(container.textContent).toContain("Bravo");
    expect(container.textContent).not.toMatch(/Alpha|Charlie/);
    expect(container.textContent).toContain("with assurance ≥ 0.70");
    await inputValue(search, "no matching capability");
    expect(container.textContent).toContain("No capabilities match your filters");
  });
});

describe("left-out capability rows", () => {
  it("T9: Discover keeps valid rows and counts one malformed row", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability(), { id: "bad", name: "Unreadable capability", kernelId: "k1" }]) } });
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain("Capability c1");
    expect(text).not.toContain("Unreadable capability");
    expect(text).toContain("1 listed capability couldn't be read and isn't shown.");
    expect(text).toContain("1 capability found");
    expect(text).not.toMatch(/Couldn't load capabilities|Showing the first|1\+ capability/);
  });

  it("T10: the leaderboard ranks valid rows and counts one malformed row", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability("good", { kernelId: "good-kernel", assuranceScore: 0.9 }), { id: "bad", kernelId: "bad-kernel" }]) }, "/api/kernels": { status: 200, body: { kernels: [{ id: "good-kernel", name: "Good site", status: "online", isStale: false }] } } });
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(text).toContain("Good site");
    expect(text).not.toContain("bad-kernel");
    expect(text).toContain("1 listed capability couldn't be read, so the ranking leaves it out.");
    expect(text).not.toMatch(/Couldn't load the leaderboard|Ranked over the first/);
  });

  it.each([
    null, [], "row", {},
    { id: "", kernelId: "k1", type: "fdm" },
    { id: "bad", kernelId: "", type: "fdm" },
    { id: "bad", kernelId: "k1", type: "" },
    capability("bad", { name: 12 }),
    capability("bad", { queueDepth: -1 }),
    capability("bad", { queueDepth: 2.5 }),
    capability("bad", { assuranceScore: 1.5 }),
    capability("bad", { assuranceScore: Number.NaN }),
    capability("bad", { reputation: -1 }),
    capability("bad", { reputation: 5000 }),
  ])("an unreadable capability is left out without failing the read: %j", async (bad) => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability(), bad]) } });
    const text = await renderPage(<DiscoverPage />);
    expect(text).toContain("Capability c1");
    expect(text).toContain("1 listed capability couldn't be read and isn't shown.");
    expect(text).not.toContain("Couldn't load capabilities");
  });

  it("plural skipped-row notices render on Discover and the leaderboard", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability(), {}, null]) } });
    expect(await renderPage(<DiscoverPage />)).toContain("2 listed capabilities couldn't be read and aren't shown.");
    resetRoot();
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("2 listed capabilities couldn't be read, so the ranking leaves them out.");
  });

  it("T11: a malformed row on page 1 counts toward offset 200 and a complete read", async () => {
    const all: unknown[] = caps(0, 250);
    all[18] = {};
    const calls = stubPagedCapabilities(all, 250);
    const client = newClient();
    await renderPage(<CapabilityProbe />, client);
    expect(calls.map(({ offset }) => offset)).toEqual([0, 200, 0]);
    const data = client.getQueryData<AllCapabilities>(["capabilities", "all"]);
    expect(data).toMatchObject({ total: 250, complete: true, skipped: 1, pages: 2 });
    expect(data!.items).toHaveLength(249);
  });

  it("T11: repeated JSON identity of a malformed row on page 2 fails the read", async () => {
    const all: unknown[] = caps(0, 250);
    all[18] = { name: "Unreadable row" };
    all[218] = { name: "Unreadable row" };
    stubPagedCapabilities(all, 250);
    expect(await renderPage(<DiscoverPage />)).toContain("Couldn't load capabilities");
  });

  it("a skipped row with an id still participates in repeated-row checks", async () => {
    const all: unknown[] = caps(0, 250);
    all[18] = { id: "same", name: "Unreadable row" };
    all[218] = capability("same");
    stubPagedCapabilities(all, 250);
    expect(await renderPage(<DiscoverPage />)).toContain("Couldn't load capabilities");
  });

  it("the re-read compares JSON identities of skipped rows too", async () => {
    stubCapabilityPages((offset, call) => {
      const items: unknown[] = offset === 0 ? caps(0, 200) : caps(200, 50);
      if (offset === 0) items[18] = { unreadable: call % 3 === 2 ? "changed" : "first" };
      return page(items, 250, offset);
    });
    expect(await renderPage(<DiscoverPage />)).toContain("Couldn't load capabilities");
  });

  it("partial notices count every row read, including rows left out", async () => {
    stubCapabilityPages((offset) => page(offset === 0 ? [capability(), {}] : [], 3, offset));
    expect(await renderPage(<DiscoverPage />)).toContain("Showing the first 2 of the 3 capabilities the gateway lists; search and filters cover only these.");
    resetRoot();
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Ranked over the first 2 of the 3 capabilities the gateway lists. Kernels whose capabilities weren't read may be missing or placed differently.");
  });

  it("useCapabilities validates shape and returns kept rows with skipped", async () => {
    function PageProbe() { useCapabilities({ limit: 200 }); return null; }
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability(), {}]) } });
    const client = newClient();
    await renderPage(<PageProbe />, client);
    expect(client.getQueryData(["capabilities", { limit: 200 }])).toMatchObject({ items: [capability()], total: 2, skipped: 1 });
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: { total: 1 } } });
    await act(async () => { await client.refetchQueries(); });
    await settle(client);
    expect(client.getQueryState(["capabilities", { limit: 200 }])?.status).toBe("error");
  });
});

describe("leaderboard empty and unknown values", () => {
  it("one registered kernel with no capabilities has the singular empty description", async () => {
    stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online", isStale: false }] } } });
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("1 kernel is registered, but none has listed a capability yet. Kernels are ranked by the capabilities they list.");
  });

  it("an empty partial capability read does not claim an empty network", async () => {
    stubCapabilityPages(() => page([], 3));
    const text = await renderPage(<KernelLeaderboardPage />);
    expect(text).toContain("Nothing to rank yet");
    expect(text).toContain("No capability was read, so there is nothing to rank.");
    expect(text).not.toContain("No kernels on the network yet");
  });

  it("a missing queue depth renders an em dash", async () => {
    const item = capability("c1", { queueDepth: undefined });
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([item]) } });
    await renderPage(<KernelLeaderboardPage />);
    const row = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("#1"))!;
    expect(row.querySelector(".col-span-1.flex.items-center.justify-end")?.textContent?.trim()).toBe("—");
  });

  it("the leaderboard requires the kernels read even when capabilities were read", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: page([capability()]) }, "/api/kernels": { status: 503, body: {} } });
    expect(await renderPage(<KernelLeaderboardPage />)).toContain("Couldn't load the leaderboard");
  });
});

describe("approved copy and wire vocabulary", () => {
  it("T6: UnavailableState renders the approved copy and retries", async () => {
    const retry = vi.fn();
    const text = await renderPage(<UnavailableState what="capabilities" error={{}} onRetry={retry} />);
    expect(text).toContain("Unavailable");
    expect(text).toContain("Couldn't load capabilities");
    expect(text).toContain("PCC couldn't read this from the gateway, so nothing is shown here rather than a guess.");
    expect(text).toContain("The request failed.");
    expect(text).not.toContain("The PCC gateway didn't answer, so nothing is shown here rather than a guess.");
    expect(container.querySelector('[role="status"][data-live-state="unavailable"]')).not.toBeNull();
    await click(button("Try again"));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("T6: StaleNotice pins the timestamp and fallback copy and retries", async () => {
    const retry = vi.fn();
    const updatedAt = Date.parse("2026-09-24T12:00:00Z");
    let text = await renderPage(<StaleNotice what="kernels" updatedAt={updatedAt} onRetry={retry} />);
    expect(text).toContain("Stale");
    expect(text).toContain(`Couldn't refresh kernels. Showing data from ${new Date(updatedAt).toLocaleTimeString()}.`);
    expect(container.querySelector('[role="status"][data-live-state="stale"]')).not.toBeNull();
    await click(button("Retry"));
    expect(retry).toHaveBeenCalledOnce();
    text = await renderPage(<StaleNotice what="kernels" updatedAt={0} />);
    expect(text).toContain("Couldn't refresh kernels. Showing data from an earlier read.");
  });

  it("T6: read error details stop at 160 characters", async () => {
    const detail = "x".repeat(200);
    expect(describeReadError(new Error(detail))).toBe("x".repeat(160));
    expect(describeReadError(detail)).toBe("x".repeat(160));
    expect(describeReadError(null)).toBe("The request failed.");
    await renderPage(<UnavailableState what="kernels" error={new Error(detail)} />);
    expect(container.textContent).toContain("x".repeat(160));
    expect(container.textContent).not.toContain("x".repeat(161));
  });

  it("T6: Discover's subtitle uses the approved literal", () => {
    const source = readFileSync(`${__dirname}/../DiscoverPage.tsx`, "utf8");
    expect(source).toContain('"Search the capabilities operators list on the network"');
  });

  it("T7: wire-vocabulary.ts keeps the reference git blob bytes", () => {
    const bytes = readFileSync(`${__dirname}/../../api/wire-vocabulary.ts`);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    expect(hash).toMatch(/^40d7ff8c[0-9a-f]{32}$/);
  });
});
