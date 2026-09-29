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
import { COUNT_MAX_AGE_MS, deriveHomeStatus, deriveLiveStatus, isKernelOnline, type QueryView } from "../live-status.js";
import type { JobDTO, KernelDTO } from "../../types/dto.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A successful read, `ageMs` old; `lastErrorAgoMs` places an earlier failed read. */
function ok<T>(data: T, ageMs = 1_000, lastErrorAgoMs?: number): QueryView<T> {
  const now = Date.now();
  return {
    data,
    isSuccess: true,
    isError: false,
    dataUpdatedAt: now - ageMs,
    errorUpdatedAt: lastErrorAgoMs === undefined ? 0 : now - lastErrorAgoMs,
  };
}
/** The latest read failed just now; `staleData` is what an earlier read left in the cache. */
function failed<T>(staleData?: T): QueryView<T> {
  const now = Date.now();
  return { data: staleData, isSuccess: false, isError: true, dataUpdatedAt: staleData ? now - 60_000 : 0, errorUpdatedAt: now - 500 };
}
function loading<T>(): QueryView<T> {
  return { data: undefined, isSuccess: false, isError: false, dataUpdatedAt: 0, errorUpdatedAt: 0 };
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

describe("counts are current, not just cached (astra round 2, #352 finding 1)", () => {
  it("a count read before an outage stays hidden when the gateway answers again, until it is re-read", () => {
    // The health check failed 5 s ago and has since answered ok again.
    const recovered = ok({ status: "ok" }, 500, 5_000);
    const before = deriveLiveStatus({ health: recovered, kernels: ok([kernel("online")], 10_000), jobs: ok([job("queued")], 10_000) });
    expect(before.networkStatus).toBe("connected");
    expect(before.kernelsOnline).toBeUndefined();
    expect(before.activeJobs).toBeUndefined();

    const reread = deriveLiveStatus({ health: recovered, kernels: ok([kernel("online")], 1_000), jobs: ok([job("queued")], 1_000) });
    expect(reread.kernelsOnline).toBe(1);
    expect(reread.activeJobs).toBe(1);
  });

  it("a count older than COUNT_MAX_AGE_MS is not shown as current", () => {
    const old = COUNT_MAX_AGE_MS + 1_000;
    const props = deriveLiveStatus({ health: ok({ status: "ok" }), kernels: ok([kernel("online")], old), jobs: ok([job("queued")], old) });
    expect(props.kernelsOnline).toBeUndefined();
    expect(props.activeJobs).toBeUndefined();
  });

  it("a kernel that doesn't say whether its heartbeat is fresh is not counted online", () => {
    const unsaid = { id: "k-unsaid", status: "online" } as KernelDTO;
    expect(isKernelOnline(unsaid)).toBe(false);
    expect(deriveLiveStatus({ health: ok({ status: "ok" }), kernels: ok([unsaid]), jobs: ok([]) }).kernelsOnline).toBe(0);
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
  const healthy = () => ok({ status: "ok" });
  const homeData = (over: Record<string, unknown> = {}) =>
    ({
      schemaId: "pcc.product-home/v1",
      asOf: "2026-09-24T12:00:00.000Z",
      kernels: { state: "read", total: 3, online: 2, stale: 1, other: 0, rule: "r", source: "gateway_kernel_rows" },
      capabilities: { state: "read", total: 0, onOnlineKernels: 0, byType: [], source: "gateway_capability_rows" },
      jobs: { state: "read", total: 300, active: 120, byPhase: {}, source: "gateway_job_rows" },
      settlementNetwork: { name: "base-sepolia", chainId: 84532, basis: "gateway_config" },
      escrowHeld: { state: "unavailable", reason: "escrow rows could not be read" },
      ...over,
    }) as never;
  /** A successful ProductHome read, `ageMs` old. */
  const home = (over: Record<string, unknown> = {}, ageMs = 1_000) => ok(homeData(over), ageMs);

  it("uses the gateway's exact counts: 120 active jobs, not a lower bound over 50", () => {
    expect(deriveHomeStatus({ health: healthy(), home: home() })).toEqual({
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
    const withBuild = (commit: unknown, commitSource: unknown) => ok({ status: "ok", commit, commitSource });
    expect(deriveHomeStatus({ health: withBuild(sha, "image_build"), home: home() }).build).toBe("build 0123456");
    expect(deriveHomeStatus({ health: withBuild(sha, "unknown"), home: home() }).build).toBeUndefined();
    expect(deriveHomeStatus({ health: withBuild("not-a-sha", "image_build"), home: home() }).build).toBeUndefined();
    expect(deriveHomeStatus({ health: withBuild(null, "unknown"), home: home() }).build).toBeUndefined();
  });

  it("a section the gateway couldn't read is unknown, never 0", () => {
    const s = deriveHomeStatus({ health: healthy(), home: home({ jobs: { state: "unavailable", reason: "x" } }) });
    expect(s.activeJobs).toBeUndefined();
    expect(s.kernelsOnline).toBe(2);
  });

  it("shows no counts unless the gateway is confirmed reachable", () => {
    expect(deriveHomeStatus({ health: failed<{ status: string }>(), home: home() })).toMatchObject({
      networkStatus: "disconnected",
      kernelsOnline: undefined,
      activeJobs: undefined,
      network: undefined,
    });
    expect(deriveHomeStatus({ health: healthy(), home: failed() })).toMatchObject({ kernelsOnline: undefined, activeJobs: undefined });
  });

  it("ProductHome read before an outage stays hidden when the gateway answers again, until it is re-read (#352 round 3)", () => {
    // The health check failed 5 s ago and has since answered ok again.
    const recovered = ok({ status: "ok" }, 500, 5_000);
    const before = deriveHomeStatus({ health: recovered, home: home({}, 10_000) });
    expect(before.networkStatus).toBe("connected");
    expect(before.kernelsOnline).toBeUndefined();
    expect(before.activeJobs).toBeUndefined();
    expect(deriveHomeStatus({ health: recovered, home: home({}, 1_000) })).toMatchObject({ kernelsOnline: 2, activeJobs: 120 });
  });

  it("ProductHome older than COUNT_MAX_AGE_MS is not shown as current", () => {
    expect(deriveHomeStatus({ health: healthy(), home: home({}, COUNT_MAX_AGE_MS + 1_000) })).toMatchObject({
      kernelsOnline: undefined,
      activeJobs: undefined,
    });
  });
});
