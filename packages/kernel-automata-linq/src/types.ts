/**
 * Automata LINQ type mirror.
 *
 * Source of truth is the LINQ docs at https://docs.automata.tech/. The
 * authoritative resource model (Workcell → Instrument → Workflow → Task →
 * Labware) is taken from the docs landing page; field names below match
 * the documented concepts but specific shape is a best-guess against
 * SaaS-CRUD conventions until a sandbox account confirms them.
 *
 * EVERY FIELD MARKED `[unconfirmed]` IS A PLACEHOLDER. Fill these in once
 * an Automata API key is in hand and the live response shapes can be read.
 */

import { z } from "zod";

/** A workcell — the physical lab setup (LINQ Bench + instruments). */
export const LinqWorkcellSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** [unconfirmed] Bench configuration descriptor. */
  bench_config: z.record(z.unknown()).optional(),
  /** [unconfirmed] List of instrument IDs bound to this workcell. */
  instrument_ids: z.array(z.string()).default([]),
});

/** An instrument — physical device that performs tasks. */
export const LinqInstrumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Driver/instrument-class identifier (e.g. "tecan-spark", "thermo-multidrop"). */
  driver: z.string(),
  /** [unconfirmed] Healthcheck status. */
  status: z.enum(["online", "offline", "error", "maintenance"]).optional(),
});

/** A LINQ workflow — sequence of tasks. */
export const LinqWorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** Workcell this workflow is authored against. */
  workcell_id: z.string(),
  /** Ordered task list. */
  tasks: z.array(z.lazy(() => LinqTaskSchema)),
  /** [unconfirmed] Versioning. */
  version: z.string().optional(),
});

/** A task — unit of work within a workflow. */
export const LinqTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Instrument this task targets. */
  instrument_id: z.string(),
  /** Driver action name. */
  action: z.string(),
  /** Action arguments. Shape is driver-specific. */
  args: z.record(z.unknown()).optional(),
  /** Labware references (source/target). */
  labware: z
    .object({
      source: z.string().optional(),
      target: z.string().optional(),
    })
    .optional(),
});

/** Labware — physical container (plate, tube, tip box). */
export const LinqLabwareSchema = z.object({
  id: z.string(),
  type: z.string(),
  /** Position within the workcell. */
  position: z.string().optional(),
});

/** A workflow run instance. */
export const LinqRunSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "paused",
  ]),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  current_task_id: z.string().optional(),
});

export type LinqWorkcell = z.infer<typeof LinqWorkcellSchema>;
export type LinqInstrument = z.infer<typeof LinqInstrumentSchema>;
export type LinqWorkflow = z.infer<typeof LinqWorkflowSchema>;
export type LinqTask = z.infer<typeof LinqTaskSchema>;
export type LinqLabware = z.infer<typeof LinqLabwareSchema>;
export type LinqRun = z.infer<typeof LinqRunSchema>;
