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
import { deriveLiveStatus, type QueryView, deriveHomeStatus } from "../live-status.js";
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
    ).toEqual({ networkStatus: "unknown", kernelsOnline: undefined, activeJobs: undefined, activeJobsAtLeast: false });
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

  it("hides counts read before an outage once the gateway stops answering", () => {
    const props = deriveLiveStatus({
      health: failed({ status: "ok" }),
      kernels: ok([kernel("online")]),
      jobs: ok([job("in_progress")]),
    });
    expect(props.networkStatus).toBe("disconnected");
    expect(props.kernelsOnline).toBeUndefined();
    expect(props.activeJobs).toBeUndefined();
  });

  it("does not vouch for counts before liveness is known", () => {
    const props = deriveLiveStatus({ health: loading(), kernels: ok([kernel("online")]), jobs: ok([job("queued")]) });
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

describe("job counts from a full page are lower bounds", () => {
  const page = (n: number, active: number) =>
    Array.from({ length: n }, (_, i) => job(i < active ? "in_progress" : "completed"));

  it("a full page (50 rows) makes the active count a lower bound", () => {
    const props = deriveLiveStatus({ health: ok({ status: "ok" }), kernels: ok([]), jobs: ok(page(50, 10)) });
    expect(props.activeJobs).toBe(10);
    expect(props.activeJobsAtLeast).toBe(true);
  });

  it("a short page is exact", () => {
    const props = deriveLiveStatus({ health: ok({ status: "ok" }), kernels: ok([]), jobs: ok(page(49, 10)) });
    expect(props.activeJobs).toBe(10);
    expect(props.activeJobsAtLeast).toBe(false);
  });

  it("an unknown count is never marked as a lower bound", () => {
    expect(deriveLiveStatus({ health: failed(), kernels: failed(), jobs: failed() }).activeJobsAtLeast).toBe(false);
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

describe("deriveHomeStatus: the StatusBar from ProductHomeDTO", () => {
  const ok = { data: { status: "ok" }, isSuccess: true, isError: false };
  const home = (over: Record<string, unknown> = {}) => ({
    data: {
      schemaId: "pcc.product-home/v1",
      asOf: "2026-09-24T12:00:00.000Z",
      kernels: { state: "read", total: 3, online: 2, stale: 1, other: 0, rule: "r", source: "gateway_kernel_rows" },
      capabilities: { state: "read", total: 0, onOnlineKernels: 0, byType: [], source: "gateway_capability_rows" },
      jobs: { state: "read", total: 300, active: 120, byPhase: {}, source: "gateway_job_rows" },
      settlementNetwork: { name: "base-sepolia", chainId: 84532, basis: "gateway_config" },
      escrowHeld: { state: "unavailable", reason: "escrow rows could not be read" },
      ...over,
    } as never,
    isSuccess: true,
    isError: false,
  });

  it("uses the gateway's exact counts: 120 active jobs, not a lower bound over 50", () => {
    expect(deriveHomeStatus({ health: ok, home: home() })).toEqual({
      networkStatus: "connected",
      kernelsOnline: 2,
      activeJobs: 120,
      activeJobsAtLeast: false,
      network: "base-sepolia (configured)",
      build: undefined,
    });
  });

  it("shows the served build only for an image-baked, well-formed commit (N5)", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const withBuild = (commit: unknown, commitSource: unknown) => ({ data: { status: "ok", commit, commitSource }, isSuccess: true, isError: false });
    expect(deriveHomeStatus({ health: withBuild(sha, "image_build"), home: home() }).build).toBe("build 0123456");
    expect(deriveHomeStatus({ health: withBuild(sha, "unknown"), home: home() }).build).toBeUndefined();
    expect(deriveHomeStatus({ health: withBuild("not-a-sha", "image_build"), home: home() }).build).toBeUndefined();
    expect(deriveHomeStatus({ health: withBuild(null, "unknown"), home: home() }).build).toBeUndefined();
  });

  it("a section the gateway couldn't read is unknown, never 0", () => {
    const s = deriveHomeStatus({ health: ok, home: home({ jobs: { state: "unavailable", reason: "x" } }) });
    expect(s.activeJobs).toBeUndefined();
    expect(s.kernelsOnline).toBe(2);
  });

  it("shows no counts unless the gateway is confirmed reachable", () => {
    const down = { data: undefined, isSuccess: false, isError: true };
    expect(deriveHomeStatus({ health: down, home: home() })).toMatchObject({ networkStatus: "disconnected", kernelsOnline: undefined, activeJobs: undefined, network: undefined });
    const failed = { data: undefined, isSuccess: false, isError: true };
    expect(deriveHomeStatus({ health: ok, home: failed })).toMatchObject({ kernelsOnline: undefined, activeJobs: undefined });
  });
});
