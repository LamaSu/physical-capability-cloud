/**
 * Genesis-sim rollout trace types (server- + client-safe).
 *
 * Parallel evidence channel to `PointMap3DTrace`. Where `PointMap3DTrace`
 * carries per-frame point maps + camera poses derived from a real phone-video
 * recording, `SimulationTrace` carries per-tick observation/action/reward
 * series from a Genesis-sim (or any equivalent simulator) rollout. Both ride
 * inside `CaptureManifest` as optional, soft-fail, tier-orthogonal channels —
 * a capability that produces SimulationTraces stays CC0..CC5 by signature
 * evidence, not by simulation evidence.
 *
 * Design rules (mirror the LingBot adapter wiring):
 *   1. Trace lives inside the canonical `CaptureManifest` hash. Any tampering
 *      downstream invalidates the on-chain `manifestHash` anchor — no schema
 *      change at the Solidity boundary.
 *   2. Manifest carries an ARRAY (`simulations?: SimulationTrace[]`) because
 *      sim rollouts ship in batches (e.g. 10 evaluation rollouts per policy
 *      checkpoint). The single-trace LingBot case uses `pointMaps3D?: Trace`.
 *   3. The rollout artefact (full per-tick state, images, depth) stays
 *      off-chain via `cid` references; the manifest carries a downsampled
 *      sparse view bounded by `frames.length`.
 *   4. `rolloutHash` is the sha256 of the canonical rollout artefact bytes —
 *      jsonl/npz/h5 produced by the runner — and is hash-echoed at the
 *      gateway in `POST /api/capture/sim` just like `videoHash` for video.
 *
 * See: ai/research/pcc-simulation-trace.md
 *
 * No runtime crypto here — safe to import from browser code.
 *
 * Author: pcc-genesis adapter
 * License: Apache-2.0 (matches Genesis upstream)
 */

import { z } from "zod";
import type { SHA256, Timestamp } from "./common.js";

// ---------------------------------------------------------------------------
// Scene context — what was simulated
// ---------------------------------------------------------------------------

/**
 * Physics-engine parameters that fully determine simulator dynamics.
 *
 * Captured so that a rollout is reproducible up to floating-point determinism
 * boundaries. Optional because some simulators don't expose all knobs (e.g.
 * a purely positional environment may have no `solver`).
 */
export interface SimulationPhysicsParams {
  /** Gravity vector in m/s^2, world-frame */
  gravity?: [number, number, number];
  /** Integration timestep in seconds */
  timestepSec?: number;
  /** Physics solver identifier (e.g. "pgs", "newton", "tgs") */
  solver?: string;
  /** Substeps per outer step */
  substeps?: number;
}

/**
 * The scene the rollout was conducted in.
 *
 * Spans every dimension that determines what was simulated: which simulator
 * (Genesis / Isaac Gym / Mujoco / Brax / ...), which embodiment, which task,
 * scene assets, physics, and randomization seeds. The combination is hashed
 * into `sceneHash` so two rollouts can be compared for cross-seed identity.
 */
export interface SceneContext {
  /** Simulator identifier (e.g. "genesis", "isaac-gym", "mujoco", "brax") */
  simulator: string;
  /** Simulator version string (semver or git sha) */
  simulatorVersion: string;
  /** Embodiment identifier (e.g. "franka-panda", "ur5", "anymal-c") */
  embodiment: string;
  /** Logical task id (e.g. "pick-and-place", "cube-stack", "rough-terrain") */
  taskId: string;
  /**
   * sha256 of the canonical scene config (URDF/USD/MJCF + initial state).
   * Cross-seed comparisons hold this fixed and vary `randomSeed`.
   */
  sceneHash: SHA256;
  /** Optional list of asset names referenced by the scene */
  assets?: string[];
  /** Optional lighting setup identifier */
  lighting?: string;
  /** Optional physics parameters */
  physicsParams?: SimulationPhysicsParams;
  /** Optional RNG seed used by the simulator */
  randomSeed?: number;
  /** Optional names of observation channels (e.g. ["qpos", "qvel", "rgb"]) */
  observationKeys?: string[];
  /** Optional action-space dimensionality */
  actionDim?: number;
  /** Optional observation-space dimensionality (flat vector) */
  observationDim?: number;
}

// ---------------------------------------------------------------------------
// Per-tick simulation frame
// ---------------------------------------------------------------------------

/**
 * Per-step info dict — common RL-environment booleans.
 *
 * Kept loose because different tasks instrument different end conditions.
 * The verifier only cross-checks `success` against `RolloutSummary.success`
 * on the final frame.
 */
export interface SimulationFrameInfo {
  /** Goal achieved at this step */
  success?: boolean;
  /** Robot in collision at this step */
  collision?: boolean;
  /** Episode hit max-steps */
  timeout?: boolean;
}

/**
 * A single simulation tick (one environment step).
 *
 * `action`, `observation`, and `reward` are sparse: the manifest carries a
 * downsampled view (default ~256 frames). The full rollout sits behind `cid`
 * if the operator chose to persist it (npz/jsonl on IPFS / Storacha).
 *
 * `observation` is flattened to keep the manifest type-stable; the runner is
 * responsible for choosing a consistent flattening (e.g. concatenate qpos +
 * qvel + flatten(rgb_thumbnail)).
 */
export interface SimulationFrame {
  /** Zero-based step index */
  frameIndex: number;
  /** Seconds since rollout start */
  timestampSec: number;
  /** Action vector at this tick (flat) */
  action?: number[];
  /** Observation vector at this tick (flat, possibly downsampled) */
  observation?: number[];
  /** Scalar reward */
  reward?: number;
  /** Episode-done flag (`terminated || truncated` in RL parlance) */
  done?: boolean;
  /** Loose info dict for instrumentation */
  info?: SimulationFrameInfo;
  /** Optional CID of the dense per-tick state (npz blob in durable storage) */
  cid?: string;
}

// ---------------------------------------------------------------------------
// Rollout summary
// ---------------------------------------------------------------------------

/**
 * Reasons an episode terminated.
 *
 * `user_abort` covers the case where the runner was killed mid-rollout —
 * either by SIGTERM or by an explicit operator stop signal — distinct from
 * a true environmental `failure`.
 */
export type TerminatedReason =
  | "success"
  | "failure"
  | "timeout"
  | "collision"
  | "user_abort";

/**
 * Aggregate statistics over a single rollout episode.
 *
 * `totalReturn` is the sum of rewards over the episode. `success` is the
 * authoritative goal-achieved flag — the verifier MUST treat
 * `frames[last].info.success` as advisory (it might be undefined for
 * sparse-reward tasks) and `summary.success` as the source of truth.
 *
 * `domainRandomizationHash` is the sha256 of the canonical domain-randomization
 * configuration (mass ranges, friction ranges, sensor noise scales, etc.) and
 * stays fixed across same-config seeds — the verifier uses it to gate
 * out-of-distribution claims.
 */
export interface RolloutSummary {
  /** Sum of per-step rewards over the episode */
  totalReturn: number;
  /** Number of steps in this episode */
  episodeLength: number;
  /** Goal achieved at episode end */
  success: boolean;
  /** Why the episode ended */
  terminatedReason?: TerminatedReason;
  /** Mean per-step reward */
  meanReward?: number;
  /** sha256 of the canonical domain-randomization config (if used) */
  domainRandomizationHash?: SHA256;
}

// ---------------------------------------------------------------------------
// Top-level trace
// ---------------------------------------------------------------------------

/**
 * Genesis-sim rollout evidence trace.
 *
 * Augments — does NOT replace — the existing capture media. The trace covers
 * one rollout episode (or a short batch the operator concatenated into a
 * single artefact). The verifier hashes the manifest including this trace,
 * so any rollout-data tampering downstream invalidates the on-chain
 * `manifestHash` anchor.
 *
 * Adapter-imposed bounds (`scripts/pcc_genesis_runner.py`):
 *   - fps ∈ [1, 240]   (default 30)
 *   - maxFrames ∈ [1, 4096]   (default 256 — keeps manifest under ~1 MB)
 *   - downsamplePoints ∈ [16, 16384]   (default 256 — flat obs/action width)
 *
 * Gateway-imposed bounds (`packages/gateway/src/routes/capture-sim.ts`):
 *   - Inbound rollout artefact ≤ 32 MB
 *   - Server-side hash echo on `expectedRolloutHash` if supplied
 *   - Adapter's `trace.rolloutHash` MUST match request bytes → 500 otherwise
 */
export interface SimulationTrace {
  /** Identifier for the device that ran the rollout (kernel/runner id) */
  deviceId: string;
  /** ISO 8601 timestamp when the rollout started */
  startedAt: Timestamp;
  /** ISO 8601 timestamp when the rollout ended */
  endedAt: Timestamp;
  /** sha256 of the canonical rollout artefact bytes (jsonl/npz/h5) */
  rolloutHash: SHA256;
  /** Scene the rollout was conducted in */
  scene: SceneContext;
  /** Steps-per-second the simulator was driven at */
  fps: number;
  /** Total frames recorded in this trace */
  frameCount: number;
  /** Per-step downsampled frame view (full rollout may be off-chain) */
  frames: SimulationFrame[];
  /** Aggregate stats for this rollout */
  summary: RolloutSummary;
  /** Policy / checkpoint identifier that generated the rollout */
  model: string;
  /** Adapter version that produced this trace (semver of PCC Genesis adapter) */
  adapterVersion: string;
  /** True iff inference ran in stub mode (deterministic synthetic rollout) */
  stubbed?: boolean;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SHA256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Must be sha256:<64 hex chars>");

const SimulationPhysicsParamsSchema = z.object({
  gravity: z.tuple([z.number(), z.number(), z.number()]).optional(),
  timestepSec: z.number().positive().optional(),
  solver: z.string().min(1).optional(),
  substeps: z.number().int().positive().optional(),
});

const SceneContextSchema = z.object({
  simulator: z.string().min(1),
  simulatorVersion: z.string().min(1),
  embodiment: z.string().min(1),
  taskId: z.string().min(1),
  sceneHash: SHA256Schema,
  assets: z.array(z.string().min(1)).optional(),
  lighting: z.string().min(1).optional(),
  physicsParams: SimulationPhysicsParamsSchema.optional(),
  randomSeed: z.number().int().optional(),
  observationKeys: z.array(z.string().min(1)).optional(),
  actionDim: z.number().int().nonnegative().optional(),
  observationDim: z.number().int().nonnegative().optional(),
});

const SimulationFrameInfoSchema = z.object({
  success: z.boolean().optional(),
  collision: z.boolean().optional(),
  timeout: z.boolean().optional(),
});

const SimulationFrameSchema = z.object({
  frameIndex: z.number().int().nonnegative(),
  timestampSec: z.number().nonnegative(),
  action: z.array(z.number()).optional(),
  observation: z.array(z.number()).optional(),
  reward: z.number().optional(),
  done: z.boolean().optional(),
  info: SimulationFrameInfoSchema.optional(),
  cid: z.string().min(1).optional(),
});

const TerminatedReasonSchema = z.enum([
  "success",
  "failure",
  "timeout",
  "collision",
  "user_abort",
]);

const RolloutSummarySchema = z.object({
  totalReturn: z.number(),
  episodeLength: z.number().int().nonnegative(),
  success: z.boolean(),
  terminatedReason: TerminatedReasonSchema.optional(),
  meanReward: z.number().optional(),
  domainRandomizationHash: SHA256Schema.optional(),
});

const SimulationTraceSchema = z.object({
  deviceId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  rolloutHash: SHA256Schema,
  scene: SceneContextSchema,
  fps: z.number().positive(),
  frameCount: z.number().int().nonnegative(),
  frames: z.array(SimulationFrameSchema),
  summary: RolloutSummarySchema,
  model: z.string().min(1),
  adapterVersion: z.string().min(1),
  stubbed: z.boolean().optional(),
});

/**
 * Standalone Zod schema for {@link SimulationTrace}.
 *
 * Exported so the gateway's `/api/capture/sim` route (and any client wiring)
 * can validate the runner's response before merging it into the parent
 * `CaptureManifest.simulations` array. The schema is cast to
 * `z.ZodType<SimulationTrace>` because Zod's inferred `string` for the
 * SHA-256 / Timestamp aliases is not literally assignable to the branded
 * template-literal types — the regex guarantees runtime safety.
 */
export const SimulationTraceSchemaExport: z.ZodType<SimulationTrace> =
  SimulationTraceSchema as unknown as z.ZodType<SimulationTrace>;

/**
 * Standalone Zod schema for an array of {@link SimulationTrace}s as carried
 * by `CaptureManifest.simulations`. Convenience handle so callers don't have
 * to `z.array(...)` at every boundary.
 */
export const SimulationTraceArraySchemaExport: z.ZodType<SimulationTrace[]> =
  z.array(SimulationTraceSchema) as unknown as z.ZodType<SimulationTrace[]>;

/**
 * Standalone Zod schema for {@link SceneContext}. Useful for validating
 * scene descriptions ahead of running a rollout.
 */
export const SceneContextSchemaExport: z.ZodType<SceneContext> =
  SceneContextSchema as unknown as z.ZodType<SceneContext>;

/**
 * Standalone Zod schema for {@link SimulationFrame}. Useful for streaming
 * validators that want to validate frames one at a time.
 */
export const SimulationFrameSchemaExport: z.ZodType<SimulationFrame> =
  SimulationFrameSchema as unknown as z.ZodType<SimulationFrame>;

/**
 * Standalone Zod schema for {@link RolloutSummary}.
 */
export const RolloutSummarySchemaExport: z.ZodType<RolloutSummary> =
  RolloutSummarySchema as unknown as z.ZodType<RolloutSummary>;
