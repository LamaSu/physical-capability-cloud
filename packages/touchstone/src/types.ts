/**
 * Core type definitions for the touchstone statistical enforcement module.
 *
 * Touchstones are known-answer tasks injected into a real work stream at a
 * configurable rate.  Because the executor cannot distinguish a touchstone
 * from genuine work, it must execute every task honestly — otherwise a
 * touchstone failure will slash its reputation.
 */

// ---------------------------------------------------------------------------
// Verification methods
// ---------------------------------------------------------------------------

/**
 * How a touchstone result is verified against the known answer.
 *
 * - `exact_match`        — SHA-256 hash comparison or deep structural equality.
 * - `schema_validation`  — output must conform to a Zod / JSON Schema.
 * - `hash_comparison`    — content-addressed comparison (CID / SHA-256).
 * - `differential`       — delta between expected and actual within tolerance.
 */
export type VerificationMethod =
  | "exact_match"
  | "schema_validation"
  | "hash_comparison"
  | "differential";

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** A single step the executor must perform to complete the touchstone. */
export interface WorkflowStep {
  stepId: string;
  description: string;
  /** Opaque input payload for this step. */
  input: Record<string, unknown>;
}

/** A known-answer task that can be injected into a work stream. */
export interface TouchstoneTask {
  taskId: string;
  /** The workflow steps the executor must follow. */
  workflowSteps: WorkflowStep[];
  /** The ground-truth output (used by verifiers). */
  expectedOutput: unknown;
  /** How the result will be verified. */
  verificationMethod: VerificationMethod;
  /** Human-readable scope label (e.g. "accounting", "procurement"). */
  scope: string;
  /** Arbitrary metadata (vertical-specific context). */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** The outcome of verifying an executor's response to a touchstone task. */
export interface TouchstoneResult {
  taskId: string;
  /** Whether the executor passed the touchstone. */
  passed: boolean;
  /**
   * Numeric score in [0, 1].
   * 1.0 = perfect match, 0.0 = complete miss.
   */
  score: number;
  /** Human-readable explanation of the verification decision. */
  verificationDetails: string;
  /** Wall-clock time spent on verification (ms). */
  executionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** A collection of touchstone tasks for a specific vertical / task type. */
export interface TouchstoneLibrary {
  id: string;
  name: string;
  /** Broad category key for routing (e.g. "accounting", "procurement"). */
  taskType: string;
  /** The tasks in this library. */
  tasks: TouchstoneTask[];
  /** Human-readable description of the library. */
  description: string;
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

/** Configuration for how touchstones are sampled into the work stream. */
export interface TouchstoneSampler {
  /** Probability that any given task is replaced by a touchstone (0-1). */
  rate: number;
  /** Sampling strategy. */
  strategy: "bernoulli" | "deterministic";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Top-level configuration for the touchstone module. */
export interface TouchstoneConfig {
  /**
   * Fraction of tasks replaced by touchstones (0-1).
   * Default: 0.15 (15%).
   */
  injectionRate: number;
  /**
   * Multiplier applied to the base penalty on touchstone failure.
   * A value of 10 means a failed touchstone costs 10x the base reputation
   * feedback value.  Default: 10.
   */
  failurePenaltyMultiplier: number;
  /** How results are verified. */
  verificationMethod: VerificationMethod;
}
