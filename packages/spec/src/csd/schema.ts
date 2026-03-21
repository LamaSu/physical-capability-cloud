/**
 * CSD (Capability StructureDefinition) Zod schema.
 *
 * A CSD is a JSON document that completely describes what a machine can do,
 * what parameters are configurable, what constraints apply, and how to price it.
 *
 * Think of it as FHIR StructureDefinition for physical capabilities.
 */

import { z } from "zod";

// ── Pricing Impact ─────────────────────────────────────────────────

export const CsdPricingImpactSchema = z.object({
  mode: z.enum(["flat", "percent", "per_unit", "multiplier"]),
  value: z.union([z.number(), z.string()]).optional(),
  label: z.string().optional(),
  /** Per-option pricing map, e.g. { "color": 2.0, "monochrome": 1.0 } */
  perOption: z.record(z.union([z.number(), z.string()])).optional(),
});

export type CsdPricingImpact = z.infer<typeof CsdPricingImpactSchema>;

// ── Enum Option ─────────────────────────────────────────────────────

export const CsdEnumOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  pricingImpact: CsdPricingImpactSchema.nullable().optional(),
});

export type CsdEnumOption = z.infer<typeof CsdEnumOptionSchema>;

// ── Parameter Schemas (discriminated union) ─────────────────────────

const CsdParamBaseSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean(),
  order: z.number().int().optional(),
  group: z.string().optional(),
  visibleWhen: z.object({
    param: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]),
  }).optional(),
});

export const CsdEnumParamSchema = CsdParamBaseSchema.extend({
  type: z.literal("enum"),
  options: z.array(CsdEnumOptionSchema).min(1),
  defaultValue: z.string().optional(),
  multi: z.boolean().optional(),
  pricingImpact: CsdPricingImpactSchema.nullable().optional(),
});

export const CsdNumberParamSchema = CsdParamBaseSchema.extend({
  type: z.literal("number"),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  unit: z.string().optional(),
  defaultValue: z.number().optional(),
  pricingImpact: CsdPricingImpactSchema.nullable().optional(),
});

export const CsdBooleanParamSchema = CsdParamBaseSchema.extend({
  type: z.literal("boolean"),
  defaultValue: z.boolean().optional(),
  pricingImpact: CsdPricingImpactSchema.nullable().optional(),
});

export const CsdStringParamSchema = CsdParamBaseSchema.extend({
  type: z.literal("string"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  pricingImpact: CsdPricingImpactSchema.nullable().optional(),
});

export const CsdParameterSchema = z.discriminatedUnion("type", [
  CsdEnumParamSchema,
  CsdNumberParamSchema,
  CsdBooleanParamSchema,
  CsdStringParamSchema,
]);

export type CsdParameter = z.infer<typeof CsdParameterSchema>;

// ── Constraint Schema ───────────────────────────────────────────────

export const CsdConstraintConditionSchema = z.object({
  param: z.string(),
  operator: z.enum(["equals", "notEquals", "in", "notIn", "gt", "lt", "gte", "lte"]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
});

export const CsdConstraintActionSchema = z.object({
  action: z.enum(["restrictTo", "exclude", "setMin", "setMax", "reject", "warn"]),
  param: z.string().optional(),
  values: z.array(z.string()).optional(),
  value: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
});

export const CsdConstraintSchema = z.object({
  key: z.string().min(1),
  human: z.string(),
  severity: z.enum(["error", "warning"]),
  when: z.array(CsdConstraintConditionSchema).min(1),
  then: z.array(CsdConstraintActionSchema).min(1),
});

export type CsdConstraint = z.infer<typeof CsdConstraintSchema>;

// ── Invariant Schema ────────────────────────────────────────────────

export const CsdInvariantSchema = z.object({
  key: z.string().min(1),
  human: z.string(),
  severity: z.enum(["error", "warning"]),
  expression: z.string(),
});

export type CsdInvariant = z.infer<typeof CsdInvariantSchema>;

// ── Evidence Tier Schema ────────────────────────────────────────────

export const CsdEvidenceTierSchema = z.object({
  description: z.string(),
  required: z.array(z.string()),
});

export type CsdEvidenceTier = z.infer<typeof CsdEvidenceTierSchema>;

// ── Discovery Schema ────────────────────────────────────────────────

export const CsdDiscoverySchema = z.object({
  protocols: z.array(z.string()),
  detect: z.record(z.unknown()).optional(),
});

// ── Adapter Schema ──────────────────────────────────────────────────

export const CsdAdapterCommandSchema = z.object({
  description: z.string(),
  input: z.string().optional(),
  output: z.string().optional(),
});

export const CsdAdapterSchema = z.object({
  type: z.string(),
  configSchema: z.record(z.unknown()).optional(),
  commands: z.record(CsdAdapterCommandSchema).optional(),
});

// ── Pricing Schema ──────────────────────────────────────────────────

export const CsdPricingSchema = z.object({
  basePrice: z.string(),
  currency: z.string(),
  unit: z.string().optional(),
  minimumCharge: z.string().optional(),
});

export type CsdPricing = z.infer<typeof CsdPricingSchema>;

// ── Root CSD Schema ─────────────────────────────────────────────────

export const CsdSchema = z.object({
  $schema: z.string().optional(),
  /** Canonical URI, e.g. "pcc://capabilities/fdm/v2" */
  url: z.string().min(1),
  /** Semantic version */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (e.g. 1.0.0)"),
  status: z.enum(["draft", "active", "retired"]),
  name: z.string().min(1),
  description: z.string(),
  /** Structural kind */
  kind: z.enum(["base", "profile", "extension", "workflow"]),
  /** URI of the CSD this profile inherits from; null for base kinds */
  baseDefinition: z.string().nullable(),
  discovery: CsdDiscoverySchema.optional(),
  adapter: CsdAdapterSchema.optional(),
  parameters: z.array(CsdParameterSchema),
  constraints: z.array(CsdConstraintSchema),
  invariants: z.array(CsdInvariantSchema).optional(),
  evidence: z.record(CsdEvidenceTierSchema).optional(),
  pricing: CsdPricingSchema,
});

export type CSD = z.infer<typeof CsdSchema>;
