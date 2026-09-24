/**
 * StatusBar honesty tests.
 *
 * The bar is chrome on every dashboard page, so a fabricated value there is
 * a fabricated value everywhere. These tests pin the rule that an unknown
 * count renders as unknown (never 0), that connectivity is never assumed,
 * and that no network name is shown unless the caller supplies one.
 *
 * Rendered with react-dom/server in the node environment; no DOM needed.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBar, type StatusBarProps } from "./StatusBar.js";

function render(props: StatusBarProps = {}): string {
  return renderToStaticMarkup(React.createElement(StatusBar, props));
}

/** Visible text only, so assertions don't depend on class names. */
function text(props: StatusBarProps = {}): string {
  return render(props).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("StatusBar", () => {
  it("shows the build only when given, beside the network", () => {
    expect(render({ networkStatus: "connected", network: "base-sepolia (configured)", build: "build 1a2b3c4" })).toContain("build 1a2b3c4");
    expect(render({ networkStatus: "connected" })).not.toContain("build");
  });

  it("renders unknown counts as a dash, not as zero", () => {
    const t = text();
    expect(t).toContain("— kernels online");
    expect(t).toContain("— active jobs");
    expect(t).not.toMatch(/\b0 kernels online/);
    expect(t).not.toMatch(/\b0 active jobs/);
  });

  it("treats null the same as undefined", () => {
    const t = text({ kernelsOnline: null, activeJobs: null });
    expect(t).toContain("— kernels online");
    expect(t).toContain("— active jobs");
  });

  it("renders a real zero as zero", () => {
    const t = text({ kernelsOnline: 0, activeJobs: 0, networkStatus: "connected" });
    expect(t).toContain("0 kernels online");
    expect(t).toContain("0 active jobs");
  });

  it("renders supplied counts", () => {
    const t = text({ kernelsOnline: 7, activeJobs: 12, networkStatus: "connected" });
    expect(t).toContain("7 kernels online");
    expect(t).toContain("12 active jobs");
  });

  it("renders a count from a possibly truncated list as a lower bound", () => {
    const t = text({ activeJobs: 12, activeJobsAtLeast: true, networkStatus: "connected" });
    expect(t).toContain("12+ active jobs");
    expect(t).not.toMatch(/\b12 active jobs/);
  });

  it("does not claim the gateway is connected by default", () => {
    const t = text();
    expect(t).toContain("Checking gateway");
    expect(t).not.toContain("Gateway online");
  });

  it("labels each connectivity state", () => {
    expect(text({ networkStatus: "connected" })).toContain("Gateway online");
    expect(text({ networkStatus: "disconnected" })).toContain("Gateway unreachable");
    expect(text({ networkStatus: "reconnecting" })).toContain("Reconnecting");
    expect(text({ networkStatus: "unknown" })).toContain("Checking gateway");
  });

  it("shows no network name unless one is supplied", () => {
    expect(text()).not.toMatch(/sepolia|mainnet|base/i);
    expect(text({ network: "base-sepolia" })).toContain("base-sepolia");
  });
});
