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
    expect(container.textContent).toContain("Setup Complete");
    expect(container.textContent).toContain("This page didn't register your identity or anything on-chain.");
    expectNoRegistrationClaim();
    expect(calls).toEqual([{ url: "/api/setup/validate", method: "POST" }]);
  });

  it("a failed check says the check failed", async () => {
    validationReply = Promise.resolve(reply({ message: "Setup configuration is invalid" }, 500));
    await render();
    await act(async () => buttonWithText("Complete Setup").click());
    await flush();
    const errorTitle = [...container.querySelectorAll("div")].find((element) => element.textContent === "Setup check failed");
    expect(errorTitle, "the setup check error title").toBeDefined();
    const errorBox = errorTitle!.parentElement!;
    expect(errorBox.textContent).toContain("Setup configuration is invalid");
    expect(useSetupWizardStore.getState().step).toBe(3);
    expect(container.textContent).toContain("Platform Identity");
    expect(buttonWithText("Complete Setup").disabled).toBe(false);
  });
});
