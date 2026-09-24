/**
 * The dashboard StatusBar must show live state or say it has none.
 *
 * deriveLiveStatus is the whole decision; LiveStatusBar only feeds it
 * react-query results. Before this, App.tsx passed kernelsOnline={2},
 * activeJobs={3} and networkStatus="connected" to every page.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deriveLiveStatus, type QueryView } from "../live-status.js";
import type { JobDTO, KernelDTO } from "../../types/dto.js";

const here = dirname(fileURLToPath(import.meta.url));

function ok<T>(data: T): QueryView<T> {
  return { data, isSuccess: true, isError: false };
}
function failed<T>(staleData?: T): QueryView<T> {
  return { data: staleData, isSuccess: false, isError: true };
}
function loading<T>(): QueryView<T> {
  return { data: undefined, isSuccess: false, isError: false };
}

function kernel(status: KernelDTO["status"], isStale = false): KernelDTO {
  return { id: `k-${status}-${isStale}`, status, isStale } as KernelDTO;
}
function job(status: string): JobDTO {
  return { id: `j-${status}`, status } as unknown as JobDTO;
}

describe("deriveLiveStatus", () => {
  it("reports nothing as known while the reads are loading", () => {
    expect(
      deriveLiveStatus({ health: loading(), kernels: loading(), jobs: loading() }),
    ).toEqual({ networkStatus: "unknown", kernelsOnline: undefined, activeJobs: undefined });
  });

  it("shows unavailable, not zero, when the gateway is down", () => {
    const props = deriveLiveStatus({ health: failed(), kernels: failed(), jobs: failed() });
    expect(props.networkStatus).toBe("disconnected");
    expect(props.kernelsOnline).toBeUndefined();
    expect(props.activeJobs).toBeUndefined();
  });

  it("does not show a stale count after a refresh fails", () => {
    const props = deriveLiveStatus({
      health: ok({ status: "ok" }),
      kernels: failed([kernel("online")]),
      jobs: failed([job("in_progress")]),
    });
    expect(props.kernelsOnline).toBeUndefined();
    expect(props.activeJobs).toBeUndefined();
  });

  it("is connected only when /api/health answered ok", () => {
    const base = { kernels: loading<KernelDTO[]>(), jobs: loading<JobDTO[]>() };
    expect(deriveLiveStatus({ ...base, health: ok({ status: "ok" }) }).networkStatus).toBe("connected");
    expect(deriveLiveStatus({ ...base, health: ok({ status: "degraded" }) }).networkStatus).toBe(
      "disconnected",
    );
  });

  it("counts only fresh online kernels", () => {
    const props = deriveLiveStatus({
      health: ok({ status: "ok" }),
      kernels: ok([
        kernel("online"),
        kernel("online"),
        kernel("online", true),
        kernel("offline"),
        kernel("maintenance"),
      ]),
      jobs: ok([]),
    });
    expect(props.kernelsOnline).toBe(2);
    expect(props.activeJobs).toBe(0);
  });

  it("counts only the gateway's in-flight job statuses; unknown statuses are not active", () => {
    const props = deriveLiveStatus({
      health: ok({ status: "ok" }),
      kernels: ok([]),
      jobs: ok(
        ["pending", "queued", "in_progress", "paused", "completed", "failed", "cancelled", "running", "mystery"].map(
          job,
        ),
      ),
    });
    expect(props.activeJobs).toBe(4);
    expect(props.kernelsOnline).toBe(0);
  });
});

describe("App.tsx status bar wiring", () => {
  const app = readFileSync(resolve(here, "../../App.tsx"), "utf-8");

  it("renders the live status bar", () => {
    expect(app).toContain("<LiveStatusBar />");
  });

  it("passes no literal counts or connectivity to a status bar", () => {
    expect(app).not.toMatch(/kernelsOnline=\{\s*\d/);
    expect(app).not.toMatch(/activeJobs=\{\s*\d/);
    expect(app).not.toMatch(/networkStatus="connected"/);
  });
});
