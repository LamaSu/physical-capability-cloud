// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSetupWizardStore } from "../../stores/setup-wizard-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { SetupWizardPage } from "../SetupWizardPage.js";

vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }), useConnect: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  url: string;
  method: string;
}

let calls: Call[];
let container: HTMLDivElement;
let root: Root;
let validationReply: Promise<Response>;
let originalWizard: ReturnType<typeof useSetupWizardStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  originalWizard = useSetupWizardStore.getState();
  originalUI = useUIStore.getState();
  useSetupWizardStore.setState({
    ...useSetupWizardStore.getInitialState(),
    step: 3,
    displayName: "Test Operator",
    organization: "Test Workshop",
    role: "operator",
  });
  calls = [];
  validationReply = Promise.resolve(reply({ valid: true, warnings: [] }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? (input instanceof Request ? input.method : "GET") });
    return url.endsWith("/api/setup/validate") ? validationReply : reply({ status: "ok", devices: [] });
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSetupWizardStore.setState(originalWizard);
  useUIStore.setState(originalUI);
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function render() {
  await act(async () => {
    root.render(<MemoryRouter><SetupWizardPage /></MemoryRouter>);
  });
  await flush();
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  expect(button, `the "${text}" button`).toBeDefined();
  return button!;
}

function expectNoRegistrationClaim() {
  expect(container.textContent).not.toMatch(/registered|registering|registration|registers\s+your|register\s+your\s+identity\s+on/i);
}

describe("SetupWizardPage identity copy", () => {
  it("the identity step and the summary claim no registration", async () => {
    let resolveValidation!: (response: Response) => void;
    validationReply = new Promise((resolve) => { resolveValidation = resolve; });
    await render();
    expect(container.textContent).toContain("Add your name, organization and role. This step registers nothing.");
    expectNoRegistrationClaim();

    calls = [];
    await act(async () => buttonWithText("Complete Setup").click());
    expect(buttonWithText("Checking...").disabled).toBe(true);
    expectNoRegistrationClaim();

    await act(async () => { resolveValidation(reply({ valid: true, warnings: [] })); });
    await flush();
    expect(useSetupWizardStore.getState().step).toBe(4);
    expect(container.textContent).toContain("Setup steps done");
    expect(container.textContent).toContain("The gateway's own setup check passed.");
    expect(container.textContent).toContain("This page didn't register your identity or anything on-chain.");
    expectNoRegistrationClaim();
    expect(calls).toEqual([{ url: "/api/setup/validate", method: "POST" }]);
  });

  it('W2: a non-ok reply shows "No result from the setup check", and the identity step stays open', async () => {
    validationReply = Promise.resolve(reply({ message: "Setup configuration is invalid" }, 500));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    const errorTitle = [...container.querySelectorAll("div")].find((element) => element.textContent === "No result from the setup check");
    expect(errorTitle, "the setup check error title").toBeDefined();
    const errorBox = errorTitle!.parentElement!;
    expect(errorBox.textContent).toContain("Setup configuration is invalid");
    expect(useSetupWizardStore.getState().step).toBe(3);
    expect(container.textContent).toContain("Platform Identity");
    expect(buttonWithText("Complete Setup").disabled).toBe(false);
  });

  it("W3: a passed check: the summary names the gateway's check and shows its warnings", async () => {
    validationReply = Promise.resolve(reply({ valid: true, warnings: ["WARN-MARK"] }));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().step).toBe(4);
    expect(useSetupWizardStore.getState().setupComplete).toBe(true);
    expect(container.textContent).toContain("Setup steps done");
    expect(container.textContent).toContain("The gateway's own setup check passed.");
    expect(container.textContent).toContain("The check's warnings:");
    expect(container.textContent).toContain("WARN-MARK");
    expect(container.querySelector('[aria-label="Setup check passed"]')).not.toBeNull();
    expect(container.textContent).not.toContain("configured and ready to go");
  });

  it("W4: a failed check: the summary says it didn't pass and lists its errors and warnings", async () => {
    validationReply = Promise.resolve(reply({ valid: false, errors: ["ERR-MARK"], warnings: ["WARN-MARK"] }));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().step).toBe(4);
    expect(useSetupWizardStore.getState().setupComplete).toBe(true);
    expect(container.textContent).toContain("Setup steps done");
    expect(container.textContent).toContain("The gateway's own setup check didn't pass.");
    expect(container.textContent).toContain("The check's errors:");
    expect(container.textContent).toContain("ERR-MARK");
    expect(container.textContent).toContain("The check's warnings:");
    expect(container.textContent).toContain("WARN-MARK");
    expect(container.querySelector('[aria-label="Setup check passed"]')).toBeNull();
    expect(container.textContent).not.toContain("configured and ready to go");
  });

  it("W6: an unreached gateway: the summary says it has no result", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().step).toBe(4);
    expect(useSetupWizardStore.getState().setupComplete).toBe(true);
    expect(container.textContent).toContain("Setup steps done");
    expect(container.textContent).toContain("This page got no reply it could read from the gateway, so it has no result from the gateway's setup check.");
    expect(container.querySelector('[aria-label="Setup check passed"]')).toBeNull();
  });

  it("W7: a non-ok reply, then Skip: the summary says the page has no result from the check", async () => {
    validationReply = Promise.resolve(reply({ message: "Setup configuration is invalid" }, 500));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().setupCheck).toBeNull();
    await act(async () => buttonWithText("Skip").click());
    expectNoResultSummary();
    expect(useSetupWizardStore.getState().setupCheck).toEqual({ outcome: "no-result", errors: [], warnings: [] });
  });

  it("W8: an ok reply that isn't JSON, then Skip: the summary says the page has no result from the check", async () => {
    validationReply = Promise.resolve(new Response("not JSON", { status: 200 }));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().setupCheck).toBeNull();
    await act(async () => buttonWithText("Skip").click());
    expectNoResultSummary();
    expect(useSetupWizardStore.getState().setupCheck).toEqual({ outcome: "no-result", errors: [], warnings: [] });
  });

  it("W9: a pass, then back, then a non-ok reply and Skip: no stale pass", async () => {
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().step).toBe(4);
    expect(container.textContent).toContain("The gateway's own setup check passed.");
    await act(async () => buttonWithText("Identity").click());
    expect(useSetupWizardStore.getState().step).toBe(3);
    validationReply = Promise.resolve(reply({ message: "Setup configuration is invalid" }, 500));
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(container.textContent).toContain("No result from the setup check");
    expect(useSetupWizardStore.getState().setupCheck).toBeNull();
    await act(async () => buttonWithText("Skip").click());
    expectNoResultSummary();
    expect(useSetupWizardStore.getState().setupCheck?.outcome).toBe("no-result");
  });

  it("W10: a non-ok reply whose text mentions fetch shows the error box, not the unreached summary", async () => {
    validationReply = Promise.resolve(reply({ error: "Failed to fetch the chain config" }, 500));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    const errorTitle = [...container.querySelectorAll("div")].find((element) => element.textContent === "No result from the setup check");
    expect(errorTitle).toBeDefined();
    expect(errorTitle!.parentElement!.textContent).toContain("Failed to fetch the chain config");
    expect(useSetupWizardStore.getState().step).toBe(3);
    expect(useSetupWizardStore.getState().setupCheck).toBeNull();
    expect(container.textContent).not.toContain("This page got no reply it could read from the gateway, so it has no result from the gateway's setup check.");
  });

  it("W11: a request that gets no reply is unreached, whatever its message says", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Load failed"));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().step).toBe(4);
    expect(container.textContent).toContain("This page got no reply it could read from the gateway, so it has no result from the gateway's setup check.");
    expect(container.querySelector('[aria-label="Setup check passed"]')).toBeNull();
  });

  it("W12: with no outcome recorded, the summary says the page has no result from the check", async () => {
    useSetupWizardStore.setState({ step: 4, setupCheck: null });
    await render();
    expectNoResultSummary();
  });

  it.each([{}, null, { valid: "true" }, { valid: 0 }])("W13: an ok reply without a true or false valid shows the error box, not a failed check (%s)", async (body) => {
    validationReply = Promise.resolve(reply(body));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    expect(useSetupWizardStore.getState().step).toBe(3);
    expect(container.textContent).toContain("No result from the setup check");
    expect(container.textContent).toContain("The gateway replied without a setup check result.");
    expect(useSetupWizardStore.getState().setupCheck).toBeNull();
    expect(container.textContent).not.toContain("The gateway's own setup check didn't pass.");
    await act(async () => buttonWithText("Skip").click());
    expectNoResultSummary();
    expect(useSetupWizardStore.getState().setupCheck?.outcome).toBe("no-result");
  });
});

function expectNoResultSummary() {
  expect(useSetupWizardStore.getState().step).toBe(4);
  expect(container.textContent).toContain("This page has no result from the gateway's setup check.");
  for (const subtitle of [
    "The gateway's own setup check passed.",
    "The gateway's own setup check didn't pass.",
    "This page got no reply it could read from the gateway, so it has no result from the gateway's setup check.",
  ]) expect(container.textContent).not.toContain(subtitle);
  expect(container.querySelector('[aria-label="Setup check passed"]')).toBeNull();
  expect(container.textContent).not.toContain("The check's errors:");
  expect(container.textContent).not.toContain("The check's warnings:");
}
