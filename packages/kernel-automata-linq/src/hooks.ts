/**
 * LINQ webhook payload classes.
 *
 * Per the LINQ docs, webhooks are attached per-Workflow via 5 typed Hook
 * classes (`RunStateChangeHook`, `TaskStateChangeHook`,
 * `SafetyStateChangeHook`, `LabwareMovementHook`, `NewPlanHook`). Each
 * delivers a JSON body to the registered URL with a hook-specific shape.
 *
 * The exact field names below match the documented concepts but
 * specific JSON keys are unverified against a real webhook delivery
 * (sandbox-gated). zod schemas are intentionally loose-tail (passthrough)
 * so unknown fields don't reject. Tighten once Automata confirms shapes.
 */

import { z } from "zod";

// ── State enums (best-guess, passthrough loose) ─────────────────────

const RunStateSchema = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "error",
]);
const TaskStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);
const SafetyStateSchema = z.enum(["nominal", "warning", "estop", "fault"]);

// ── Hook payload schemas ────────────────────────────────────────────

export const RunStateChangeHookSchema = z
  .object({
    event: z.literal("run_state_change"),
    workflow_id: z.string(),
    run_id: z.string(),
    previous_state: RunStateSchema.optional(),
    current_state: RunStateSchema,
    timestamp: z.string(),
    reason: z.string().optional(),
  })
  .passthrough();

export const TaskStateChangeHookSchema = z
  .object({
    event: z.literal("task_state_change"),
    workflow_id: z.string(),
    run_id: z.string(),
    task_id: z.string(),
    previous_state: TaskStateSchema.optional(),
    current_state: TaskStateSchema,
    timestamp: z.string(),
    instrument_id: z.string().optional(),
  })
  .passthrough();

export const SafetyStateChangeHookSchema = z
  .object({
    event: z.literal("safety_state_change"),
    workcell_id: z.string(),
    run_id: z.string().optional(),
    previous_state: SafetyStateSchema.optional(),
    current_state: SafetyStateSchema,
    timestamp: z.string(),
    instrument_id: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const LabwareMovementHookSchema = z
  .object({
    event: z.literal("labware_movement"),
    workflow_id: z.string().optional(),
    run_id: z.string().optional(),
    labware_id: z.string(),
    from_location: z.string().optional(),
    to_location: z.string(),
    timestamp: z.string(),
    moved_by_instrument_id: z.string().optional(),
  })
  .passthrough();

export const NewPlanHookSchema = z
  .object({
    event: z.literal("new_plan"),
    workflow_id: z.string(),
    plan_id: z.string(),
    timestamp: z.string(),
    plan_summary: z.record(z.unknown()).optional(),
  })
  .passthrough();

// ── Hook payload classes ────────────────────────────────────────────

/** Fired when a run transitions between lifecycle states. */
export class RunStateChangeHook {
  static readonly event = "run_state_change" as const;
  static readonly schema = RunStateChangeHookSchema;

  readonly event = RunStateChangeHook.event;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly previous_state?: z.infer<typeof RunStateSchema>;
  readonly current_state: z.infer<typeof RunStateSchema>;
  readonly timestamp: string;
  readonly reason?: string;
  readonly raw: Record<string, unknown>;

  constructor(payload: unknown) {
    const parsed = RunStateChangeHookSchema.parse(payload);
    this.workflow_id = parsed.workflow_id;
    this.run_id = parsed.run_id;
    this.previous_state = parsed.previous_state;
    this.current_state = parsed.current_state;
    this.timestamp = parsed.timestamp;
    this.reason = parsed.reason;
    this.raw = parsed as Record<string, unknown>;
  }
}

/** Fired when an individual task in a run changes state. */
export class TaskStateChangeHook {
  static readonly event = "task_state_change" as const;
  static readonly schema = TaskStateChangeHookSchema;

  readonly event = TaskStateChangeHook.event;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly previous_state?: z.infer<typeof TaskStateSchema>;
  readonly current_state: z.infer<typeof TaskStateSchema>;
  readonly timestamp: string;
  readonly instrument_id?: string;
  readonly raw: Record<string, unknown>;

  constructor(payload: unknown) {
    const parsed = TaskStateChangeHookSchema.parse(payload);
    this.workflow_id = parsed.workflow_id;
    this.run_id = parsed.run_id;
    this.task_id = parsed.task_id;
    this.previous_state = parsed.previous_state;
    this.current_state = parsed.current_state;
    this.timestamp = parsed.timestamp;
    this.instrument_id = parsed.instrument_id;
    this.raw = parsed as Record<string, unknown>;
  }
}

/** Fired on safety-state transitions (e-stop, fault, recovery). */
export class SafetyStateChangeHook {
  static readonly event = "safety_state_change" as const;
  static readonly schema = SafetyStateChangeHookSchema;

  readonly event = SafetyStateChangeHook.event;
  readonly workcell_id: string;
  readonly run_id?: string;
  readonly previous_state?: z.infer<typeof SafetyStateSchema>;
  readonly current_state: z.infer<typeof SafetyStateSchema>;
  readonly timestamp: string;
  readonly instrument_id?: string;
  readonly reason?: string;
  readonly raw: Record<string, unknown>;

  constructor(payload: unknown) {
    const parsed = SafetyStateChangeHookSchema.parse(payload);
    this.workcell_id = parsed.workcell_id;
    this.run_id = parsed.run_id;
    this.previous_state = parsed.previous_state;
    this.current_state = parsed.current_state;
    this.timestamp = parsed.timestamp;
    this.instrument_id = parsed.instrument_id;
    this.reason = parsed.reason;
    this.raw = parsed as Record<string, unknown>;
  }
}

/** Fired each time labware is physically moved between locations. */
export class LabwareMovementHook {
  static readonly event = "labware_movement" as const;
  static readonly schema = LabwareMovementHookSchema;

  readonly event = LabwareMovementHook.event;
  readonly workflow_id?: string;
  readonly run_id?: string;
  readonly labware_id: string;
  readonly from_location?: string;
  readonly to_location: string;
  readonly timestamp: string;
  readonly moved_by_instrument_id?: string;
  readonly raw: Record<string, unknown>;

  constructor(payload: unknown) {
    const parsed = LabwareMovementHookSchema.parse(payload);
    this.workflow_id = parsed.workflow_id;
    this.run_id = parsed.run_id;
    this.labware_id = parsed.labware_id;
    this.from_location = parsed.from_location;
    this.to_location = parsed.to_location;
    this.timestamp = parsed.timestamp;
    this.moved_by_instrument_id = parsed.moved_by_instrument_id;
    this.raw = parsed as Record<string, unknown>;
  }
}

/** Fired when the LINQ scheduler emits a new execution plan. */
export class NewPlanHook {
  static readonly event = "new_plan" as const;
  static readonly schema = NewPlanHookSchema;

  readonly event = NewPlanHook.event;
  readonly workflow_id: string;
  readonly plan_id: string;
  readonly timestamp: string;
  readonly plan_summary?: Record<string, unknown>;
  readonly raw: Record<string, unknown>;

  constructor(payload: unknown) {
    const parsed = NewPlanHookSchema.parse(payload);
    this.workflow_id = parsed.workflow_id;
    this.plan_id = parsed.plan_id;
    this.timestamp = parsed.timestamp;
    this.plan_summary = parsed.plan_summary;
    this.raw = parsed as Record<string, unknown>;
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────

export type LinqHook =
  | RunStateChangeHook
  | TaskStateChangeHook
  | SafetyStateChangeHook
  | LabwareMovementHook
  | NewPlanHook;

export type LinqHookEventType =
  | "run_state_change"
  | "task_state_change"
  | "safety_state_change"
  | "labware_movement"
  | "new_plan";

/**
 * Dispatch an incoming webhook to the matching Hook class.
 *
 * `eventType` is typically read from a header (e.g. `X-Linq-Event`) or
 * from the payload's `event` field. Throws if eventType is unknown or
 * the payload fails schema validation.
 */
export function parseHook(eventType: string, payload: unknown): LinqHook {
  switch (eventType) {
    case RunStateChangeHook.event:
      return new RunStateChangeHook(payload);
    case TaskStateChangeHook.event:
      return new TaskStateChangeHook(payload);
    case SafetyStateChangeHook.event:
      return new SafetyStateChangeHook(payload);
    case LabwareMovementHook.event:
      return new LabwareMovementHook(payload);
    case NewPlanHook.event:
      return new NewPlanHook(payload);
    default:
      throw new Error(`Unknown LINQ hook event type: ${eventType}`);
  }
}
