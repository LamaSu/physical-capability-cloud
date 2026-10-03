/**
 * Reproduces the /discover and /leaderboard cold-load crash (steward #3836, HIGH):
 * a hook declared after an early return changes the hook count between the
 * "loading" render and the "loaded" render — React #310, "Rendered more hooks
 * than during the previous render". With a single ErrorBoundary, this takes
 * the whole shell down.
 *
 * Bug commit fa5871c4 (2026-04-14) is an ancestor of production. Fixed upstream
 * by #352 (large, still in review) — this test is the hotfix's proof that the
 * fast-path fix (moving the hooks above the early return) actually works.
 *
 * Adapted from pcc-design's verified repro:
 * pcc-reconciliation/returns/pcc-design-work/survey/repro-hook-order.test.tsx
 * (see .../survey/SUMMARY.md, row "/discover and /leaderboard crash on a cold load").
 *
 * Like usePointMap3DPlayback.test.ts, there is no React Testing Library in the
 * dashboard, so this mounts the real page components with react-dom/client +
 * React's `act`, in jsdom, and mocks only the data-fetching hooks module so the
 * loading -> loaded transition is deterministic.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

// React 18+ requires this flag so act() knows it's in a test env — set as
// early as possible, before any render (see usePointMap3DPlayback.test.ts).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Shared mutable state the mocked hooks read from. `loading` drives the
// cold-load transition (true -> false between the two renders in coldLoad);
// `kernels` lets individual tests control what useKernels() returns.
const state: { loading: boolean; kernels: unknown[] } = {
  loading: true,
  kernels: [],
};

vi.mock("../../api/hooks/use-pcc-data.js", () => ({
  useCapabilityTemplates: () => ({
    data: state.loading ? undefined : { templates: [] },
    isLoading: state.loading,
  }),
  useKernels: () => ({ data: state.kernels, isLoading: state.loading }),
  useCapabilities: () => ({
    data: state.loading ? undefined : { items: [], total: 0 },
    isLoading: state.loading,
  }),
}));

afterEach(() => {
  state.loading = true;
  state.kernels = [];
});

/**
 * Mounts `Page` through a cold load: a first render while the data hooks
 * report isLoading, then a second render — same component instance, same
 * tree position, a new element object — once the data has "arrived". This is
 * exactly the transition that changes the hook count when a hook sits after
 * an early return.
 *
 * Returns the first uncaught render error (if any) and the mounted text, so
 * callers can assert both "did not crash" and "real content showed".
 */
async function coldLoad(
  Page: React.ComponentType,
): Promise<{ error: string | null; text: string }> {
  state.loading = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const errors: string[] = [];
  const root = createRoot(host, {
    onUncaughtError: (e: unknown) => errors.push(String((e as Error).message)),
  } as never);
  // A NEW element object each render, same type and position: React re-renders
  // the SAME Page instance (this is what a react-query cache update does).
  const tree = () => React.createElement(MemoryRouter, null, React.createElement(Page));
  let text = "";
  try {
    act(() => root.render(tree()));
    state.loading = false;
    act(() => root.render(tree()));
    text = host.textContent ?? "";
  } catch (e) {
    errors.push(String((e as Error).message));
  } finally {
    try {
      act(() => root.unmount());
    } catch {
      /* already torn down by the uncaught error */
    }
    host.remove();
  }
  return { error: errors[0] ?? null, text };
}

describe("live pages survive a cold load (React #310)", () => {
  it("DiscoverPage renders through loading into loaded data without crashing", async () => {
    const { DiscoverPage } = await import("../DiscoverPage.js");
    const { error, text } = await coldLoad(DiscoverPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("No capabilities available");
  });

  it("KernelLeaderboardPage renders through loading into loaded data without crashing", async () => {
    const mod = await import("../KernelLeaderboardPage.js");
    const Page =
      (mod as Record<string, unknown>).KernelLeaderboardPage ??
      (mod as Record<string, unknown>).default;
    const { error, text } = await coldLoad(Page as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("No kernels on the network yet");
  });
});

describe("KernelsPage: kernel.location must never render as a React child", () => {
  // #352 also fixes this: KernelsPage rendered kernel.location — a {lat, lng}
  // object straight off the KernelDTO — as a React child, which crashes with
  // "Objects are not valid as a React child".
  it("renders a kernel whose location is a {lat, lng} object without crashing", async () => {
    state.kernels = [
      {
        id: "kernel-geo-1",
        name: "Geo Kernel",
        operatorAddress: "0x00",
        location: { lat: 37.77, lng: -122.42 },
        physicalAddress: "123 Maker St, SF CA",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("Geo Kernel");
  });

  // astra's #488 follow-up review (H488-coldload-hotfix-269f36ee.astra.verdict.md):
  //
  // MEDIUM — a gateway kernel's location is untrusted JSON (apps/dashboard/src/api/gateway.ts
  // returns res.json() with no runtime validation), but KernelsPage.tsx:62 calls
  // `.toFixed()` on `location.lat` / `location.lng` unconditionally whenever `location` is
  // truthy. A non-numeric, NaN, or partially-missing coordinate pair reaches `.toFixed()`
  // and crashes the page instead of falling back to "Location not set".
  it("renders a kernel with a non-numeric lat as \"Location not set\" instead of crashing", async () => {
    state.kernels = [
      {
        id: "kernel-geo-bad-string",
        name: "String Coord Kernel",
        operatorAddress: "0x00",
        location: { lat: "37.77", lng: -122.42 },
        physicalAddress: "",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("Location not set");
  });

  it("renders a kernel with a NaN lat as \"Location not set\" instead of crashing", async () => {
    state.kernels = [
      {
        id: "kernel-geo-bad-nan",
        name: "NaN Coord Kernel",
        operatorAddress: "0x00",
        location: { lat: NaN, lng: 1 },
        physicalAddress: "",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("Location not set");
  });

  it("renders a kernel with a missing lat as \"Location not set\" instead of crashing", async () => {
    state.kernels = [
      {
        id: "kernel-geo-bad-missing",
        name: "Missing Lat Kernel",
        operatorAddress: "0x00",
        location: { lng: 1 },
        physicalAddress: "",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("Location not set");
  });

  // LOW — the "Geo Kernel" case above has a non-empty physicalAddress, so it never
  // exercises the coordinate-formatting branch at all: it asserts only the kernel name.
  // This case has no physicalAddress and no location.label, so the coordinate text is
  // what actually renders — covering the branch the MEDIUM fix above changes.
  it("renders the formatted coordinates when there is no address or label", async () => {
    state.kernels = [
      {
        id: "kernel-geo-coords-only",
        name: "Coordinate Only Kernel",
        operatorAddress: "0x00",
        location: { lat: 37.77, lng: -122.42 },
        physicalAddress: "",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("37.7700, -122.4200");
  });

  // astra's H491 follow-up review (H491-location-followup-0c32f77a.astra.verdict.md),
  // on top of the MEDIUM fixed above:
  //
  // MEDIUM — `kernel.physicalAddress || kernel.location?.label || (...)` renders
  // whichever operand is truthy first. A non-empty *object* is truthy, so a
  // malformed `location.label` crashes the same way the old {lat,lng} location
  // object once did — "Objects are not valid as a React child".
  it("renders \"Location not set\" instead of crashing when location.label is an object", async () => {
    state.kernels = [
      {
        id: "kernel-geo-bad-label-object",
        name: "Object Label Kernel",
        operatorAddress: "0x00",
        location: { label: {} },
        physicalAddress: "",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("Location not set");
  });

  // MEDIUM — the coordinate branch checks only Number.isFinite, never a real
  // geographic range, so out-of-range coordinates render as if they were a
  // real location instead of falling back to "Location not set".
  it("renders \"Location not set\", not \"91.0000, 181.0000\", for out-of-range coordinates", async () => {
    state.kernels = [
      {
        id: "kernel-geo-out-of-range",
        name: "Out Of Range Kernel",
        operatorAddress: "0x00",
        location: { lat: 91, lng: 181 },
        physicalAddress: "",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("Location not set");
    expect(text).not.toContain("91.0000");
  });

  // Same class of defect as the object-label case above, on physicalAddress
  // instead: an object is truthy, so it crashes before ever falling through
  // to the valid coordinates sitting right behind it.
  it("renders the coordinates, not a crash, when physicalAddress is an object", async () => {
    state.kernels = [
      {
        id: "kernel-address-object",
        name: "Object Address Kernel",
        operatorAddress: "0x00",
        location: { lat: 37.77, lng: -122.42 },
        physicalAddress: {},
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("37.7700, -122.4200");
  });

  // Not reproduced: an empty string is already falsy in the existing `||`
  // chain, so an empty label is already skipped in favor of the valid
  // coordinates behind it — no crash, no blank line, nothing wrong. Kept as
  // a guard: the fix's "label only if it's a non-empty string" check must
  // keep taking this same path, not treat "" as a present label.
  it("renders the coordinates, not a blank label, when location.label is an empty string", async () => {
    state.kernels = [
      {
        id: "kernel-empty-label-valid-coords",
        name: "Empty Label Kernel",
        operatorAddress: "0x00",
        location: { label: "", lat: 37.77, lng: -122.42 },
        physicalAddress: "",
        maxAssuranceTier: 2,
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        version: "1.0",
        capabilityCount: 0,
        capabilityTypes: [],
        totalJobsCompleted: 0,
        isStale: false,
      },
    ];
    const { KernelsPage } = await import("../KernelsPage.js");
    const { error, text } = await coldLoad(KernelsPage as React.ComponentType);
    expect(error).toBeNull();
    expect(text).toContain("37.7700, -122.4200");
  });
});
