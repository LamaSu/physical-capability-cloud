// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));
vi.mock("../../components/inbox/InboxPanel.js", () => ({ InboxPanel: () => null }));

import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { useOperatorStore } from "../../stores/operator-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MACHINE_ID = "kernel-owned-printer";
const MACHINE_NAME = "North printer";
const STOP_BUTTON = `EMERGENCY STOP: ${MACHINE_NAME}`;
const RESUME_BUTTON = `Resume Operations: ${MACHINE_NAME}`;
const RESUME_REFUSED = "Resume was refused for North printer with this key. A wallet sign-in can stop a kernel but can't resume it yet: ask a PCC admin to resume it, or resume through the API with your PCC-issued key and your self-linked wallet (X-PCC-Wallet header).";
const RESUME_FAILED = "Resume didn't go through. North printer is still stopped; try again.";
const STOP_FAILED = "The stop didn't go through. North printer may still be running: use the machine's physical emergency stop, then try again.";
const STOP_UNCONFIRMED = "The server didn't confirm the stop for North printer. The machine may still be running: use its physical emergency stop.";
const STOP_CONFIRMATION = "EMERGENCY STOP for North printer: PCC will refuse new work and cancel queued commands. Work already running stops only with the machine's own emergency stop. Continue?";
const STOP_ACTIVE = "EMERGENCY STOP ACTIVE for North printer: new work is refused and queued commands are cancelled. Work already running stops only with the machine's own emergency stop.";
const SERVER_TEXT = "<strong>Untrusted server or network details</strong>";
const STOPPED = "EMERGENCY STOP ACTIVE";

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let originalOperatorState: ReturnType<typeof useOperatorStore.getState>;
let originalUIState: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  authorizedFetch.mockReset();
  authorizedFetch.mockImplementation(async (path: string) => {
    if (path === "/api/agent/me") return new Response(JSON.stringify({
      ok: true,
      kernels: { count: 1, items: [{ id: MACHINE_ID, name: MACHINE_NAME, status: "online", last_heartbeat: null }] },
    }));
    throw new Error("Unexpected request");
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  originalOperatorState = useOperatorStore.getState();
  originalUIState = useUIStore.getState();
  useOperatorStore.setState({ activeTab: "overview" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  useOperatorStore.setState(originalOperatorState);
  useUIStore.setState(originalUIState);
  vi.restoreAllMocks();
});

function response(status: number): Response {
  // A 204 has no body; all other bodies deliberately contain untrusted text.
  return new Response(status === 204 ? null : JSON.stringify({ error: SERVER_TEXT, message: SERVER_TEXT }), { status });
}

function confirmedStop(status = 200): Response {
  return new Response(JSON.stringify({ stopped: true, kernelId: MACHINE_ID, reason: SERVER_TEXT }), { status });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

async function click(label: string) {
  expect(button(label).disabled).toBe(false);
  await act(async () => button(label).click());
}

async function renderPage(stopped = false) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  authorizedFetch.mockClear();
  if (stopped) {
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click(STOP_BUTTON);
    expectState(true);
    authorizedFetch.mockClear();
  }
}

function expectState(stopped: boolean) {
  expect(container.textContent?.includes(STOPPED), "last confirmed stop state").toBe(stopped);
  expect(button(stopped ? RESUME_BUTTON : STOP_BUTTON).disabled).toBe(false);
  expect(container.textContent).not.toContain(SERVER_TEXT);
  expect(container.textContent).not.toContain("Untrusted server or network details");
}

function expectAlert(message: string) {
  const alerts = container.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].textContent).toBe(message);
  expect(alerts[0].childElementCount, "the message is plain text").toBe(0);
}

function replyWithFailure(status: number | "network failure") {
  if (status === "network failure") authorizedFetch.mockRejectedValueOnce(new Error(SERVER_TEXT));
  else authorizedFetch.mockResolvedValueOnce(response(status));
}

describe("OperatorDashboardPage emergency controls", () => {
  it.each([
    [403, RESUME_REFUSED],
    [401, "Sign in to resume North printer."],
    [404, "North printer or its policy wasn't found, so it can't be resumed here."],
    [500, RESUME_FAILED],
    ["network failure", RESUME_FAILED],
  ] as const)("resume %s keeps stopped and shows its exact message", async (status, message) => {
    await renderPage(true);
    replyWithFailure(status);
    await click(RESUME_BUTTON);
    expectState(true);
    expectAlert(message);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).toHaveBeenCalledWith("/api/operator/emergency-resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kernelId: MACHINE_ID }),
    });
  });

  it.each([
    [401, "Sign in to stop North printer. Until then, use the machine's physical emergency stop."],
    [403, "The stop was refused for this key. North printer may still be running: use the machine's physical emergency stop."],
    [500, STOP_FAILED],
    ["network failure", STOP_FAILED],
  ] as const)("stop %s keeps running and shows its exact message", async (status, message) => {
    await renderPage();
    replyWithFailure(status);
    await click(STOP_BUTTON);
    expectState(false);
    expectAlert(message);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("physical emergency stop");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).toHaveBeenCalledWith("/api/operator/emergency-stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kernelId: MACHINE_ID }),
    });
  });

  // Starting with a failure makes these recovery regressions red on master too.
  it("resume 2xx shows running only after confirmation and clears the alert on retry", async () => {
    await renderPage(true);
    replyWithFailure("network failure");
    await click(RESUME_BUTTON);
    expectState(true);
    expectAlert(RESUME_FAILED);

    let resolve!: (value: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await click(RESUME_BUTTON);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button(`Resuming ${MACHINE_NAME}...`).disabled).toBe(true);
    expect(container.textContent).toContain(STOPPED);

    await act(async () => resolve(response(204)));
    expectState(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("stop 2xx shows stopped only after confirmation and clears the alert on retry", async () => {
    await renderPage();
    replyWithFailure("network failure");
    await click(STOP_BUTTON);
    expectState(false);
    expectAlert(STOP_FAILED);

    let resolve!: (value: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await click(STOP_BUTTON);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button(`Stopping ${MACHINE_NAME}...`).disabled).toBe(true);
    expect(container.textContent).not.toContain(STOPPED);

    await act(async () => resolve(confirmedStop()));
    expectState(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ["200 with no body", () => new Response(null, { status: 200 })],
    ["200 non-JSON", () => new Response(SERVER_TEXT, { status: 200 })],
    ["204", () => response(204)],
    ["200 stopped false", () => new Response(JSON.stringify({ stopped: false, kernelId: MACHINE_ID }), { status: 200 })],
    ["200 stopped string true", () => new Response(JSON.stringify({ stopped: "true", kernelId: MACHINE_ID }), { status: 200 })],
    ["200 stopped true without kernelId", () => new Response(JSON.stringify({ stopped: true }), { status: 200 })],
    ["200 matching kernelId without stopped", () => new Response(JSON.stringify({ kernelId: MACHINE_ID }), { status: 200 })],
    ["200 stopped true for other kernel", () => new Response(JSON.stringify({ stopped: true, kernelId: "other" }), { status: 200 })],
  ] as const)("stop %s keeps running and shows unconfirmed copy", async (_label, reply) => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(reply());
    await click(STOP_BUTTON);
    expectState(false);
    expectAlert(STOP_UNCONFIRMED);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("physical emergency stop");
  });

  it("stop 200 with matching true confirmation shows stopped and the exact banner", async () => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click(STOP_BUTTON);
    expectState(true);
    expect([...container.querySelectorAll("span")].find((element) => element.textContent?.startsWith(STOPPED))?.textContent).toBe(STOP_ACTIVE);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("stop 500 with matching true confirmation keeps running and shows failure copy", async () => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(confirmedStop(500));
    await click(STOP_BUTTON);
    expectState(false);
    expectAlert(STOP_FAILED);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("physical emergency stop");
  });

  it("stop confirmation dialog uses the exact server scope copy", async () => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click(STOP_BUTTON);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(STOP_CONFIRMATION);
  });

  it("rendered emergency states never claim active jobs halted", async () => {
    await renderPage();
    expect(container.textContent).not.toMatch(/halt all active jobs|All jobs halted/);
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click(STOP_BUTTON);
    expectState(true);
    expect(container.textContent).not.toMatch(/halt all active jobs|All jobs halted/);
  });
});
