/** @vitest-environment jsdom */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { OnboardWizardPage } from "../OnboardWizardPage.js";
import { StartPage } from "../StartPage.js";
import { SetupAgentPage } from "../SetupAgentPage.js";
import { OnboardLandingPage } from "../OnboardLandingPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const components = new Map<string, React.ComponentType<Record<string, unknown>>>();
  return {
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    motion: new Proxy({}, {
      get(_target, tag: string | symbol) {
        if (typeof tag !== "string") return undefined;
        let component = components.get(tag);
        if (!component) {
          component = (props) => {
            const domProps = { ...props };
            for (const key of ["initial", "animate", "exit", "variants", "transition", "custom"]) delete domProps[key];
            return React.createElement(tag, domProps);
          };
          components.set(tag, component);
        }
        return component;
      },
    }),
  };
});

const S1 = "Registration isn't available here yet";
const S2 = "This page didn't register your machine. You can describe it in the onboarding chat instead.";
const S3 = "Continue in the onboarding chat";
const S9 = "Enter your machine's details step by step. The wizard can't register it yet.";
// The hub's copy-paste prompt, which this change leaves as it is, tells the user's own AI
// to use the agent package's tools "as your tool registry": a tool list, not a registration.
const SNIPPET_TOOLS = "Use the `tools` field as your tool registry.";

interface Call {
  url: string;
  method: string;
  body: string | null;
}

let calls: Call[];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useOnboardWizardStore.getState().reset();
  calls = [];
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    const reply = url.endsWith("/api/ai/identify-machine")
      ? { make: "Prusa", model: "MK4", type: "FDM Printer", confidence: 0.9, suggestedAdapterType: "octoprint" }
      : {};
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function render(page: React.ReactNode) {
  await act(async () => {
    root.render(<MemoryRouter>{page}</MemoryRouter>);
  });
  await flush();
}

async function clickButton(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(button, `the "${text}" button`).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function textNodes(text: string): Node[] {
  const out: Node[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim() === text) out.push(n);
  return out;
}

function unapprovedRegistrationCopy(text: string): string {
  for (const allowed of [S1, S2, S9, SNIPPET_TOOLS]) text = text.split(allowed).join("");
  return text;
}

function expectNoRegistrationCopy() {
  expect(unapprovedRegistrationCopy(container.textContent ?? "")).not.toMatch(/regist/i);
}

function expectNoRegistrationData(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toBe("kernelId");
    expect(key).not.toBe("mockMode");
    if (key === "adapterType") expect(child).not.toBe("mock");
    expectNoRegistrationData(child);
  }
}

function expectHandoffWithoutRegistration() {
  const forbiddenPaths = ["/setup/generate-config", "/setup/register-device", "/devices/register", "/setup/test-job"];
  for (const call of calls) {
    const path = new URL(call.url, location.href).pathname;
    for (const forbidden of forbiddenPaths) expect(path).not.toMatch(new RegExp(`${forbidden}$`));
    if (call.body !== null) {
      expect(call.body).not.toContain("kernel_dev_");
      expectNoRegistrationData(JSON.parse(call.body));
    }
  }

  const panels = container.querySelectorAll('[data-testid="onboard-chat-handoff"]');
  expect(panels).toHaveLength(1);
  const panel = panels[0]!;
  expect(panel.querySelector("h3")?.textContent).toBe(S1);
  expect(panel.querySelector("p")?.textContent).toBe(S2);
  const links = panel.querySelectorAll("a");
  expect(links).toHaveLength(1);
  expect(links[0]!.textContent).toBe(S3);
  expect(links[0]!.getAttribute("href")).toBe("/onboard/chat");

  for (const success of ["Machine Registered", "You're live", "Setup Complete!"]) {
    expect(container.textContent).not.toContain(success);
  }
  expectNoRegistrationCopy();
}

describe("onboarding registers nothing", () => {
  it("T1a: Step 7 reviews details and hands off without a request or test job", async () => {
    useOnboardWizardStore.getState().updateIdentity({ name: "Mill-1", manufacturer: "Example", model: "Mill" });
    useOnboardWizardStore.getState().setStep(6);
    await render(<OnboardWizardPage />);

    expect(container.querySelector("h2")?.textContent).toBe("Review");
    expect(container.textContent).toContain("Review your details.");
    const railButtons = container.querySelectorAll("nav button");
    expect(railButtons[railButtons.length - 1]?.textContent).toContain("Review your details");
    expect(textNodes("PCCP Assistant")).toHaveLength(1);
    expect(container.textContent).toContain("Welcome! Start by entering your machine details.");
    for (const tip of ["Upload manufacturer datasheets", "Upload a PDF datasheet", "Skip to manual entry"]) {
      expect(container.textContent).not.toContain(tip);
    }
    expect(container.querySelector('[data-testid="onboard-chat-handoff"]')).toBeNull();

    await clickButton("Continue");
    const buttons = [...container.querySelectorAll("button")].filter((button) => !button.closest("nav"));
    expect(buttons.some((button) => button.textContent?.trim().startsWith("Continue"))).toBe(false);
    for (const button of buttons) {
      if (button.textContent?.trim() === "\u2190 Back") continue;
      await act(async () => button.click());
      await flush();
    }
    expectHandoffWithoutRegistration();
    expect(calls).toEqual([]);
  });

  it("T1b: StartPage Manual hands off without a request", async () => {
    await render(<StartPage />);
    await clickButton("3D Printing");
    await clickButton("Continue");
    await clickButton("Manual");
    await clickButton("Continue");
    const rate = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(rate).not.toBeNull();
    await typeInto(rate!, "25");
    await clickButton("Continue");
    expectHandoffWithoutRegistration();
    expect(calls).toEqual([]);
  });

  it("T1c: StartPage OctoPrint hands off without a request", async () => {
    await render(<StartPage />);
    await clickButton("3D Printing");
    await clickButton("Continue");
    await clickButton("OctoPrint");
    const address = container.querySelector<HTMLInputElement>('input[placeholder="http://192.168.1.50"]');
    expect(address).not.toBeNull();
    await typeInto(address!, "http://192.168.1.50");
    await clickButton("Continue");
    await clickButton("Continue");
    expectHandoffWithoutRegistration();
    expect(calls).toEqual([]);
  });

  it("T1d: SetupAgentPage manual hands off without a request or Online badge", async () => {
    await render(<SetupAgentPage />);
    await clickButton("Enter details manually");
    await clickButton("Other / Custom");
    await clickButton("Confirm Configuration");
    expectHandoffWithoutRegistration();
    expect(calls).toEqual([]);
    expect(textNodes("Online")).toHaveLength(0);
  });

  it("T1e: SetupAgentPage photo identifies once and hands off without registering", async () => {
    await render(<SetupAgentPage />);
    await clickButton("Take or upload a photo");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input, "the photo input").not.toBeNull();
    const photo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "machine.png", { type: "image/png" });
    Object.defineProperty(input!, "files", { value: [photo] });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await clickButton("Identify This Machine");
    expect(calls).toHaveLength(1);
    const identification = { ...calls[0]! };
    expect(new URL(identification.url, location.href).pathname).toBe("/api/ai/identify-machine");
    expect(identification.method).toBe("POST");
    expect(typeof JSON.parse(identification.body!).imageBase64).toBe("string");

    await clickButton("Confirm Configuration");
    expectHandoffWithoutRegistration();
    expect(calls).toEqual([identification]);
    expect(textNodes("Online")).toHaveLength(0);
  });

  it("T1f: the hub describes a machine without promising registration", async () => {
    await render(<OnboardLandingPage />);
    expect([...container.querySelectorAll("h3")].filter((heading) => heading.textContent === "Describe a Machine")).toHaveLength(1);
    expect(container.textContent).toContain(S9);
    expect(container.textContent).toContain("Two ways to tell PCC what you do.");
    expect(container.textContent).toContain(SNIPPET_TOOLS);
    expectNoRegistrationCopy();
    expect(calls).toEqual([]);
  });

  it("T1g: the rendered-text rule allows only the approved registration copy", () => {
    expect(unapprovedRegistrationCopy(S1 + S2 + S9)).not.toMatch(/regist/i);
    expect(unapprovedRegistrationCopy(S1 + S2 + " Register now")).toMatch(/regist/i);
    expect(unapprovedRegistrationCopy(S1 + S2 + " Register now").match(/regist\w*/i)?.[0]).toBe("Register");
    expect(unapprovedRegistrationCopy("Pre-registration")).toMatch(/regist/i);
    expect(unapprovedRegistrationCopy(SNIPPET_TOOLS)).not.toMatch(/regist/i);
    expect(unapprovedRegistrationCopy("Add your machine to the tool registry")).toMatch(/regist/i);
  });
});
