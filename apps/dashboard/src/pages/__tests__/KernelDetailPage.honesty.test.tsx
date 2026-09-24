/**
 * N51: KernelDetail reads the real kernel snapshot.
 *
 * It read api/mock-data.ts (empty arrays), so every kernel opened from the
 * live Kernels list said "Kernel not found". It also showed a DID badge built
 * from the id (no route serves a kernel DID) and job names and amounts from
 * an empty jobMeta table.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelDetailPage } from "../KernelDetailPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { status: number; body: unknown } | "network-error";

function stubKernel(reply: Reply) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (reply === "network-error") throw new TypeError("Failed to fetch");
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        statusText: reply.status === 404 ? "Not Found" : reply.status === 200 ? "OK" : "Error",
        headers: { get: () => null },
        json: async () => reply.body,
      } as unknown as Response;
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(kernelId: string): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/kernels/${kernelId}`]}>
          <Routes>
            <Route path="/kernels/:kernelId" element={<KernelDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    if (client.isFetching() === 0) break;
  }
  return container.textContent ?? "";
}

const SNAPSHOT = {
  kernel: {
    id: "kernel-real-1",
    name: "Real Workshop",
    operatorAddress: "operator@example.test",
    location: { lat: 37.7749, lng: -122.4194 },
    physicalAddress: "1 Trace St",
    maxAssuranceTier: 2,
    status: "online",
    lastHeartbeat: "2026-09-24T12:00:00Z",
    version: "0.1.0",
    capabilityCount: 1,
    capabilityTypes: ["manufacturing.fdm"],
    totalJobsCompleted: 3,
    isStale: false,
    devices: [{ id: "dev-1", type: "machine", model: "Prusa MK4", status: "busy", healthStatus: "healthy", adapterType: "octoprint", capabilities: [] }],
    recentJobs: [
      { id: "job-running", status: "in_progress", progress: 40 },
      { id: "job-done", status: "completed", progress: 100 },
    ],
  },
};

describe("KernelDetailPage", () => {
  it("renders the gateway's snapshot for a real kernel", async () => {
    stubKernel({ status: 200, body: SNAPSHOT });
    const t = await render("kernel-real-1");
    expect(t).toContain("Real Workshop");
    expect(t).toContain("Prusa MK4");
    expect(t).toContain("manufacturing.fdm");
    expect(t).toContain("job-running");
    expect(t).not.toContain("job-done"); // not active
    expect(t).toContain("Declared Max Tier");
    expect(t).not.toContain("Kernel not found");
    expect(t).not.toContain("did:pcc:kernel");
  });

  it("says 'not found' only when the gateway says 404", async () => {
    stubKernel({ status: 404, body: { error: "not_found" } });
    const t = await render("no-such-kernel");
    expect(t).toContain("Kernel not found");
  });

  it("says unavailable, not 'not found', when the gateway is down", async () => {
    stubKernel("network-error");
    const t = await render("kernel-real-1");
    expect(t).toContain("Couldn't load this kernel");
    expect(t).not.toContain("Kernel not found");
  });
});
