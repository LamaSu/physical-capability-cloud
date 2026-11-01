// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { InstrumentWorkflow, ResourceClaim, Sample, TransferGraph } from "@pcc/spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", () => ({ authorizedFetch }));

import { OrchestratorPage } from "../OrchestratorPage.js";
import { OrchestratorDetailPage } from "../OrchestratorDetailPage.js";
import { useOrchestratorStore } from "../../stores/orchestrator-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KERNEL = "truth-lab";
const AT = "2026-10-21T12:00:00.000Z";
const GRAPH: TransferGraph = {
  id: "truth-graph", kernelId: KERNEL, createdAt: AT,
  nodes: [
    { id: "mixer", kernelId: KERNEL, label: "Truth mixer", nodeType: "instrument", capabilities: ["mix"] },
    { id: "reader", kernelId: KERNEL, label: "Truth reader", nodeType: "instrument", capabilities: ["read"] },
  ],
  edges: [{ id: "truth-edge", fromNode: "mixer", toNode: "reader", mechanism: "manual", transferTimeMs: 1000, bidirectional: false }],
};
const SAMPLES: Sample[] = ["alpha", "beta"].map((name) => ({
  id: `sample-${name}`, jobId: "truth-job", label: `Truth sample ${name}`, labwareType: "plate",
  currentNodeId: "mixer", status: "processing", history: [], createdAt: AT,
}));
const WORKFLOWS: InstrumentWorkflow[] = (["running", "completed", "pending"] as const).map((status) => ({
  id: `truth-${status}`, kernelId: KERNEL, jobId: "truth-job", status,
  steps: ["mix", "transfer", "read"].map((action, index) => ({
    id: `${status}-step-${index}`, nodeId: index < 2 ? "mixer" : "reader", action,
    params: {}, estimatedDurationMs: 1000, producesEvidence: false, dependsOn: [],
  })),
}));
const CLAIMS: ResourceClaim[] = [
  { id: "truth-claim", nodeId: "mixer", claimedBy: "truth-running", claimedAt: AT, released: false },
  { id: "old-claim", nodeId: "reader", claimedBy: "old-workflow", claimedAt: AT, released: true },
];
const READS = [
  ["graphs", "Transfer Graphs"],
  ["samples", "Active Samples"],
  ["workflows", "Instrument Workflows"],
  ["claims", "Resource Claims"],
] as const;
const N34 = "Transfer graphs, samples, resource claims and instrument workflows under /api/orchestrator are not recorded on this gateway. Only built-in examples exist, and they are not served.";

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let originalStore: ReturnType<typeof useOrchestratorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
let answers: Map<string, () => Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function resetData() {
  useOrchestratorStore.setState({ graphs: [], samples: [], workflows: [], claims: [] });
}

beforeEach(() => {
  originalStore = useOrchestratorStore.getState();
  originalUI = useUIStore.getState();
  resetData();
  answers = new Map([
    ["/api/orchestrator/graphs", () => json({ graphs: [GRAPH] })],
    [`/api/orchestrator/graphs/${KERNEL}`, () => json({ graph: GRAPH })],
    ["/api/orchestrator/samples", () => json({ samples: SAMPLES })],
    [`/api/orchestrator/samples?kernelId=${KERNEL}`, () => json({ samples: SAMPLES })],
    ["/api/orchestrator/workflows", () => json({ workflows: WORKFLOWS })],
    ["/api/orchestrator/claims", () => json({ claims: CLAIMS })],
  ]);
  authorizedFetch.mockReset();
  authorizedFetch.mockImplementation(async (url: string) => {
    const answer = answers.get(url);
    if (!answer) throw new Error(`Unexpected orchestrator URL: ${url}`);
    return answer();
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  useOrchestratorStore.setState(originalStore);
  useUIStore.setState(originalUI);
});

async function settle() {
  // Query notifications and the store effects each need a turn to reach the DOM.
  for (let turn = 0; turn < 3; turn++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function renderPage(detail = false) {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[detail ? `/orchestrator/${KERNEL}` : "/orchestrator"]}>
        <Routes>
          <Route path="/orchestrator" element={<OrchestratorPage />} />
          <Route path="/orchestrator/:kernelId" element={<OrchestratorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  await settle();
}

function kpi(label: string) {
  const caption = [...container.querySelectorAll("span")].find((element) =>
    element.textContent === label && element.classList.contains("uppercase"));
  expect(caption, `KPI ${label}`).toBeDefined();
  return caption!.nextElementSibling?.textContent;
}

function segments(status: string) {
  const id = [...container.querySelectorAll("span")].find((element) => element.textContent === `truth-${status}`);
  expect(id, `${status} workflow card`).toBeDefined();
  return [...id!.parentElement!.parentElement!.querySelectorAll<HTMLElement>("[title]")];
}

function expectOverview() {
  expect(kpi("Transfer Graphs")).toBe("1");
  expect(kpi("Active Samples")).toBe("2");
  expect(kpi("Running Workflows")).toBe("1");
  expect(kpi("Active Claims")).toBe("1");
  expect(container.textContent).toContain("Claimed by truth-running");
  expect(container.textContent).toContain("Available");
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).not.toContain("Claim status unknown");
}

function expectDetail() {
  expect(kpi("Nodes")).toBe("2");
  expect(kpi("Samples")).toBe("2");
  expect(kpi("Workflows")).toBe("3");
  expect(container.textContent).toContain("truth-running");
  expect(container.textContent).toContain("Claimed by truth-running");
  expect(container.textContent).toContain("Available");
  expect(container.textContent).not.toContain("No workflows for this kernel");
}

describe("OrchestratorPage reports only known state", () => {
  it("R1 running: every step is neutral and explains unreported progress", async () => {
    await renderPage();
    const bars = segments("running");
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.title).toMatch(/ @ .+: per-step progress is not reported$/);
      expect(bar.querySelector(".bg-green-400"), "running steps must not be marked done").toBeNull();
      expect(bar.querySelector(".animate-pulse"), "running steps must not invent in-progress state").toBeNull();
    }
  });

  it("R1 completed: every step is done", async () => {
    await renderPage();
    const bars = segments("completed");
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.title).toMatch(/: done \(workflow completed\)$/);
      expect(bar.firstElementChild?.classList.contains("bg-green-400")).toBe(true);
      expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
    }
  });

  it("R1 pending: no step has started", async () => {
    await renderPage();
    const bars = segments("pending");
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.title).toMatch(/: not started \(workflow pending\)$/);
      expect((bar.firstElementChild as HTMLElement).style.width).toBe("0%");
      expect(bar.querySelector(".bg-green-400, .animate-pulse")).toBeNull();
    }
  });

  it("R2 shows a withheld read's message and suggested routes", async () => {
    answers.set("/api/orchestrator/graphs", () => json({
      error: "not_available", message: "Graphs are not recorded here.",
      see: ["GET /api/kernels", "GET /api/kernels/:kernelId/devices"],
    }, 501));
    await renderPage();
    expect(container.textContent).toContain("Some data is not available on this gateway");
    expect(container.textContent).toContain("Graphs are not recorded here.");
    expect(container.textContent).toContain("Real data lives at: GET /api/kernels, GET /api/kernels/:kernelId/devices");
    expect(kpi("Transfer Graphs")).toBe("—");
  });

  it("R2 N34 keeps the exact ORCHESTRATOR message and omits empty see routes", async () => {
    for (const [path] of READS) {
      answers.set(`/api/orchestrator/${path}`, () => json({ error: "not_available", message: N34, see: [] }, 501));
    }
    await renderPage();
    expect(container.textContent).toContain("Some data is not available on this gateway");
    const message = [...container.querySelectorAll("p, div")].find((element) => element.textContent === N34);
    expect(message, "the gateway's N34 message must be shown verbatim").toBeDefined();
    expect(container.textContent).not.toContain("Real data lives at:");
    for (const label of ["Transfer Graphs", "Active Samples", "Running Workflows", "Active Claims"]) {
      expect(kpi(label)).toBe("—");
    }
  });

  it.each(READS)("R3 %s: a non-JSON 500 produces its own error line", async (path, label) => {
    answers.set(`/api/orchestrator/${path}`, () => new Response("<html>upstream failure</html>", {
      status: 500, statusText: "Internal Server Error",
    }));
    await renderPage();
    expect(container.textContent).toContain("Some data failed to load");
    expect(container.textContent).toContain(`${label}: HTTP 500 — Internal Server Error`);
  });

  it("R4 an invalid JSON success is reported as a read error", async () => {
    answers.set("/api/orchestrator/samples", () => new Response("not JSON", { status: 200 }));
    await renderPage();
    expect(container.textContent).toContain("Some data failed to load");
    expect(container.textContent).toContain("Active Samples: HTTP 200 — Response body was not valid JSON");
    expect(kpi("Active Samples")).toBe("—");
  });

  it("R5 failed claims hide Available, Ready and stale claim badges for every node", async () => {
    useOrchestratorStore.setState({ claims: CLAIMS });
    const untrustedClaims = [{ ...CLAIMS[0], claimedBy: "untrusted-claim" }];
    answers.set("/api/orchestrator/claims", () => json({ message: "Claims failed", claims: untrustedClaims }, 500));
    await renderPage();
    expect(container.textContent).not.toContain("Available");
    expect(container.textContent).not.toContain("Ready");
    expect(container.textContent).not.toContain("Claimed by");
    for (const node of GRAPH.nodes) {
      const labels = [...container.querySelectorAll("span")].filter((element) =>
        element.textContent === node.label && element.classList.contains("font-medium"));
      expect(labels, `both displays of ${node.label}`).toHaveLength(2);
      for (const label of labels) {
        expect(label.parentElement!.parentElement!.textContent).toContain("Claim status unknown");
      }
    }
    expect(kpi("Active Claims")).toBe("—");
    expect(useOrchestratorStore.getState().claims).toEqual(CLAIMS);
  });

  it("R6 failed graphs hide stale graph cards and Instrument Status", async () => {
    useOrchestratorStore.setState({ graphs: [GRAPH] });
    answers.set("/api/orchestrator/graphs", () => json({ message: "Graphs failed", graphs: [] }, 500));
    await renderPage();
    expect([...container.querySelectorAll("h3")].map((element) => element.textContent)).not.toContain("Transfer Graph");
    expect(container.textContent).not.toContain("View Detail");
    expect(container.textContent).not.toContain("Instrument Status");
    expect(kpi("Transfer Graphs")).toBe("—");
    expect(useOrchestratorStore.getState().graphs).toEqual([GRAPH]);
  });

  it("R7 all four successful reads show their counts and claim badges", async () => {
    await renderPage();
    expectOverview();
    expect(useOrchestratorStore.getState()).toMatchObject({ graphs: [GRAPH], samples: SAMPLES, workflows: WORKFLOWS, claims: CLAIMS });
  });

  it.each([true, false])("R8 shared cache, detail first = %s: both pages retain their counts and badges", async (detailFirst) => {
    client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: 30_000 } });
    await renderPage(detailFirst);
    if (detailFirst) expectDetail(); else expectOverview();
    act(() => root.unmount());
    // Keep the query cache, but prevent the first page's store writes from masking a bad cached shape.
    resetData();
    root = createRoot(container);
    await renderPage(!detailFirst);
    if (detailFirst) expectOverview(); else expectDetail();
  });
});
