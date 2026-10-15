// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyMoneyStatus } from "@pcc/spec";
import { JobDetailPage } from "../JobDetailPage.js";
import { jobFlowFixture } from "../../lib/__tests__/job-flow-fixture.js";
import { setStoredApiKey } from "../../lib/authorized-fetch.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

function response(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, statusText: "", headers: new Headers(), json: async () => body } as Response;
}

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/jobs/print-1"]}>
        <Routes><Route path="/jobs/:jobId" element={<JobDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  await settle();
}

function refresh() {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Refresh");
  expect(button, "manual Refresh is always available").toBeDefined();
  return button!;
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await settle();
}

function paidRead() {
  const dto = jobFlowFixture();
  dto.asOf = new Date().toISOString();
  dto.job.capabilityName = "Last good paid print";
  dto.execution = { ...dto.execution, phase: "completed", terminal: true };
  dto.settlement = {
    ...dto.settlement, link: "linked", payout: "paid",
    record: {
      kind: "gateway_escrow_record", escrowId: "escrow-1", contractAddress: `0x${"a".repeat(40)}`,
      contractVersion: "3", simulated: false,
      escrow: { ...classifyMoneyStatus("ACTIVE"), tone: "settled", sourceStatus: "ACTIVE", vocabulary: "escrow_record" },
      milestoneMatch: "exact", milestoneClaimants: 1, milestone: null,
      escrowTotal: { amount: "1", currency: "USDC" },
      createdAt: dto.asOf, deadline: dto.asOf, statusObservedAt: null,
    },
  };
  return dto;
}

function moneyBadge() {
  const badge = host.querySelector('[aria-label="Job flow"] [aria-label="Money"] span');
  expect(badge, "the card's money badge is shown").not.toBeNull();
  return badge!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setStoredApiKey(null);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  setStoredApiKey(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live job flow reads", () => {
  it.each([
    [401, "unauthenticated", "Sign in to see this job"],
    [403, "identity_unverified", "Sign in with a wallet to see this job"],
    [403, "insufficient_scope", "Sign in with a wallet to see this job"],
    [404, "not_found", "Job not found"],
    [503, "unavailable", "Job details are unavailable right now"],
  ])("shows honest HTTP %s / %s copy and manual Refresh", async (status, code, message) => {
    fetchMock.mockResolvedValue(response(status as number, { error: code }));
    await render();
    if ((status as number) >= 500) await advance(1);
    expect(host.textContent).toContain(message);
    refresh();
    expect(fetchMock).toHaveBeenCalledTimes((status as number) >= 500 ? 2 : 1);
  });

  it("shows a network read failure and allows a manual Refresh", async () => {
    fetchMock.mockRejectedValue(new TypeError("network unavailable"));
    await render();
    await advance(1);
    expect(host.textContent).toContain("Job details are unavailable right now");
    refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polls once per 15-second tick through authorizedFetch, and manual Refresh re-reads", async () => {
    const dto = jobFlowFixture();
    dto.execution = { ...dto.execution, phase: "running", terminal: false };
    setStoredApiKey(["pcc", "test", "flow0123456789abcdef"].join("_"));
    fetchMock.mockResolvedValue(response(200, dto));
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/jobs/print-1/execution");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(true);
    expect(new Headers(init.headers).has("X-Admin-Key")).toBe(false);
    await advance(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => refresh().click());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps polling every 60 seconds after a terminal read so later money changes arrive", async () => {
    const running = jobFlowFixture();
    running.execution = { ...running.execution, phase: "running", terminal: false };
    const terminal = jobFlowFixture();
    terminal.execution = { ...terminal.execution, phase: "completed", terminal: true };
    const paid = paidRead();
    fetchMock.mockResolvedValueOnce(response(200, running))
      .mockResolvedValueOnce(response(200, terminal)).mockResolvedValue(response(200, paid));
    await render();
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(moneyBadge().textContent).toBe("Paid");
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => refresh().click());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("pauses polling in a hidden tab and resumes with one request per tick", async () => {
    const dto = jobFlowFixture();
    dto.execution = { ...dto.execution, phase: "running", terminal: false };
    fetchMock.mockResolvedValue(response(200, dto));
    await render();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "Sign in to see this job"],
    [403, "Sign in with a wallet to see this job"],
    [404, "Job not found"],
  ])("replaces cached money with the latest HTTP %s refusal", async (status, message) => {
    const dto = paidRead();
    fetchMock.mockResolvedValueOnce(response(200, dto));
    await render();
    expect(host.textContent).toContain("Last good paid print");
    expect(moneyBadge().textContent).toBe("Paid");
    fetchMock.mockResolvedValue(response(status as number));
    await act(async () => refresh().click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(host.textContent).not.toContain("Last good paid print");
    expect(host.querySelector('[aria-label="Job flow"]')).toBeNull();
    expect(host.querySelector('[aria-label="Money"]')).toBeNull();
    expect(host.textContent).not.toContain("Released to the operator");
    expect(host.textContent).not.toContain(dto.asOf);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([503, "network"])("keeps a %s failed refresh's last read visibly stale and its payout neutral", async (failure) => {
    const dto = paidRead();
    fetchMock.mockResolvedValueOnce(response(200, dto));
    await render();
    expect(moneyBadge().className).toContain("bg-green-");
    if (typeof failure === "number") fetchMock.mockResolvedValue(response(failure));
    else fetchMock.mockRejectedValue(new TypeError("network unavailable"));
    await act(async () => refresh().click());
    await settle();
    await advance(1);
    expect(host.textContent).toContain("Last good paid print");
    expect(host.textContent).toContain(dto.asOf);
    expect(host.textContent).toContain("last successful read");
    expect(moneyBadge().textContent).toBe("Paid");
    expect(moneyBadge().className).toContain("bg-white/5");
    expect(moneyBadge().className).not.toMatch(/green|gold|red/);
  });

  it.each([
    [false, 30_000],
    [true, 120_000],
  ])("the page clock marks a terminal=%s read stale after two intervals, even without another read", async (terminal, budget) => {
    const dto = paidRead();
    dto.execution = { ...dto.execution, phase: terminal ? "completed" : "running", terminal };
    fetchMock.mockResolvedValue(response(200, dto));
    await render();
    expect(moneyBadge().className).toContain("bg-green-");
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(budget as number);
    expect(host.textContent).not.toContain("This read is out of date");
    expect(moneyBadge().className).toContain("bg-green-");
    await advance(5_000);
    expect(host.textContent).toContain("This read is out of date; it has not been refreshed recently.");
    expect(moneyBadge().className).toContain("bg-white/5");
    expect(moneyBadge().className).not.toMatch(/green|gold|red/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
