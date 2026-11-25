// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptApiKey } from "../../stores/auth-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { SetupAgentPage } from "../SetupAgentPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAILURE_COPY = "I couldn't get an identification. Let's enter the details manually instead.\n\nWhat type of machine is it?";
const NO_SUGGESTION = "I couldn't get a connection-type suggestion from that. Please pick the one your laser cutter uses.";
const MACHINE_OPTIONS = ["FDM 3D Printer", "Resin 3D Printer", "CNC Router / Mill", "Laser Cutter/Engraver", "Other / Custom"];

function candidate(mappedAdapterType = "octoprint") {
  return { vendor: "Prusa", model: "MK4", confidence: 0.9, mappedAdapterType };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

let calls: Call[];
let respond: () => Promise<Response>;
let container: HTMLDivElement;
let root: Root;
let originalUI: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  originalUI = useUIStore.getState();
  calls = [];
  respond = async () => reply({ candidates: [candidate()] });
  Element.prototype.scrollIntoView = () => {};
  adoptApiKey(null);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) });
    return respond();
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useUIStore.setState(originalUI);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  adoptApiKey(null);
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

async function render() {
  await act(async () => root.render(<MemoryRouter><SetupAgentPage /></MemoryRouter>));
}

function buttonWithText(text: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

async function clickButton(text: string) {
  const button = buttonWithText(text);
  expect(button, `the "${text}" button`).toBeDefined();
  await act(async () => button!.click());
  await flush();
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function sendText(value: string, placeholder = "Type a message or respond to the agent...") {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  expect(input, "the text input").not.toBeNull();
  await typeInto(input!, value);
  await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await flush();
}

async function uploadPhoto() {
  await clickButton("Take or upload a photo");
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, "the photo input").not.toBeNull();
  const photo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "machine.png", { type: "image/png" });
  Object.defineProperty(input!, "files", { value: [photo] });
  await act(async () => input!.dispatchEvent(new Event("change", { bubbles: true })));
  await flush();
  const photoData = container.querySelector('img[alt="Machine preview"]')!.getAttribute("src")!;
  await clickButton("Identify This Machine");
  return photoData;
}

function expectManualFallback() {
  expect(container.textContent).toContain(FAILURE_COPY);
  expect(container.textContent).toContain("Select your machine type");
  for (const option of MACHINE_OPTIONS) expect(buttonWithText(option), option).toBeDefined();
  expect(container.textContent).not.toContain("Identified:");
  expect(buttonWithText("Confirm Configuration")).toBeUndefined();
}

async function requestLaserSuggestion() {
  await render();
  await clickButton("Enter details manually");
  await clickButton("Laser Cutter/Engraver");
  expect(container.textContent).toContain("Laser cutters can use OPC-UA, USB serial, or proprietary HTTP APIs.\n\nDo you know the connection type? If not, choose the make-and-model option below, and I'll suggest one for you to confirm.");
  await clickButton("Suggest from make and model");
  expect(container.textContent).toContain("What's the make and model of your laser cutter? I'll suggest a connection type for you to confirm.");
  await sendText("xTool S1", "e.g. xTool S1");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toMatch(/\/api\/onboard\/identify-device$/);
  expect(calls[0]!.body).toEqual({ text: "xTool S1" });
}

function expectConnectionChoices() {
  expect(container.textContent).toContain("Connection type");
  expect(buttonWithText("OPC-UA")).toBeDefined();
  expect(buttonWithText("HTTP API")).toBeDefined();
  expect(buttonWithText("Suggest from make and model")).toBeUndefined();
  expect(buttonWithText("Confirm Configuration")).toBeUndefined();
  expect(container.querySelector("dl")).toBeNull();
}

const failures = [
  { name: "throw", respond: async (): Promise<Response> => { throw new TypeError("Failed to fetch"); } },
  ...[400, 413, 429, 502, 503].map((status) => ({
    name: String(status), respond: async () => reply({ candidates: [candidate()] }, status),
  })),
  { name: "non-JSON", respond: async () => new Response("not JSON", { status: 200 }) },
  { name: "empty candidates", respond: async () => reply({ candidates: [] }) },
  { name: "missing candidates", respond: async () => reply({}) },
  { name: "candidates is not a list", respond: async () => reply({ candidates: candidate() }) },
  { name: "candidate vendor is not a string", respond: async () => reply({ candidates: [{ vendor: 7, model: "M", confidence: 0.9, mappedAdapterType: "opcua" }] }) },
];

describe("SetupAgentPage identifies through the served route", () => {
  it("I1: a photo goes to the served route whole, and only four reply fields reach the page", async () => {
    respond = async () => reply({
      candidates: [{ ...candidate(), reasoning: "REASONING-MARK", apiDocsUrl: "https://docs.example.com/DOCS-MARK" }],
      clarifyingQuestions: ["QUESTION-MARK"],
      askForPhoto: true,
    });
    await render();
    const photoData = await uploadPhoto();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/onboard\/identify-device$/);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ photoBase64: photoData });
    expect(calls[0]!.body.photoBase64).toMatch(/^data:image\/png;base64,/);
    expect(calls[0]!.body).not.toHaveProperty("text");
    expect(container.textContent).toContain("Prusa MK4");
    expect(container.textContent).toContain("(Machine). I'm quite confident about this identification.");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="e.g. Prusa"]')?.value).toBe("Prusa");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="e.g. MK4"]')?.value).toBe("MK4");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="e.g. FDM Printer"]')?.value).toBe("Machine");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="e.g. octoprint"]')?.value).toBe("octoprint");
    for (const mark of ["REASONING-MARK", "DOCS-MARK", "QUESTION-MARK"]) {
      expect(container.innerHTML, mark).not.toContain(mark);
      for (const input of container.querySelectorAll("input")) expect(input.value, mark).not.toContain(mark);
    }
  });

  it.each(failures)("I2: every failure gets the same honest copy", async (failure) => {
    respond = failure.respond;
    await render();
    await uploadPhoto();
    expect(calls, failure.name).toHaveLength(1);
    expectManualFallback();
  });

  it.each([200, 502])("I3: text typed in the photo phase goes as a description", async (status) => {
    respond = async () => reply({ candidates: [candidate()] }, status);
    await render();
    await clickButton("Take or upload a photo");
    await sendText("Prusa MK4");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ text: "Prusa MK4" });
    expect(calls[0]!.body).not.toHaveProperty("photoBase64");
    expect(container.textContent).toContain("Description received. Identifying the machine from it...");
    expect(container.textContent).not.toContain("Photo received!");
    if (status === 200) {
      expect(container.textContent).toContain("From your description: **Prusa MK4** (Machine).");
      expect(container.textContent).toContain("Please review the suggested configuration:");
    } else {
      expectManualFallback();
      expect(container.textContent).not.toContain("From your description:");
    }
  });

  it("I4: the laser cutter's suggestion comes only from the reply, for the operator to confirm", async () => {
    respond = async () => reply({ candidates: [candidate("opcua")] });
    await requestLaserSuggestion();
    expect(container.textContent).toContain("Suggested connection type: OPC-UA. Please confirm it below, or pick another.");
    expectConnectionChoices();
    await clickButton("OPC-UA");
    expect(buttonWithText("Confirm Configuration")).toBeDefined();
    expectPreviewAdapter("opcua");
    expect(container.textContent).not.toContain("generic-http");
    expect(calls).toHaveLength(1);
  });

  it.each([
    { candidates: [candidate("generic-http")], status: 200 },
    { candidates: [candidate("octoprint"), candidate("opcua")], status: 200 },
    { candidates: [], status: 200 },
    { candidates: [candidate("opcua")], status: 502 },
  ])("I5: no suggestion without a matching option", async ({ candidates, status }) => {
    respond = async () => reply({ candidates }, status);
    await requestLaserSuggestion();
    expect(container.textContent).toContain(NO_SUGGESTION);
    expect(container.textContent).not.toContain("Suggested connection type");
    expectConnectionChoices();
  });

  it.each([
    { menu: "first", pick: "OPC-UA", adapterType: "opcua" },
    { menu: "first", pick: "HTTP API", adapterType: "generic-http" },
    { menu: "suggested", pick: "OPC-UA", adapterType: "opcua" },
    { menu: "suggested", pick: "HTTP API", adapterType: "generic-http" },
    { menu: "no suggestion", pick: "OPC-UA", adapterType: "opcua" },
    { menu: "no suggestion", pick: "HTTP API", adapterType: "generic-http" },
  ])("I6: the operator's pick sets the preview's connection type ($menu, $pick)", async ({ menu, pick, adapterType }) => {
    if (menu === "first") {
      await render();
      await clickButton("Enter details manually");
      await clickButton("Laser Cutter/Engraver");
      expect(container.textContent).toContain("Connection type");
    } else {
      respond = async () => reply({ candidates: menu === "suggested" ? [candidate("opcua")] : [] });
      await requestLaserSuggestion();
      expect(container.textContent).toContain(menu === "suggested"
        ? "Suggested connection type: OPC-UA. Please confirm it below, or pick another."
        : NO_SUGGESTION);
    }
    await clickButton(pick);
    expect(buttonWithText("Confirm Configuration")).toBeDefined();
    expectPreviewAdapter(adapterType);
    expect(container.textContent).not.toContain(adapterType === "opcua" ? "generic-http" : "opcua");
    expect(calls).toHaveLength(menu === "first" ? 0 : 1);
    expect(container.querySelector("dl")!.textContent).toContain("Machine");
    expect([...container.querySelectorAll("dt")].map((label) => label.textContent)).toEqual(["type", "adapter Type"]);
    expect(container.querySelector('input[placeholder="e.g. octoprint"]')).toBeNull();
  });

  it("I7: no widget shows while a reply is pending", async () => {
    let release!: (response: Response) => void;
    respond = () => new Promise((resolve) => { release = resolve; });
    await render();
    await uploadPhoto();
    expect(calls).toHaveLength(1);
    expectNoWidgetButtons();
    expect(chatInput().disabled).toBe(true);
    await act(async () => release(reply({ candidates: [candidate()] })));
    await flush();
    expect(buttonWithText("Confirm Configuration")).toBeDefined();
    expect(chatInput().disabled).toBe(false);
    expect(buttonWithText("Identify This Machine")).toBeUndefined();
  });

  it("I8: after a step that throws, the input is enabled again and no older widget shows", async () => {
    await render();
    await clickButton("Enter details manually");
    const random = vi.spyOn(Math, "random").mockImplementationOnce(() => { throw new Error("STEP-THROW"); });
    try {
      await clickButton("Laser Cutter/Engraver");
    } finally {
      random.mockRestore();
    }
    expect(container.textContent).toContain("Something went wrong: STEP-THROW");
    expect(chatInput().disabled).toBe(false);
    for (const option of MACHINE_OPTIONS) expect(buttonWithText(option), option).toBeUndefined();
    expectNoWidgetButtons();
    expect(calls).toEqual([]);
  });

  it("I9: after a step that throws, a typed description still reaches the preview", async () => {
    await render();
    await clickButton("Enter details manually");
    const random = vi.spyOn(Math, "random").mockImplementationOnce(() => { throw new Error("STEP-THROW"); });
    try {
      await clickButton("Laser Cutter/Engraver");
    } finally {
      random.mockRestore();
    }
    await sendText("Prusa MK4");
    expect(buttonWithText("Confirm Configuration")).toBeDefined();
    expect([...container.querySelectorAll("dt")].map((label) => label.textContent)).toEqual(["type", "adapter Type"]);
    expect(container.textContent).not.toContain("I'm not sure how to handle that right now");
  });

  it("I9b: after the OctoPrint URL answer, a later text still reaches the preview", async () => {
    await render(); await clickButton("Enter details manually"); await clickButton("FDM 3D Printer");
    await sendText("http://octopi.local"); await sendText("http://octopi.local");
    expect([...container.querySelectorAll("dt")].map((label) => label.textContent)).toEqual(["type", "adapter Type"]);
  });
});

function expectPreviewAdapter(adapterType: string) {
  const label = [...container.querySelectorAll("dt")].find((element) => element.textContent === "adapter Type");
  expect(label, "the preview's adapterType").toBeDefined();
  expect(label!.nextElementSibling?.textContent).toBe(adapterType);
}

function chatInput() {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Type a message or respond to the agent..."]');
  expect(input, "the chat input").not.toBeNull();
  return input!;
}

function expectNoWidgetButtons() {
  const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());
  expect(buttons).toEqual(["", "Start setup", "Check status", "Help"]);
}
