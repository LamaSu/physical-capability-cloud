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

const RESUME_REFUSED = "Resume was refused for this key. A wallet sign-in can stop a kernel but can't resume it yet: ask a PCC admin to resume it, or resume through the API with your PCC-issued key and your self-linked wallet (X-PCC-Wallet header).";
const RESUME_FAILED = "Resume didn't go through. The kernel is still stopped; try again.";
const STOP_FAILED = "The stop didn't go through. The kernel may still be running; try again.";
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
    authorizedFetch.mockResolvedValueOnce(response(200));
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
    [500, RESUME_FAILED],
    ["network failure", RESUME_FAILED],
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
    [401, "Sign in to stop this kernel."],
    [403, "The stop was refused for this key. The kernel may still be running."],
    [500, STOP_FAILED],
    ["network failure", STOP_FAILED],
  ] as const)("stop %s keeps running and shows its exact message", async (status, message) => {
    await renderPage();
    replyWithFailure(status);
    await click("EMERGENCY STOP");
    expectState(false);
    expectAlert(message);
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
    expectAlert(RESUME_FAILED);

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

    await act(async () => resolve(response(200)));
    expectState(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
