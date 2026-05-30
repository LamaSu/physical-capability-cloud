/**
 * CWL v1.2 AST subset — just the shapes we emit from cwlExport().
 *
 * See design §9. We only serialize — import (CWL YAML → WorkflowDef) is
 * intentionally out of scope for v0.1.
 */

import type { CanonicalInput } from '../shared/types.js';

/** Primitive CWL types we map to. */
export type CwlPrimitiveType =
  | 'string'
  | 'int'
  | 'long'
  | 'float'
  | 'double'
  | 'boolean'
  | 'File'
  | 'Directory';

/** PCC-native type tag — mirrors WorkflowDef's `type` field union. */
export type PccType = CwlPrimitiveType | 'array';

/** Individual input on the synthesized workflow. */
export interface WorkflowDefInput {
  readonly name: string;
  readonly type: PccType;
  readonly items?: PccType;
  readonly optional?: boolean;
  readonly format?: string;
  readonly defaultValue?: CanonicalInput;
  readonly doc?: string;
}

/** Individual output on the synthesized workflow. */
export interface WorkflowDefOutput {
  readonly name: string;
  readonly type: PccType;
  readonly items?: PccType;
  readonly source: string;              // "stepId/outputName"
  readonly format?: string;
  readonly doc?: string;
}

/** PCC kernel hint — emitted under `hints: pcc:KernelRequirement`. */
export interface KernelHint {
  readonly kernel: string;
  readonly service?: string;
  readonly capability: string;
}

/** Compensation hint — capability to call on step failure. */
export interface CompensationHint {
  readonly onError: string;
}

/** Resource requirement (standard CWL). */
export interface ResourceRequirement {
  readonly coresMin?: number;
  readonly ramMin?: number;
  readonly gpusMin?: number;
}

/** Quorum — minimum number of verifier signers. */
export interface QuorumRequirement {
  readonly minSigners: number;
}

/** Retry policy hint mirroring our RetryPolicy shape. */
export interface RetryPolicyHint {
  readonly initialIntervalMs?: number;
  readonly backoffCoefficient?: number;
  readonly maxIntervalMs?: number;
  readonly maximumAttempts?: number;
  readonly nonRetryableErrorPatterns?: readonly string[];
}

/** Signal requirement hint for `ctx.signal()` steps. */
export interface SignalRequirement {
  readonly signalName: string;
  readonly timeoutMs?: number;
}

/** A single step in the synthesized workflow DAG. */
export interface WorkflowDefStep {
  readonly id: string;
  readonly runRef: string;              // "pcc://activity/<name>" etc.
  readonly in: Record<string, string | CanonicalInput>;
  readonly out: readonly string[];
  readonly scatter?: string;
  readonly scatterMethod?: 'dotproduct' | 'nested_crossproduct' | 'flat_crossproduct';
  readonly when?: string;
  readonly kernelHint?: KernelHint;
  readonly compensation?: CompensationHint;
  readonly resources?: ResourceRequirement;
  readonly quorum?: QuorumRequirement;
  readonly retryPolicy?: RetryPolicyHint;
  readonly signal?: SignalRequirement;
  readonly doc?: string;
}

/** The complete workflow document the exporter consumes. */
export interface WorkflowDef {
  readonly name: string;
  readonly version: string;
  readonly label?: string;
  readonly doc?: string;
  readonly inputs: readonly WorkflowDefInput[];
  readonly outputs: readonly WorkflowDefOutput[];
  readonly steps: readonly WorkflowDefStep[];
  readonly pccMetadata?: Record<string, CanonicalInput>;
}
