import { describe, it, expect } from "vitest";
import {
  createJobLifecycle,
  advanceJob,
  recordJobHeartbeat,
  evaluateJobTimeout,
  applyJobTimeout,
  reapTimedOutJobs,
  isTerminalJobStatus,
  JobLifecycleRegistry,
} from "../util/job-lifecycle.js";
import type { TimeoutPolicy } from "../types/job-lifecycle.js";

const S = 1000; // seconds → ms

describe("job-lifecycle: transitions", () => {
  it("creates a queued job", () => {
    const s = createJobLifecycle("job-1", {}, 0);
    expect(s.status).toBe("queued");
    expect(s.createdAt).toBe(0);
    expect(s.acceptedAt).toBeUndefined();
  });

  it("advances queued → dispatched → accepted (the two-phase ACK)", () => {
    let s = createJobLifecycle("job-1", {}, 0);
    s = advanceJob(s, "dispatched", 5 * S);
    expect(s.status).toBe("dispatched");
    expect(s.dispatchedAt).toBe(5 * S);

    s = advanceJob(s, "accepted", 10 * S);
    expect(s.status).toBe("accepted");
    expect(s.acceptedAt).toBe(10 * S);
    // ACK starts the heartbeat clock.
    expect(s.lastHeartbeatAt).toBe(10 * S);
  });

  it("start-of-work sets the execution origin even without an explicit ACK", () => {
    // Gateway-embedded model: queued → executing directly.
    let s = createJobLifecycle("job-1", {}, 0);
    s = advanceJob(s, "executing", 3 * S);
    expect(s.status).toBe("executing");
    expect(s.acceptedAt).toBe(3 * S);
    expect(s.lastHeartbeatAt).toBe(3 * S);
  });

  it("does not move acceptedAt once already set", () => {
    let s = createJobLifecycle("job-1", {}, 0);
    s = advanceJob(s, "accepted", 10 * S);
    s = advanceJob(s, "executing", 20 * S);
    expect(s.acceptedAt).toBe(10 * S); // unchanged
  });

  it("throws on an illegal transition", () => {
    const s = createJobLifecycle("job-1", {}, 0);
    expect(() => advanceJob(s, "completed", 1 * S)).toThrow(/illegal job transition/);
  });

  it("terminal states are terminal", () => {
    expect(isTerminalJobStatus("completed")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    expect(isTerminalJobStatus("cancelled")).toBe(true);
    expect(isTerminalJobStatus("timed_out")).toBe(true);
    expect(isTerminalJobStatus("executing")).toBe(false);
    expect(isTerminalJobStatus("queued")).toBe(false);
  });

  it("advanceJob does not mutate its input", () => {
    const s = createJobLifecycle("job-1", {}, 0);
    const next = advanceJob(s, "dispatched", 5 * S);
    expect(s.status).toBe("queued");
    expect(next).not.toBe(s);
  });
});

describe("job-lifecycle: heartbeat", () => {
  it("records a heartbeat with progress detail and resets the clock", () => {
    let s = createJobLifecycle("job-1", {}, 0);
    s = advanceJob(s, "accepted", 10 * S);
    s = recordJobHeartbeat(s, 25 * S, { progress: 42, lastEventHash: "sha256:abc" });
    expect(s.lastHeartbeatAt).toBe(25 * S);
    expect(s.lastProgress).toBe(42);
    expect(s.lastEventHash).toBe("sha256:abc");
  });

  it("refuses to heartbeat before acceptance", () => {
    const s = createJobLifecycle("job-1", {}, 0);
    expect(() => recordJobHeartbeat(s, 5 * S)).toThrow(/before it is accepted/);
  });

  it("refuses to heartbeat a terminal job", () => {
    let s = createJobLifecycle("job-1", {}, 0);
    s = advanceJob(s, "accepted", 10 * S);
    s = advanceJob(s, "executing", 11 * S);
    s = advanceJob(s, "collecting_evidence", 12 * S);
    s = advanceJob(s, "completed", 13 * S);
    expect(() => recordJobHeartbeat(s, 14 * S)).toThrow(/terminal/);
  });
});

describe("job-lifecycle: evaluateJobTimeout", () => {
  const policy: TimeoutPolicy = {
    dispatchTimeoutS: 30,
    executionTimeoutS: 600,
    heartbeatTimeoutS: 150,
  };

  it("fires dispatch timeout when the kernel never accepts", () => {
    const s = createJobLifecycle("job-1", policy, 0);
    expect(evaluateJobTimeout(s, 29 * S)).toBeNull();
    expect(evaluateJobTimeout(s, 31 * S)).toBe("dispatch");
  });

  it("dispatch timeout also applies while dispatched (not yet accepted)", () => {
    let s = createJobLifecycle("job-1", policy, 0);
    s = advanceJob(s, "dispatched", 5 * S);
    expect(evaluateJobTimeout(s, 31 * S)).toBe("dispatch");
  });

  it("fires heartbeat timeout when the kernel goes dark mid-run", () => {
    let s = createJobLifecycle("job-1", policy, 0);
    s = advanceJob(s, "accepted", 10 * S); // lastHeartbeatAt = 10s
    s = advanceJob(s, "executing", 11 * S);
    // 150s after last heartbeat (10s) = 160s
    expect(evaluateJobTimeout(s, 159 * S)).toBeNull();
    expect(evaluateJobTimeout(s, 161 * S)).toBe("heartbeat");
  });

  it("a heartbeat extends the heartbeat window (long-but-healthy job)", () => {
    let s = createJobLifecycle("job-1", policy, 0);
    s = advanceJob(s, "accepted", 10 * S);
    s = advanceJob(s, "executing", 11 * S);
    s = recordJobHeartbeat(s, 140 * S); // alive again
    expect(evaluateJobTimeout(s, 200 * S)).toBeNull(); // 60s < 150s gap
    expect(evaluateJobTimeout(s, 300 * S)).toBe("heartbeat"); // 160s > 150s
  });

  it("fires execution timeout when there is no heartbeat policy", () => {
    const execOnly: TimeoutPolicy = { executionTimeoutS: 600 };
    let s = createJobLifecycle("job-1", execOnly, 0);
    s = advanceJob(s, "accepted", 0);
    expect(evaluateJobTimeout(s, 599 * S)).toBeNull();
    expect(evaluateJobTimeout(s, 601 * S)).toBe("execution");
  });

  it("heartbeat takes precedence over execution (catches dark kernel first)", () => {
    let s = createJobLifecycle("job-1", policy, 0);
    s = advanceJob(s, "accepted", 0); // lastHeartbeat = 0
    // 700s: both execution (>600) and heartbeat (>150) breached → heartbeat wins.
    expect(evaluateJobTimeout(s, 700 * S)).toBe("heartbeat");
  });

  it("does not time out once work is done (collecting_evidence/awaiting_pickup)", () => {
    let s = createJobLifecycle("job-1", policy, 0);
    s = advanceJob(s, "accepted", 0);
    s = advanceJob(s, "executing", 1 * S);
    s = advanceJob(s, "collecting_evidence", 2 * S);
    // Way past every deadline, but the work finished — no spurious timeout (open Q9).
    expect(evaluateJobTimeout(s, 100_000 * S)).toBeNull();
  });

  it("omitted policy fields disable that phase's timeout (back-compat)", () => {
    const noPolicy: TimeoutPolicy = {};
    let s = createJobLifecycle("job-1", noPolicy, 0);
    expect(evaluateJobTimeout(s, 10_000 * S)).toBeNull();
    s = advanceJob(s, "accepted", 0);
    expect(evaluateJobTimeout(s, 10_000 * S)).toBeNull();
  });

  it("returns null for terminal jobs", () => {
    let s = createJobLifecycle("job-1", policy, 0);
    s = advanceJob(s, "cancelled", 1 * S);
    expect(evaluateJobTimeout(s, 10_000 * S)).toBeNull();
  });
});

describe("job-lifecycle: applyJobTimeout", () => {
  it("records cause, breached deadline, and ISO timestamps", () => {
    const policy: TimeoutPolicy = { heartbeatTimeoutS: 150 };
    let s = createJobLifecycle("job-1", policy, 0);
    s = advanceJob(s, "accepted", 10 * S); // lastHeartbeatAt = 10s
    const timedOut = applyJobTimeout(s, "heartbeat", 200 * S);

    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.terminatedAt).toBe(200 * S);
    expect(timedOut.timeout?.cause).toBe("heartbeat");
    expect(timedOut.timeout?.deadlineSeconds).toBe(150);
    expect(timedOut.timeout?.observedAt).toBe(new Date(200 * S).toISOString());
    expect(timedOut.timeout?.lastHeartbeatAt).toBe(new Date(10 * S).toISOString());
  });

  it("refuses to time out a terminal job", () => {
    let t = createJobLifecycle("job-2", {}, 0);
    t = advanceJob(t, "cancelled", 1 * S);
    expect(() => applyJobTimeout(t, "execution", 2 * S)).toThrow(/terminal/);
  });
});

describe("job-lifecycle: reapTimedOutJobs (pure)", () => {
  it("returns only the jobs that have breached a deadline", () => {
    const policy: TimeoutPolicy = { dispatchTimeoutS: 30 };
    const a = createJobLifecycle("a", policy, 0); // queued at 0
    const b = createJobLifecycle("b", policy, 20 * S); // queued at 20s
    const fired = reapTimedOutJobs([a, b], 35 * S);
    // a: 35s elapsed > 30 → dispatch; b: 15s elapsed < 30 → fine.
    expect(fired).toEqual([{ jobId: "a", cause: "dispatch" }]);
  });
});

describe("JobLifecycleRegistry (in-memory ACK + heartbeat monitor)", () => {
  it("drives a full happy path with an injected clock", () => {
    let nowMs = 0;
    const reg = new JobLifecycleRegistry(() => nowMs);
    const policy: TimeoutPolicy = { dispatchTimeoutS: 30, heartbeatTimeoutS: 150 };

    reg.create("job-1", policy);
    nowMs = 5 * S;
    reg.dispatch("job-1");
    nowMs = 10 * S;
    reg.ack("job-1");
    expect(reg.get("job-1")?.status).toBe("accepted");

    nowMs = 20 * S;
    reg.advance("job-1", "executing");
    nowMs = 120 * S;
    reg.heartbeat("job-1", { progress: 50 });
    expect(reg.get("job-1")?.lastProgress).toBe(50);

    // Within heartbeat window → reap fires nothing.
    nowMs = 200 * S;
    expect(reg.reap()).toEqual([]);

    // Past heartbeat window → reap times it out.
    nowMs = 300 * S;
    const fired = reg.reap();
    expect(fired.map((f) => f.cause)).toEqual(["heartbeat"]);
    expect(reg.get("job-1")?.status).toBe("timed_out");
  });

  it("reap is idempotent — a timed-out job does not fire again", () => {
    let nowMs = 0;
    const reg = new JobLifecycleRegistry(() => nowMs);
    reg.create("job-1", { dispatchTimeoutS: 30 });
    nowMs = 100 * S;
    expect(reg.reap().map((f) => f.cause)).toEqual(["dispatch"]);
    expect(reg.reap()).toEqual([]); // already terminal
  });

  it("does not time out a job that completed in time", () => {
    let nowMs = 0;
    const reg = new JobLifecycleRegistry(() => nowMs);
    reg.create("job-1", { dispatchTimeoutS: 30, executionTimeoutS: 600 });
    nowMs = 10 * S;
    reg.ack("job-1");
    nowMs = 20 * S;
    reg.advance("job-1", "executing");
    nowMs = 30 * S;
    reg.advance("job-1", "collecting_evidence");
    reg.advance("job-1", "completed");
    nowMs = 100_000 * S;
    expect(reg.reap()).toEqual([]);
    expect(reg.get("job-1")?.status).toBe("completed");
  });

  it("throws on operations against an unknown job", () => {
    const reg = new JobLifecycleRegistry(() => 0);
    expect(() => reg.ack("nope")).toThrow(/unknown job/);
  });
});
