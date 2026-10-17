// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", () => ({ authorizedFetch }));
vi.mock("../../components/inbox/InboxPanel.js", () => ({ InboxPanel: () => null }));

import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { useOperatorStore } from "../../stores/operator-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESUME_REFUSED = "Resume was refused for this key. Resuming needs a PCC admin, or proof that you control kernel-nanoclaw's operator wallet; a wallet sign-in isn't that proof yet. Ask a PCC admin to resume it, or, if you operate kernel-nanoclaw, resume through the API with a PCC-issued key and its self-linked operator wallet (X-PCC-Wallet header).";
const RESUME_FAILED = "Resume didn't go through. The kernel is still stopped; try again.";
const RESUME_UNCONFIRMED = "Resume wasn't confirmed. kernel-nanoclaw may still be stopped, or the resume may have gone through: treat the machine as live, and press Resume Operations again to confirm.";
const RESUME_CONFIRMATION = "Resume operations on kernel-nanoclaw? Jobs PCC held during the stop can start on the machine.";
const STOP_FAILED = "The stop didn't go through. kernel-nanoclaw may still be running: use the machine's physical emergency stop, then try again.";
const STOP_UNCONFIRMED = "The server didn't confirm the stop for kernel-nanoclaw. The machine may still be running: use its physical emergency stop.";
const STOP_CONFIRMATION = "EMERGENCY STOP for kernel-nanoclaw: PCC stops handing work to this machine and cancels its queued device commands. Queued jobs are held, not cancelled, and can start when you resume. Work already running stops only with the machine's own emergency stop. Continue?";
const STOP_ACTIVE = "EMERGENCY STOP ACTIVE for kernel-nanoclaw: PCC is holding this machine's jobs and has cancelled its queued device commands. Held jobs can start when you resume. Work already running stops only with the machine's own emergency stop.";
const SERVER_TEXT = "<strong>Untrusted server or network details</strong>";
const STOPPED = "EMERGENCY STOP ACTIVE";

let container: HTMLDivElement;
let root: Root;
let originalOperatorState: ReturnType<typeof useOperatorStore.getState>;
let originalUIState: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  authorizedFetch.mockReset();
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
  return new Response(JSON.stringify({ stopped: true, kernelId: "kernel-nanoclaw", reason: SERVER_TEXT }), { status });
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
  await act(async () => root.render(<MemoryRouter><OperatorDashboardPage /></MemoryRouter>));
  if (stopped) {
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click("EMERGENCY STOP");
    expectState(true);
    authorizedFetch.mockClear();
  }
}

function expectState(stopped: boolean) {
  expect(container.textContent?.includes(STOPPED), "last confirmed stop state").toBe(stopped);
  expect(button(stopped ? "Resume Operations" : "EMERGENCY STOP").disabled).toBe(false);
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
    [401, "Sign in to resume this kernel."],
    [404, "This kernel or its policy wasn't found, so it can't be resumed here."],
    [400, RESUME_FAILED],
    [500, RESUME_UNCONFIRMED],
    [502, RESUME_UNCONFIRMED],
    ["network failure", RESUME_UNCONFIRMED],
  ] as const)("resume %s keeps stopped and shows its exact message", async (status, message) => {
    await renderPage(true);
    replyWithFailure(status);
    await click("Resume Operations");
    expectState(true);
    expectAlert(message);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).toHaveBeenCalledWith("/api/operator/emergency-resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kernelId: "kernel-nanoclaw" }),
    });
  });

  it.each([
    [401, "Sign in to stop kernel-nanoclaw. Until then, use the machine's physical emergency stop."],
    [403, "The stop was refused for this key. kernel-nanoclaw may still be running: use the machine's physical emergency stop."],
    [500, STOP_FAILED],
    ["network failure", STOP_FAILED],
  ] as const)("stop %s keeps running and shows its exact message", async (status, message) => {
    await renderPage();
    replyWithFailure(status);
    await click("EMERGENCY STOP");
    expectState(false);
    expectAlert(message);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("physical emergency stop");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).toHaveBeenCalledWith("/api/operator/emergency-stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kernelId: "kernel-nanoclaw" }),
    });
  });

  // Starting with a failure makes these recovery regressions red on master too.
  it("resume 2xx shows running only after confirmation and clears the alert on retry", async () => {
    await renderPage(true);
    replyWithFailure("network failure");
    await click("Resume Operations");
    expectState(true);
    expectAlert(RESUME_UNCONFIRMED);

    let resolve!: (value: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await click("Resume Operations");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Resuming...").disabled).toBe(true);
    expect(container.textContent).toContain(STOPPED);

    await act(async () => resolve(response(204)));
    expectState(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("stop 2xx shows stopped only after confirmation and clears the alert on retry", async () => {
    await renderPage();
    replyWithFailure("network failure");
    await click("EMERGENCY STOP");
    expectState(false);
    expectAlert(STOP_FAILED);

    let resolve!: (value: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await click("EMERGENCY STOP");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Stopping...").disabled).toBe(true);
    expect(container.textContent).not.toContain(STOPPED);

    await act(async () => resolve(confirmedStop()));
    expectState(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ["200 with no body", () => new Response(null, { status: 200 })],
    ["200 non-JSON", () => new Response(SERVER_TEXT, { status: 200 })],
    ["204", () => response(204)],
    ["200 stopped false", () => new Response(JSON.stringify({ stopped: false, kernelId: "kernel-nanoclaw" }), { status: 200 })],
    ["200 stopped string true", () => new Response(JSON.stringify({ stopped: "true", kernelId: "kernel-nanoclaw" }), { status: 200 })],
    ["200 stopped true for other kernel", () => new Response(JSON.stringify({ stopped: true, kernelId: "other" }), { status: 200 })],
    ...["kernel-nyc", "kernel-nanoclaw-2", "KERNEL-NANOCLAW", " kernel-nanoclaw"].map((kernelId) => [
      `200 stopped true for ${JSON.stringify(kernelId)}`,
      () => new Response(JSON.stringify({ stopped: true, kernelId }), { status: 200 }),
    ] as const),
  ] as const)("stop %s keeps running and shows unconfirmed copy", async (_label, reply) => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(reply());
    await click("EMERGENCY STOP");
    expectState(false);
    expectAlert(STOP_UNCONFIRMED);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("physical emergency stop");
  });

  it("stop 200 with matching true confirmation shows stopped and the exact banner", async () => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click("EMERGENCY STOP");
    expectState(true);
    expect([...container.querySelectorAll("span")].find((element) => element.textContent?.startsWith(STOPPED))?.textContent).toBe(STOP_ACTIVE);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("stop 500 with matching true confirmation keeps running and shows failure copy", async () => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(confirmedStop(500));
    await click("EMERGENCY STOP");
    expectState(false);
    expectAlert(STOP_FAILED);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("physical emergency stop");
  });

  it("stop confirmation dialog uses the exact server scope copy", async () => {
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click("EMERGENCY STOP");
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(STOP_CONFIRMATION);
  });

  it("resume confirmation dialog warns that held jobs can start with the exact copy", async () => {
    await renderPage(true);
    vi.mocked(window.confirm).mockClear();
    authorizedFetch.mockResolvedValueOnce(response(204));
    await click("Resume Operations");
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(RESUME_CONFIRMATION);
  });

  it("cancelled stop confirmation keeps running without a request or alert", async () => {
    await renderPage();
    vi.mocked(window.confirm).mockReturnValue(false);
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click("EMERGENCY STOP");
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).not.toHaveBeenCalled();
    expectState(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("cancelled resume confirmation keeps stopped without a request or alert", async () => {
    await renderPage(true);
    vi.mocked(window.confirm).mockClear().mockReturnValue(false);
    authorizedFetch.mockResolvedValueOnce(response(204));
    await click("Resume Operations");
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).not.toHaveBeenCalled();
    expectState(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("rendered emergency states never claim active jobs halted", async () => {
    await renderPage();
    expect(container.textContent).not.toMatch(/halt all active jobs|All jobs halted|refuse new work|queued commands are cancelled/);
    authorizedFetch.mockResolvedValueOnce(confirmedStop());
    await click("EMERGENCY STOP");
    expectState(true);
    expect(container.textContent).not.toMatch(/halt all active jobs|All jobs halted|refuse new work|queued commands are cancelled/);
  });
});
