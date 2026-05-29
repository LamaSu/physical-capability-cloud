import { describe, it, expect } from "vitest";
import {
  RunStateChangeHook,
  TaskStateChangeHook,
  SafetyStateChangeHook,
  LabwareMovementHook,
  NewPlanHook,
  parseHook,
} from "../hooks.js";

describe("LINQ hook classes", () => {
  it("RunStateChangeHook parses a valid payload", () => {
    const h = new RunStateChangeHook({
      event: "run_state_change",
      workflow_id: "wf-1",
      run_id: "run-1",
      previous_state: "running",
      current_state: "completed",
      timestamp: "2026-05-28T00:00:00Z",
    });
    expect(h.run_id).toBe("run-1");
    expect(h.current_state).toBe("completed");
  });

  it("TaskStateChangeHook parses task-state event", () => {
    const h = new TaskStateChangeHook({
      event: "task_state_change",
      workflow_id: "wf-1",
      run_id: "run-1",
      task_id: "task-3",
      current_state: "running",
      timestamp: "2026-05-28T00:00:01Z",
      instrument_id: "pf400-arm",
    });
    expect(h.task_id).toBe("task-3");
    expect(h.instrument_id).toBe("pf400-arm");
  });

  it("SafetyStateChangeHook parses estop event", () => {
    const h = new SafetyStateChangeHook({
      event: "safety_state_change",
      workcell_id: "wc-1",
      current_state: "estop",
      timestamp: "2026-05-28T00:00:02Z",
      reason: "operator e-stop",
    });
    expect(h.current_state).toBe("estop");
    expect(h.workcell_id).toBe("wc-1");
  });

  it("LabwareMovementHook parses a move", () => {
    const h = new LabwareMovementHook({
      event: "labware_movement",
      labware_id: "plate-1",
      from_location: "deck.A1",
      to_location: "thermocycler.slot1",
      timestamp: "2026-05-28T00:00:03Z",
    });
    expect(h.labware_id).toBe("plate-1");
    expect(h.to_location).toBe("thermocycler.slot1");
  });

  it("NewPlanHook parses a plan emission", () => {
    const h = new NewPlanHook({
      event: "new_plan",
      workflow_id: "wf-1",
      plan_id: "plan-99",
      timestamp: "2026-05-28T00:00:04Z",
      plan_summary: { steps: 12 },
    });
    expect(h.plan_id).toBe("plan-99");
    expect(h.plan_summary?.steps).toBe(12);
  });

  it("rejects an invalid payload via zod", () => {
    expect(
      () =>
        new RunStateChangeHook({
          event: "run_state_change",
          workflow_id: "wf-1",
          // missing run_id + current_state
          timestamp: "2026-05-28T00:00:00Z",
        }),
    ).toThrow();
  });
});

describe("parseHook dispatcher", () => {
  it("dispatches to RunStateChangeHook", () => {
    const h = parseHook("run_state_change", {
      event: "run_state_change",
      workflow_id: "wf-1",
      run_id: "run-1",
      current_state: "queued",
      timestamp: "2026-05-28T00:00:00Z",
    });
    expect(h).toBeInstanceOf(RunStateChangeHook);
  });

  it("dispatches to LabwareMovementHook", () => {
    const h = parseHook("labware_movement", {
      event: "labware_movement",
      labware_id: "plate-1",
      to_location: "deck.B2",
      timestamp: "2026-05-28T00:00:00Z",
    });
    expect(h).toBeInstanceOf(LabwareMovementHook);
  });

  it("throws on unknown event type", () => {
    expect(() => parseHook("not_a_real_event", {})).toThrow(
      /Unknown LINQ hook event type/,
    );
  });
});
