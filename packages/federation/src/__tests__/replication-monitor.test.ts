import { describe, expect, it } from "vitest";
import {
  buildHealthReport,
  classifyStandby,
  type StandbyState,
} from "../mesh/replication-monitor.js";

const healthy: StandbyState = {
  name: "s1",
  state: "streaming",
  syncState: "sync",
  applyLagBytes: 1000,
  applyLagMs: 200,
};

describe("classifyStandby", () => {
  it("returns healthy under thresholds", () => {
    expect(classifyStandby(healthy)).toBe("healthy");
  });

  it("returns lagging when bytes exceed threshold", () => {
    expect(
      classifyStandby({ ...healthy, applyLagBytes: 2_000_000 }),
    ).toBe("lagging");
  });

  it("returns lagging when ms exceed threshold", () => {
    expect(
      classifyStandby({ ...healthy, applyLagMs: 99_999 }),
    ).toBe("lagging");
  });

  it("returns lagging when not streaming", () => {
    expect(
      classifyStandby({ ...healthy, state: "catchup" }),
    ).toBe("lagging");
  });

  it("returns stopped on stopping state", () => {
    expect(
      classifyStandby({ ...healthy, state: "stopping" }),
    ).toBe("stopped");
  });

  it("returns stopped on unknown state", () => {
    expect(
      classifyStandby({ ...healthy, state: "unknown" }),
    ).toBe("stopped");
  });

  it("ignores undefined applyLagMs", () => {
    expect(
      classifyStandby({ ...healthy, applyLagMs: undefined }),
    ).toBe("healthy");
  });

  it("respects custom thresholds", () => {
    const tight = { maxApplyLagBytes: 100, maxApplyLagMs: 50 };
    expect(classifyStandby(healthy, tight)).toBe("lagging");
  });
});

describe("buildHealthReport", () => {
  it("HEALTHY when all standbys are healthy and one is sync", () => {
    const r = buildHealthReport([healthy, { ...healthy, name: "s2" }]);
    expect(r.verdict).toBe("HEALTHY");
    expect(r.hasHealthySyncStandby).toBe(true);
    expect(r.syncCapacityCount).toBe(2);
  });

  it("DEGRADED when some standbys lag but sync standby is healthy", () => {
    const r = buildHealthReport([
      healthy,
      { ...healthy, name: "s2", syncState: "async", applyLagBytes: 99_999_999 },
    ]);
    expect(r.verdict).toBe("DEGRADED");
    expect(r.hasHealthySyncStandby).toBe(true);
  });

  it("CRITICAL when no sync standby is healthy (writes blocked)", () => {
    const r = buildHealthReport([
      { ...healthy, syncState: "async" },
      { ...healthy, name: "s2", syncState: "async" },
    ]);
    expect(r.verdict).toBe("CRITICAL");
    expect(r.hasHealthySyncStandby).toBe(false);
    expect(r.syncCapacityCount).toBe(0);
  });

  it("CRITICAL when the sync standby is unhealthy", () => {
    const r = buildHealthReport([
      {
        ...healthy,
        applyLagBytes: 99_999_999,
      },
    ]);
    expect(r.verdict).toBe("CRITICAL");
  });

  it("handles empty standby list as CRITICAL", () => {
    const r = buildHealthReport([]);
    expect(r.verdict).toBe("CRITICAL");
    expect(r.standbys).toHaveLength(0);
  });

  it("includes per-standby health in the report", () => {
    const r = buildHealthReport([
      healthy,
      { ...healthy, name: "stop", state: "stopping" },
    ]);
    expect(r.standbys[0]?.health).toBe("healthy");
    expect(r.standbys[1]?.health).toBe("stopped");
  });

  it("quorum syncState counts as sync capacity", () => {
    const r = buildHealthReport([
      { ...healthy, syncState: "quorum" },
      { ...healthy, name: "s2", syncState: "quorum" },
    ]);
    expect(r.syncCapacityCount).toBe(2);
    expect(r.hasHealthySyncStandby).toBe(true);
  });
});
