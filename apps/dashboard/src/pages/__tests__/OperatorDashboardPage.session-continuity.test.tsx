// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { adoptApiKey, useAuthStore } from "../../stores/auth-store.js";
import { useOperatorStore } from "../../stores/operator-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MACHINE = { id: "shared-lathe", name: "North lathe", status: "online", last_heartbeat: null };
const WALLET = "0xAbC123";
const ACTIVE = `EMERGENCY STOP ACTIVE for ${MACHINE.name}`;
const STOP_FAILED = `The stop didn't go through. ${MACHINE.name} may still be running: use the machine's physical emergency stop, then try again.`;
const RESUME_UNCONFIRMED = `Resume wasn't confirmed. ${MACHINE.name} may still be stopped, or the resume may have gone through: treat the machine as live, and press Resume Operations again to confirm.`;
const STOP = "/api/operator/emergency-stop";
const RESUME = "/api/operator/emergency-resume";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let fetchMock: Mock<[input: RequestInfo | URL, init?: RequestInit], Promise<Response>>;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalOperator: ReturnType<typeof useOperatorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
let minted: number;
let actionReply: (path: string, init: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

async function renderPage() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
  await settle();
}

async function stopConfirmed() {
  await click(`EMERGENCY STOP: ${MACHINE.name}`);
  expect(container.textContent).toContain(ACTIVE);
  expect(button(`Resume Operations: ${MACHINE.name}`).disabled).toBe(false);
}

function actionCalls(path: string) {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input), window.location.href).pathname === path);
}

async function renewNow() {
  const epoch = useAuthStore.getState().keyEpoch;
  await act(async () => { expect(await useAuthStore.getState().mintSessionKey()).toBe(true); });
  await settle();
  expect(useAuthStore.getState().keyEpoch).toBe(epoch + 1);
}

beforeEach(async () => {
  vi.useFakeTimers();
  originalAuth = useAuthStore.getState();
  originalOperator = useOperatorStore.getState();
  originalUI = useUIStore.getState();
  adoptApiKey(null);
  useAuthStore.getState().setAddress(WALLET);
  useAuthStore.getState().setSession("wallet-session");
  useOperatorStore.setState({ activeTab: "overview" });
  minted = 0;
  actionReply = async (path) => path === STOP
    ? json({ stopped: true, kernelId: MACHINE.id }) : new Response(null, { status: 204 });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), window.location.href).pathname;
    if (path === "/api/auth/me") return json({ address: useAuthStore.getState().address });
    if (path === "/api/auth/session-key") {
      minted += 1;
      return json({
        operator_id: useAuthStore.getState().address,
        api_key: `session-key-${minted}`,
        key_id: `session-key-id-${minted}`,
        // Renewal runs one second from now, five minutes before expiry.
        expires_at: new Date(Date.now() + 301_000).toISOString(),
      }, 201);
    }
    if (path === "/api/agent/me") return json({ ok: true, kernels: { count: 1, items: [MACHINE] } });
    if (path === STOP || path === RESUME) return actionReply(path, init);
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  expect(await useAuthStore.getState().mintSessionKey()).toBe(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  adoptApiKey(null);
  useAuthStore.setState(originalAuth);
  useOperatorStore.setState(originalOperator);
  useUIStore.setState(originalUI);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("operator session continuity through real authorization", () => {
  it("scheduled renewal keeps the confirmed banner and Resume across the store's two mint updates", async () => {
    await renderPage();
    await stopConfirmed();
    const before = useAuthStore.getState();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await settle();
    expect(minted).toBe(2);
    expect(useAuthStore.getState().keyEpoch).toBe(before.keyEpoch + 1);
    expect(useAuthStore.getState().sessionEpoch).toBe(before.sessionEpoch);
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-id-2");
    expect(container.textContent).toContain(ACTIVE);
    expect(button(`Resume Operations: ${MACHINE.name}`).disabled).toBe(false);
    const reads = actionCalls("/api/agent/me");
    expect(reads).toHaveLength(2);
    expect(new Headers(reads[1][1]?.headers).get("Authorization")).toBe("Bearer session-key-2");
  });

  it.each([200, 500])("a stop's 401 re-mint retry lands its %s answer", async (status) => {
    await renderPage();
    let attempts = 0;
    actionReply = async () => ++attempts === 1 ? json({}, 401)
      : json(status === 200 ? { stopped: true, kernelId: MACHINE.id } : { error: "untrusted" }, status);
    await click(`EMERGENCY STOP: ${MACHINE.name}`);
    expect(minted).toBe(2);
    const stops = actionCalls(STOP);
    expect(stops).toHaveLength(2);
    expect(stops.map(([, init]) => new Headers(init?.headers).get("Authorization")))
      .toEqual(["Bearer session-key-1", "Bearer session-key-2"]);
    expect(actionCalls("/api/auth/me")).toHaveLength(1);
    if (status === 200) {
      expect(container.textContent).toContain(ACTIVE);
      expect(button(`Resume Operations: ${MACHINE.name}`).disabled).toBe(false);
    } else {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(STOP_FAILED);
      expect(container.textContent).not.toContain(ACTIVE);
      expect(button(`EMERGENCY STOP: ${MACHINE.name}`).disabled).toBe(false);
    }
    expect(container.textContent).not.toContain("untrusted");
  });

  it.each([204, 500])("an in-flight resume keeps its %s answer after a same-principal mint", async (status) => {
    await renderPage();
    await stopConfirmed();
    let finish!: (response: Response) => void;
    actionReply = async () => new Promise<Response>((resolve) => { finish = resolve; });
    await click(`Resume Operations: ${MACHINE.name}`);
    expect(button(`Resuming ${MACHINE.name}...`).disabled).toBe(true);
    await renewNow();
    expect(button(`Resuming ${MACHINE.name}...`).disabled).toBe(true);
    await act(async () => finish(new Response(null, { status })));
    await settle();
    if (status === 204) {
      expect(container.textContent).not.toContain(ACTIVE);
      expect(button(`EMERGENCY STOP: ${MACHINE.name}`).disabled).toBe(false);
    } else {
      expect(container.textContent).toContain(ACTIVE);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(RESUME_UNCONFIRMED);
      expect(button(`Resume Operations: ${MACHINE.name}`).disabled).toBe(false);
    }
  });

  it("a different wallet principal clears a confirmed stop even when both lists contain the same id", async () => {
    await renderPage();
    await stopConfirmed();
    await renewNow();
    expect(container.textContent).toContain(ACTIVE);
    await act(async () => {
      useAuthStore.getState().setAddress("0xDef456");
      useAuthStore.getState().setSession("another-wallet-session");
      expect(await useAuthStore.getState().mintSessionKey()).toBe(true);
    });
    await settle();
    expect(container.textContent).not.toContain(ACTIVE);
    expect(container.textContent).toContain(`No stop confirmed for ${MACHINE.name}`);
    expect(button(`EMERGENCY STOP: ${MACHINE.name}`).disabled).toBe(false);
  });

  it("pasting a different key clears a confirmed stop after same-session continuity", async () => {
    await renderPage();
    await stopConfirmed();
    await renewNow();
    expect(container.textContent).toContain(ACTIVE);
    await act(async () => adoptApiKey("different-pasted-key"));
    await settle();
    expect(useAuthStore.getState().sessionKeyId).toBeNull();
    expect(container.textContent).not.toContain(ACTIVE);
    expect(button(`EMERGENCY STOP: ${MACHINE.name}`).disabled).toBe(false);
  });
});
