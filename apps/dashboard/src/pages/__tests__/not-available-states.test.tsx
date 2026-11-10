// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));

import { NotAvailableReply, isNotAvailable, readGatewayJson, readNotAvailable } from "../../lib/not-available.js";
import { NotAvailablePanel } from "../../components/NotAvailablePanel.js";
import { OrchestratorPage } from "../OrchestratorPage.js";
import { OrchestratorDetailPage } from "../OrchestratorDetailPage.js";
import { ProtocolLibraryPage } from "../ProtocolLibraryPage.js";
import { ProtocolDetailPage } from "../ProtocolDetailPage.js";
import { ProtocolRunPage } from "../ProtocolRunPage.js";
import { OrchestratorChatPage } from "../../routes/orchestrator/[slug]/chat/index.js";
import { TEMPLATES } from "../../routes/orchestrator/templates.js";
import { useOrchestratorStore } from "../../stores/orchestrator-store.js";
import { useProtocolLibraryStore } from "../../stores/protocol-library-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = fileURLToPath(new NodeURL("../../../../../", import.meta.url));
const MSG = "This information is unavailable here.";
const HEADING = "Some data is not available on this gateway";
const FALLBACK = "This gateway does not make this data available.";
const CHAT_HEADING = "This template is not available on this gateway";
const CHAT_FALLBACK = "This gateway does not run this template, so nothing can be started here.";
const DESCRIPTION = "Publishing a dataset as a PCC capability is not available. This template registers no capability and publishes nothing.";
const GREETING = "Hi — I'm Navi. Publishing a dataset as a PCC capability is not available: this template registers no capability and publishes nothing.";
const WITHHELD = { error: "not_available", message: MSG, see: [] };

const graph = {
  id: "graph-alpha", kernelId: "kernel-alpha",
  nodes: [{ id: "node-alpha", nodeType: "instrument", label: "North instrument", capabilities: ["mixing"] }],
  edges: [],
};
const sample = {
  id: "sample-alpha", kernelId: graph.kernelId, label: "Reference sample", status: "processing",
  currentNodeId: "node-alpha", labwareType: "plate", history: [],
};
const workflow = {
  id: "workflow-alpha", kernelId: graph.kernelId, jobId: "job-alpha", status: "running",
  steps: [{ id: "workflow-step-alpha", nodeId: "node-alpha", action: "Mix sample", dependsOn: [], estimatedDurationMs: 60000 }],
};
const claim = { id: "claim-alpha", nodeId: "node-alpha", kernelId: graph.kernelId, claimedBy: "Research workflow", released: false };
const template = {
  id: "template-alpha", name: "Reference protocol", version: "alpha", status: "published",
  description: "Reference procedure", authorName: "Research team", tags: ["mixing"], requiredCapabilities: ["mixing"],
  steps: [{ id: "protocol-step-alpha", label: "Mix reference", capabilityType: "mixing", estimatedDurationMs: 60000, producesEvidence: true }],
  transfers: [], parameters: [], estimatedTotalDurationMs: 60000, forkCount: 2, runCount: 3, rating: 4,
};
const run = {
  id: "run-alpha", templateId: template.id, templateVersion: template.version, kernelId: graph.kernelId,
  initiatedBy: "Research team", status: "running", currentStepIndex: 0, sampleIds: [sample.id],
  steps: [{ id: "run-step-alpha", protocolStepId: "protocol-step-alpha", action: "Mix reference", status: "running" }],
  transfers: [],
};
const automation = {
  id: "automation-alpha", fromNodeId: "source-station", toNodeId: "target-station", currentLevel: "manual",
  episodeCount: 2, minEpisodesForTraining: 8, advanceThreshold: 0.75,
};
const FIXTURES: Record<string, unknown> = {
  "/api/orchestrator/graphs": { graphs: [graph] },
  "/api/orchestrator/samples": { samples: [sample] },
  "/api/orchestrator/workflows": { workflows: [workflow] },
  "/api/orchestrator/claims": { claims: [claim] },
  "/api/orchestrator/graphs/kernel-alpha": { graph },
  "/api/orchestrator/samples?kernelId=kernel-alpha": { samples: [sample] },
  "/api/protocols": { templates: [template] },
  "/api/protocol-runs": { runs: [run] },
  "/api/automation-status": { statuses: [automation] },
  "/api/protocols/template-alpha": { template },
  "/api/protocols/template-alpha/forks": { forks: [] },
  "/api/protocol-runs?templateId=template-alpha": { runs: [run] },
  "/api/protocol-runs/run-alpha": { run },
};

const PAGE_CASES = [
  { name: "orchestrator detail", path: "/orchestrator/kernel-alpha", reads: ["/api/orchestrator/graphs/kernel-alpha", "/api/orchestrator/samples?kernelId=kernel-alpha", "/api/orchestrator/workflows", "/api/orchestrator/claims"],
    absent: ["Nodes", "Samples", "Workflows", "No transfer graph found for kernel", "No samples for this kernel", "No workflows for this kernel"],
    present: ["North instrument", "Reference sample", "workflow-alpha", "Claimed by Research workflow", "Back to Orchestrator"],
    tiles: [["Kernel", "kernel-alpha"], ["Nodes", "1"], ["Samples", "1"], ["Workflows", "1"]] },
  { name: "protocol library", path: "/protocols", reads: ["/api/protocols", "/api/protocol-runs", "/api/automation-status"],
    absent: ["Templates", "Published", "Active Runs", "Automation Pairs", "No protocols found", "No protocol runs", "No automation status data"],
    present: ["Reference protocol", "Create Protocol", "valpha", "run-alpha"],
    tiles: [["Templates", "1"], ["Published", "1"], ["Active Runs", "1"], ["Automation Pairs", "1"]] },
  { name: "protocol detail", path: "/protocols/template-alpha", reads: ["/api/protocols/template-alpha", "/api/protocols/template-alpha/forks", "/api/protocol-runs?templateId=template-alpha"],
    absent: ["Loading protocol...", "Steps", "Transfers", "Parameters", "Est. Duration", "Forks", "Runs"],
    present: ["Reference protocol", "valpha", "Back to Protocol Library", "Protocol DAG"],
    tiles: [["Steps", "1"], ["Transfers", "0"], ["Parameters", "0"], ["Est. Duration", "1m"], ["Forks", "2"], ["Runs", "3"]] },
  { name: "protocol run list", path: "/protocol-runs", reads: ["/api/protocol-runs"],
    absent: ["Total Runs", "Running", "Completed", "No protocol runs"],
    present: ["run-alpha", "template-alpha", "kernel-alpha"],
    tiles: [["Total Runs", "1"], ["Running", "1"], ["Completed", "0"]] },
  { name: "protocol run detail", path: "/protocol-runs/run-alpha", reads: ["/api/protocol-runs/run-alpha", "/api/protocols/template-alpha"],
    absent: ["Loading run...", "Progress", "Transfers", "Samples", "Episodes", "Current Step", "Pause"],
    present: ["run-alpha", "Reference protocol", "Pause", "Back to Protocol Runs"],
    tiles: [["Progress", "0/1"], ["Transfers", "0"], ["Samples", "1"], ["Episodes", "0"], ["Current Step", "1"]] },
] as const;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let originalUI: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  authorizedFetch.mockReset();
  useOrchestratorStore.setState(useOrchestratorStore.getInitialState(), true);
  useProtocolLibraryStore.setState(useProtocolLibraryStore.getInitialState(), true);
  originalUI = useUIStore.getState();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  useOrchestratorStore.setState(useOrchestratorStore.getInitialState(), true);
  useProtocolLibraryStore.setState(useProtocolLibraryStore.getInitialState(), true);
  useUIStore.setState(originalUI);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function answer(unavailable: readonly string[] = []) {
  authorizedFetch.mockImplementation(async (url: string) => {
    if (unavailable.includes(url)) return json(WITHHELD, 501);
    expect(Object.hasOwn(FIXTURES, url), `fixture for ${url}`).toBe(true);
    return json(FIXTURES[url]);
  });
}

async function settle() {
  if (vi.isFakeTimers()) {
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  } else {
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function renderPage(path: string) {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/orchestrator" element={<OrchestratorPage />} />
          <Route path="/orchestrator/:kernelId" element={<OrchestratorDetailPage />} />
          <Route path="/protocols" element={<ProtocolLibraryPage />} />
          <Route path="/protocols/:templateId" element={<ProtocolDetailPage />} />
          <Route path="/protocol-runs" element={<ProtocolRunPage />} />
          <Route path="/protocol-runs/:runId" element={<ProtocolRunPage />} />
          <Route path="/orchestrator/:slug/chat" element={<OrchestratorChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  await settle();
}

function expectPanel(heading = HEADING, message = MSG) {
  const panels = container.querySelectorAll('[role="status"]');
  expect(panels).toHaveLength(1);
  expect(panels[0].textContent).toContain(heading);
  expect(panels[0].textContent).toContain(message);
  expect(panels[0].querySelector("button, a")).toBeNull();
}

function expectTile(label: string, value: string) {
  const labelNode = [...container.querySelectorAll("span")].find((node) => node.textContent === label);
  expect(labelNode, `tile ${label}`).toBeDefined();
  expect(labelNode?.nextElementSibling?.textContent).toBe(value);
}

function read(relativePath: string) {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function literalProperties(node: ts.ObjectLiteralExpression): Record<string, string> {
  const values: Record<string, string> = {};
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) {
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : "";
      values[key] = prop.initializer.text;
    }
  }
  return values;
}

function gatewayEntry(): Record<string, string> {
  const source = ts.createSourceFile("orchestrator-templates.ts", read("packages/gateway/src/routes/orchestrator-templates.ts"), ts.ScriptTarget.Latest, true);
  let entry: Record<string, string> | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "TEMPLATE_DIRECTORY" && node.initializer) {
      const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      expect(ts.isArrayLiteralExpression(initializer)).toBe(true);
      if (ts.isArrayLiteralExpression(initializer)) {
        entry = initializer.elements.filter(ts.isObjectLiteralExpression).map(literalProperties).find((item) => item.slug === "data-product");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(entry).toBeDefined();
  return entry!;
}

function panelDefaults(): Record<string, string> {
  const source = ts.createSourceFile("NotAvailablePanel.tsx", read("apps/dashboard/src/components/NotAvailablePanel.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const values: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "NotAvailablePanel") {
      const parameter = node.parameters[0]?.name;
      if (parameter && ts.isObjectBindingPattern(parameter)) {
        for (const element of parameter.elements) {
          if (ts.isIdentifier(element.name) && element.initializer && ts.isStringLiteral(element.initializer)) {
            values[element.name.text] = element.initializer.text;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return values;
}

function chatPanelProps(): Record<string, string> {
  const source = ts.createSourceFile("chat.tsx", read("apps/dashboard/src/routes/orchestrator/[slug]/chat/index.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const values: Record<string, string> = {};
  function visit(node: ts.Node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text === "NotAvailablePanel") {
      for (const prop of node.attributes.properties) {
        if (ts.isJsxAttribute(prop) && ts.isIdentifier(prop.name) && prop.initializer) {
          const initializer = ts.isJsxExpression(prop.initializer) ? prop.initializer.expression : prop.initializer;
          if (initializer && ts.isStringLiteral(initializer)) values[prop.name.text] = initializer.text;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return values;
}

async function sendName() {
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "Acme Data");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = container.querySelector<HTMLButtonElement>('[data-testid="onboard-chat-send"]')!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  await settle();
  expect(authorizedFetch.mock.calls.map(([url]) => url).filter((url) => !url.startsWith("/api/events"))).toEqual(["/api/orchestrator/data-product/start"]);
}

describe("gateway reply helper", () => {
  it("H1 identifies the unavailable reply", async () => {
    const reply = await readGatewayJson(json(WITHHELD, 501));
    expect(reply).toBeInstanceOf(NotAvailableReply);
    expect(isNotAvailable(reply)).toBe(true);
    expect(reply.message).toBe(MSG);
  });

  it.each([{ error: "not_available" }, { error: "not_available", message: "" }])("H2 allows a missing or empty message: %j", async (body) => {
    const reply = await readGatewayJson(json(body, 501));
    expect(reply).toBeInstanceOf(NotAvailableReply);
    expect(reply.message).toBeNull();
  });

  it("H3 ignores additional reply keys", async () => {
    const reply = await readGatewayJson(json({ ...WITHHELD, see: ["ignored"], report_hint: "ignored", extra: true }, 501));
    expect(reply).toBeInstanceOf(NotAvailableReply);
    expect(reply.message).toBe(MSG);
  });

  it("H4 preserves a successful body with the same error field", async () => {
    const body = { error: "not_available" };
    const reply = await readGatewayJson(json(body));
    expect(reply).toEqual(body);
    expect(isNotAvailable(reply)).toBe(false);
  });

  it("H5 preserves a different unavailable status body", async () => {
    const body = { error: "not_implemented" };
    const reply = await readGatewayJson(json(body, 501));
    expect(reply).toEqual(body);
    expect(isNotAvailable(reply)).toBe(false);
  });

  it("H6 preserves JSON parse rejection", async () => {
    await expect(readGatewayJson(new Response("unparseable", { status: 501 }))).rejects.toBeInstanceOf(SyntaxError);
  });

  it("H7 leaves an unrelated error body unread", async () => {
    const response = new Response("unparseable", { status: 500 });
    const clone = vi.spyOn(response, "clone");
    const readBody = vi.spyOn(response, "json");
    expect(await readNotAvailable(response)).toBeNull();
    expect(response.bodyUsed).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
  });

  it("H8 keeps the body of every other error status that names not_available", async () => {
    for (const status of [400, 403, 404, 500, 502, 503]) {
      const body = { error: "not_available", message: MSG };
      const reply = await readGatewayJson(json(body, status));
      expect(reply, `status ${status}`).toEqual(body);
      expect(isNotAvailable(reply), `status ${status}`).toBe(false);
    }
  });

  it("clones the unavailable POST response and never rejects", async () => {
    const response = json(WITHHELD, 501);
    const reply = await readNotAvailable(response);
    expect(reply).toBeInstanceOf(NotAvailableReply);
    expect(reply?.message).toBe(MSG);
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual(WITHHELD);
    expect(await readNotAvailable(new Response("unparseable", { status: 501 }))).toBeNull();
    expect(await readNotAvailable(json({ error: "not_implemented" }, 501))).toBeNull();
  });

  it.each([null, [], "not_available", { error: "not_available", message: 1 }])("accepts only the ruled body and normalizes its message: %j", async (body) => {
    const result = await readGatewayJson(json(body, 501));
    if (body && !Array.isArray(body) && typeof body === "object") {
      expect(isNotAvailable(result)).toBe(true);
      expect(result.message).toBeNull();
    } else {
      expect(result).toEqual(body);
      expect(isNotAvailable(result)).toBe(false);
    }
  });

  it("renders the panel's fallback and treats its message as text", async () => {
    await act(async () => root.render(<NotAvailablePanel reply={new NotAvailableReply(null)} />));
    expectPanel(HEADING, FALLBACK);
    await act(async () => root.render(<NotAvailablePanel reply={new NotAvailableReply("<b>Gateway message</b>")} />));
    expect(container.textContent).toContain("<b>Gateway message</b>");
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("unavailable page reads", () => {
  it.each(PAGE_CASES)("P1 $name replaces the page body", async (page) => {
    answer(page.reads);
    await renderPage(page.path);
    expectPanel();
    for (const text of page.absent) expect(container.textContent).not.toContain(text);
    expect(container.textContent).not.toContain("0");
    if (page.name === "orchestrator detail") expect(container.textContent).toContain("Back to Orchestrator");
    if (page.name === "protocol detail") expect(container.textContent).toContain("Back to Protocol Library");
    if (page.name === "protocol run detail") expect(container.textContent).toContain("Back to Protocol Runs");
  });

  it.each(PAGE_CASES.flatMap((page) => page.reads.map((url) => ({ name: page.name, path: page.path, url }))))("P2 $name recognizes $url independently", async ({ path, url }) => {
    answer([url]);
    await renderPage(path);
    expectPanel();
    expect(authorizedFetch.mock.calls.some(([requested]) => requested === url)).toBe(true);
  });

  it.each(PAGE_CASES)("P3 $name preserves $present and tile values $tiles", async (page) => {
    answer();
    await renderPage(page.path);
    expect(container.textContent).not.toContain(HEADING);
    for (const text of page.present) expect(container.textContent).toContain(text);
    for (const [label, value] of page.tiles) expectTile(label, value);
  });

  it("P4 stops polling after a successful run becomes unavailable", async () => {
    vi.useFakeTimers();
    let runReads = 0;
    authorizedFetch.mockImplementation(async (url: string) => {
      if (url === "/api/protocol-runs/run-alpha") return ++runReads === 1 ? json({ run }) : json(WITHHELD, 501);
      expect(url).toBe("/api/protocols/template-alpha");
      return json({ template });
    });
    await renderPage("/protocol-runs/run-alpha");
    expect(container.textContent).toContain("Pause");
    expect(runReads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await settle();
    expect(runReads).toBe(2);
    expectPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    await settle();
    expect(runReads).toBe(2);
  });

  it("P5 keeps shared cached workflows and claims usable on navigation", async () => {
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { staleTime: 30000, retry: 1 } } });
    answer();
    await renderPage("/orchestrator");
    const detail = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "View Detail");
    expect(detail).toBeDefined();
    await act(async () => detail!.click());
    await settle();
    expect(container.textContent).toContain("workflow-alpha");
    expect(container.textContent).toContain("Claimed by Research workflow");
    expect(authorizedFetch.mock.calls.filter(([url]) => url === "/api/orchestrator/workflows")).toHaveLength(2);
    expect(authorizedFetch.mock.calls.filter(([url]) => url === "/api/orchestrator/claims")).toHaveLength(2);
    const navigated = container.innerHTML;
    act(() => root.unmount());
    client.clear();
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    useOrchestratorStore.setState(useOrchestratorStore.getInitialState(), true);
    useProtocolLibraryStore.setState(useProtocolLibraryStore.getInitialState(), true);
    await renderPage("/orchestrator/kernel-alpha");
    expect(container.innerHTML).toBe(navigated);
  });

  it("P6 a run opened after the run list was not available shows the run once its reads succeed", async () => {
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { staleTime: 30000, retry: 1 } } });
    answer(["/api/protocol-runs"]);
    await renderPage("/protocol-runs");
    expectPanel();
    answer();
    act(() => root.unmount());
    root = createRoot(container);
    await renderPage("/protocols");
    const open = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("run-alpha"));
    expect(open).toBeDefined();
    await act(async () => open!.click());
    await settle();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("Pause");
    expect(container.textContent).toContain("Reference protocol");
  });
});

describe("template chat replies", () => {
  it("C1 replaces the chat after an unavailable start without an error line", async () => {
    authorizedFetch.mockImplementation(async () => json(WITHHELD, 501));
    await renderPage("/orchestrator/data-product/chat");
    await sendName();
    expectPanel(CHAT_HEADING);
    expect(container.textContent).not.toContain("error:");
    expect(container.querySelector('[data-testid="onboard-chat-thread"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("C2 keeps an unrelated start failure and leaves its body unread", async () => {
    const response = new Response("unparseable", { status: 500 });
    authorizedFetch.mockResolvedValue(response);
    await renderPage("/orchestrator/data-product/chat");
    await sendName();
    expect(container.textContent).toContain("error: /start failed: 500");
    expect(container.textContent).not.toContain(CHAT_HEADING);
    expect(response.bodyUsed).toBe(false);
  });

  it("C3 keeps the successful session greeting", async () => {
    authorizedFetch.mockImplementation(async () => json({ session_id: "session-alpha", state: "started" }));
    await renderPage("/orchestrator/data-product/chat");
    await sendName();
    expect(container.textContent).toContain("Got it — session session- for Acme Data. Activity feed on the right shows every backend call.");
    expect(container.textContent).not.toContain(CHAT_HEADING);
  });
});

describe("template copy", () => {
  it("T1 pins the same description and greeting in both template directories", () => {
    const gateway = gatewayEntry();
    const dashboard = TEMPLATES["data-product"];
    expect(gateway.description).toBe(DESCRIPTION);
    expect(gateway.greeting).toBe(GREETING);
    expect(dashboard.description).toBe(DESCRIPTION);
    expect(dashboard.greeting).toBe(GREETING);
    expect(gateway).toEqual(dashboard);
    expect(read("packages/gateway/src/routes/orchestrator-templates.ts")).not.toContain("paid PCC capability");
    expect(read("apps/dashboard/src/routes/orchestrator/templates.ts")).not.toContain("paid PCC capability");
  });

  it("T2 keeps all added public copy within the approved texts", () => {
    const defaults = panelDefaults();
    const chat = chatPanelProps();
    const gateway = gatewayEntry();
    const dashboard = TEMPLATES["data-product"];
    const actual = [defaults.heading, defaults.fallback, chat.heading, chat.fallback, gateway.description, gateway.greeting, dashboard.description, dashboard.greeting];
    expect(actual).toEqual([HEADING, FALLBACK, CHAT_HEADING, CHAT_FALLBACK, DESCRIPTION, GREETING, DESCRIPTION, GREETING]);
    for (const text of actual) {
      expect(text).not.toMatch(/fee|treasur/i);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/[\u2018\u2019]/);
    }
  });
});
