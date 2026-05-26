/**
 * cwlExport(def) — emit a CWL v1.2 YAML document.
 *
 * See design §9.1 for the target serialization.
 *
 * Deterministic output: the same WorkflowDef input produces byte-identical
 * YAML. We construct a plain-object AST matching the CWL layout, then let
 * `yaml.stringify` produce the bytes. Map ordering is preserved by using
 * explicit field ordering in object literals.
 */

import { stringify } from 'yaml';
import { z } from 'zod';

import { CwlExportError, type CanonicalInput } from '../shared/types.js';
import {
  PCC_COMPENSATION_REQUIREMENT,
  PCC_KERNEL_REQUIREMENT,
  PCC_NAMESPACE_IRI,
  PCC_QUORUM_REQUIREMENT,
  PCC_RETRY_POLICY,
  PCC_SIGNAL_REQUIREMENT,
} from './namespace.js';
import type { PccType, WorkflowDef, WorkflowDefInput, WorkflowDefOutput, WorkflowDefStep } from './types.js';

// ── Validation schema ──────────────────────────────────────────────────────

const PCC_TYPES = [
  'string',
  'int',
  'long',
  'float',
  'double',
  'boolean',
  'File',
  'Directory',
  'array',
] as const;

const InputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(PCC_TYPES),
  items: z.enum(PCC_TYPES).optional(),
  optional: z.boolean().optional(),
  format: z.string().optional(),
  defaultValue: z.unknown().optional(),
  doc: z.string().optional(),
});

const OutputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(PCC_TYPES),
  items: z.enum(PCC_TYPES).optional(),
  source: z.string().min(1),
  format: z.string().optional(),
  doc: z.string().optional(),
});

const StepSchema = z.object({
  id: z.string().min(1),
  runRef: z.string().min(1),
  in: z.record(z.string(), z.any()),
  out: z.array(z.string()).min(1),
  scatter: z.string().optional(),
  scatterMethod: z.enum(['dotproduct', 'nested_crossproduct', 'flat_crossproduct']).optional(),
  when: z.string().optional(),
  kernelHint: z
    .object({
      kernel: z.string().min(1),
      service: z.string().optional(),
      capability: z.string().min(1),
    })
    .optional(),
  compensation: z.object({ onError: z.string() }).optional(),
  resources: z
    .object({
      coresMin: z.number().optional(),
      ramMin: z.number().optional(),
      gpusMin: z.number().optional(),
    })
    .optional(),
  quorum: z.object({ minSigners: z.number() }).optional(),
  retryPolicy: z
    .object({
      initialIntervalMs: z.number().optional(),
      backoffCoefficient: z.number().optional(),
      maxIntervalMs: z.number().optional(),
      maximumAttempts: z.number().optional(),
      nonRetryableErrorPatterns: z.array(z.string()).optional(),
    })
    .optional(),
  signal: z
    .object({ signalName: z.string().min(1), timeoutMs: z.number().optional() })
    .optional(),
  doc: z.string().optional(),
});

const WorkflowDefSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  label: z.string().optional(),
  doc: z.string().optional(),
  inputs: z.array(InputSchema),
  outputs: z.array(OutputSchema),
  steps: z.array(StepSchema).min(1),
  pccMetadata: z.record(z.string(), z.any()).optional(),
});

// ── Exporter ───────────────────────────────────────────────────────────────

export interface CwlExportOptions {
  /** Emit `#!/usr/bin/env cwl-runner` shebang as first line. Default true. */
  shebang?: boolean;
  /** Include `$namespaces.pcc` block. Default true. */
  includePccNamespace?: boolean;
}

export function cwlExport(def: WorkflowDef, opts: CwlExportOptions = {}): string {
  const parsed = WorkflowDefSchema.safeParse(def);
  if (!parsed.success) {
    throw new CwlExportError(
      `Invalid WorkflowDef: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  const shebang = opts.shebang ?? true;
  const includePcc = opts.includePccNamespace ?? true;

  const doc: Record<string, unknown> = {
    cwlVersion: 'v1.2',
    class: 'Workflow',
    id: def.name,
  };
  if (def.label) doc['label'] = def.label;
  if (def.doc) doc['doc'] = def.doc;

  if (includePcc) {
    doc['$namespaces'] = { pcc: PCC_NAMESPACE_IRI };
  }

  doc['requirements'] = [
    { class: 'ScatterFeatureRequirement' },
    { class: 'StepInputExpressionRequirement' },
    { class: 'InlineJavascriptRequirement' },
  ];

  doc['inputs'] = toInputsMap(def.inputs);
  doc['outputs'] = toOutputsMap(def.outputs);
  doc['steps'] = toStepsMap(def.steps);

  if (def.pccMetadata) {
    doc['pcc:metadata'] = def.pccMetadata as unknown as Record<string, unknown>;
  }

  const yamlBody = stringify(doc, {
    lineWidth: 120,
    aliasDuplicateObjects: false,
    blockQuote: 'literal',
    singleQuote: false,
  });

  return (shebang ? '#!/usr/bin/env cwl-runner\n' : '') + yamlBody;
}

/** Sugar wrapper matching the design's `cwlExportWithDefaults`. */
export function cwlExportWithDefaults(
  def: WorkflowDef,
  opts: CwlExportOptions = {},
): string {
  return cwlExport(def, { shebang: true, includePccNamespace: true, ...opts });
}

// ── Input/Output serialization ────────────────────────────────────────────

function toInputsMap(inputs: readonly WorkflowDefInput[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const i of inputs) {
    const entry: Record<string, unknown> = {
      type: serializeType(i.type, i.items, i.optional),
    };
    if (i.doc) entry['doc'] = i.doc;
    if (i.format) entry['format'] = i.format;
    if (i.defaultValue !== undefined) entry['default'] = i.defaultValue as CanonicalInput;
    out[i.name] = entry;
  }
  return out;
}

function toOutputsMap(outputs: readonly WorkflowDefOutput[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of outputs) {
    const entry: Record<string, unknown> = {
      type: serializeType(o.type, o.items, false),
      outputSource: o.source,
    };
    if (o.doc) entry['doc'] = o.doc;
    if (o.format) entry['format'] = o.format;
    out[o.name] = entry;
  }
  return out;
}

function toStepsMap(steps: readonly WorkflowDefStep[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of steps) {
    const entry: Record<string, unknown> = {
      run: s.runRef,
      in: { ...s.in } as Record<string, unknown>,
      out: [...s.out],
    };
    if (s.scatter) entry['scatter'] = s.scatter;
    if (s.scatterMethod) entry['scatterMethod'] = s.scatterMethod;
    if (s.when) entry['when'] = s.when;
    if (s.doc) entry['doc'] = s.doc;

    const requirements: Array<Record<string, unknown>> = [];
    if (s.resources) {
      const rr: Record<string, unknown> = { class: 'ResourceRequirement' };
      if (s.resources.coresMin !== undefined) rr['coresMin'] = s.resources.coresMin;
      if (s.resources.ramMin !== undefined) rr['ramMin'] = s.resources.ramMin;
      if (s.resources.gpusMin !== undefined) rr['gpusMin'] = s.resources.gpusMin;
      requirements.push(rr);
    }
    if (requirements.length > 0) entry['requirements'] = requirements;

    const hints: Record<string, unknown> = {};
    if (s.kernelHint) {
      const hint: Record<string, unknown> = {
        kernel: s.kernelHint.kernel,
        capability: s.kernelHint.capability,
      };
      if (s.kernelHint.service) hint['service'] = s.kernelHint.service;
      hints[PCC_KERNEL_REQUIREMENT] = hint;
    }
    if (s.compensation) {
      hints[PCC_COMPENSATION_REQUIREMENT] = { onError: s.compensation.onError };
    }
    if (s.quorum) {
      hints[PCC_QUORUM_REQUIREMENT] = { minSigners: s.quorum.minSigners };
    }
    if (s.retryPolicy) {
      const rp: Record<string, unknown> = {};
      if (s.retryPolicy.initialIntervalMs !== undefined)
        rp['initialIntervalMs'] = s.retryPolicy.initialIntervalMs;
      if (s.retryPolicy.backoffCoefficient !== undefined)
        rp['backoffCoefficient'] = s.retryPolicy.backoffCoefficient;
      if (s.retryPolicy.maxIntervalMs !== undefined)
        rp['maxIntervalMs'] = s.retryPolicy.maxIntervalMs;
      if (s.retryPolicy.maximumAttempts !== undefined)
        rp['maximumAttempts'] = s.retryPolicy.maximumAttempts;
      if (s.retryPolicy.nonRetryableErrorPatterns)
        rp['nonRetryableErrorPatterns'] = [...s.retryPolicy.nonRetryableErrorPatterns];
      hints[PCC_RETRY_POLICY] = rp;
    }
    if (s.signal) {
      const sig: Record<string, unknown> = { signalName: s.signal.signalName };
      if (s.signal.timeoutMs !== undefined) sig['timeoutMs'] = s.signal.timeoutMs;
      hints[PCC_SIGNAL_REQUIREMENT] = sig;
    }
    if (Object.keys(hints).length > 0) entry['hints'] = hints;

    out[s.id] = entry;
  }
  return out;
}

function serializeType(
  t: PccType,
  items: PccType | undefined,
  optional: boolean | undefined,
): unknown {
  let rendered: unknown;
  if (t === 'array') {
    rendered = { type: 'array', items: items ?? 'string' };
  } else {
    rendered = t;
  }
  if (optional) {
    return ['null', rendered];
  }
  return rendered;
}
