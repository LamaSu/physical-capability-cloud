/**
 * D1-minimal — the composable-capability SEAM ABI.
 *
 * This ONE auditable file mirrors, field-for-field and enum-for-enum, the prism
 * compiler's capability-contract shapes so a CSD's `composition` block projects
 * losslessly into the compiler's `CapabilityContractRegistrySnapshot`. The
 * authoritative source is `LamaSu/prism-orchestrator/src/plan/plan-ir.ts`
 * (`CapabilityContract` :1014 and the Effect/Predicate/PortType/
 * ParameterDefinition schemas above it) plus its unit table
 * `src/plan/quantity.ts` (`KNOWN_UNITS`). @pcc/spec does NOT depend on prism —
 * these are hand-copied mirrors. A field/enum drift here silently breaks
 * compilation later, so every shape below is a verbatim structural copy and
 * MUST be re-checked against prism whenever prism's plan-ir changes.
 *
 * STRICT throughout (unknown keys REJECTED, not stripped) — same posture as
 * prism, which parses these from untrusted agent input.
 *
 * Coexists with `CWMSchema` (the D-3 capability-world-model) — this seam is the
 * D2 projection target, not a replacement for CWM.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives — mirror of prism plan-ir.ts :67-72.
// ---------------------------------------------------------------------------

/** 64 hex characters — a 32-byte digest. Mirror of prism `Hex32Schema`. */
export const HEX32_PATTERN = /^[0-9a-fA-F]{64}$/;
export const Hex32Schema = z
  .string()
  .regex(HEX32_PATTERN, "must be exactly 64 hex characters (32 bytes)");

// ---------------------------------------------------------------------------
// Unit enum — VERBATIM mirror of prism `src/plan/quantity.ts` KNOWN_UNITS
// (the `UNIT_DEFS` symbol list, same order). prism builds
// `UnitSchema = z.enum(KNOWN_UNITS)`. If prism adds/removes a unit, this list
// MUST be updated in lockstep — a drift makes a snapshot unit that prism can't
// parse (or refuses a unit prism now knows).
// ---------------------------------------------------------------------------

export const KNOWN_UNITS = [
  // length — base: m
  "m", "mm", "cm", "km",
  // mass — base: kg
  "kg", "g", "mg", "ug",
  // time — base: s
  "s", "ms", "min", "h",
  // temperature — base: K (degC/degF affine)
  "K", "degC", "degF",
  // amount-of-substance — base: mol
  "mol", "mmol",
  // current — base: A
  "A", "mA",
  // luminosity — base: cd
  "cd",
  // volume — base: L
  "L", "mL", "uL", "m3",
  // speed — base: m/s
  "m/s", "km/h",
  // concentration — base: mol/L
  "mol/L", "mmol/L", "umol/L",
  // pressure — base: Pa
  "Pa", "kPa", "bar", "atm",
  // energy — base: J
  "J", "kJ", "cal",
] as const;

const KNOWN_UNIT_ENUM = KNOWN_UNITS as unknown as [string, ...string[]];
export const UnitSchema = z.enum(KNOWN_UNIT_ENUM);
export type Unit = z.infer<typeof UnitSchema>;

// ---------------------------------------------------------------------------
// Inert-JSON boundary — VERBATIM mirror of prism plan-ir.ts :148-221. Backs
// `ParameterDefinition.enumValues`. A CLOSED recursive JSON type verified WITHOUT
// invoking any user-supplied accessor/toJSON/function/symbol/custom-prototype/
// cycle — property DESCRIPTORS only. Copied whole so the accept-set is
// byte-identical to prism's (a looser mirror would admit a value prism rejects).
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function isPlainArrayInert(obj: object, seen: ReadonlySet<object>): boolean {
  const arr = obj as unknown[];
  const names = Object.getOwnPropertyNames(arr);
  const expected = new Set<string>(["length"]);
  for (let i = 0; i < arr.length; i++) expected.add(String(i));
  if (names.length !== expected.size || !names.every((n) => expected.has(n))) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(obj);
  for (let i = 0; i < arr.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(arr, i);
    if (!desc || desc.get || desc.set || !("value" in desc)) return false;
    if (!isInertJsonValue(desc.value, nextSeen)) return false;
  }
  return true;
}

function isPlainObjectInert(obj: object, seen: ReadonlySet<object>): boolean {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.prototype.hasOwnProperty.call(obj, "toJSON")) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key)!;
    if (!desc.enumerable) return false;
    if (desc.get || desc.set || !("value" in desc)) return false;
    if (!isInertJsonValue(desc.value, nextSeen)) return false;
  }
  return true;
}

/** Recursively verify `v` is closed, inert JSON-shaped data. Pure; never throws;
 * never invokes a property accessor / toJSON / user code. Mirror of prism. */
export function isInertJsonValue(v: unknown, seen: ReadonlySet<object> = new Set()): v is JsonValue {
  if (v === null) return true;
  const t = typeof v;
  if (t === "boolean" || t === "string") return true;
  if (t === "number") return Number.isFinite(v);
  if (t !== "object") return false; // undefined, bigint, symbol, function
  const obj = v as object;
  if (seen.has(obj)) return false; // cycle
  if (Object.getOwnPropertySymbols(obj).length > 0) return false;
  if (Array.isArray(obj) && Object.getPrototypeOf(obj) === Array.prototype) {
    return isPlainArrayInert(obj, seen);
  }
  return isPlainObjectInert(obj, seen);
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>((v) => isInertJsonValue(v), {
  message:
    "INVALID_ENUM_VALUE: must be inert, closed JSON data — no accessors/getters/setters, no toJSON, no functions, no symbols, no custom prototypes, no cycles, finite numbers only",
});

// ---------------------------------------------------------------------------
// Quantity — mirror of prism plan-ir.ts :233-239. `.finite()` is load-bearing:
// canonicalize() throws on NaN/Infinity, so a non-finite must be rejected at the
// parse boundary, never reach the digest.
// ---------------------------------------------------------------------------

export const QuantitySchema = z
  .object({
    value: z.number().finite(),
    unit: UnitSchema,
    uncertainty: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type Quantity = z.infer<typeof QuantitySchema>;

// ---------------------------------------------------------------------------
// Predicate grammar — mirror of prism plan-ir.ts :256-317.
// ---------------------------------------------------------------------------

const ValueLiteralSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const StateRefSchema = z
  .object({
    kind: z.enum(["asset", "fact", "node-output"]),
    id: z.string().min(1),
  })
  .strict();

const ValueExpressionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: ValueLiteralSchema }).strict(),
  z.object({ kind: z.literal("ref"), ref: StateRefSchema }).strict(),
]);

const QuantityExpressionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), quantity: QuantitySchema }).strict(),
  z.object({ kind: z.literal("ref"), ref: StateRefSchema }).strict(),
]);

export const PredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), subject: StateRefSchema }).strict(),
  z
    .object({ kind: z.literal("equals"), left: ValueExpressionSchema, right: ValueExpressionSchema })
    .strict(),
  z
    .object({
      kind: z.literal("comparison"),
      operator: z.enum(["lt", "lte", "gt", "gte"]),
      left: QuantityExpressionSchema,
      right: QuantityExpressionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("within-range"),
      value: QuantityExpressionSchema,
      minimum: QuantityExpressionSchema,
      maximum: QuantityExpressionSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("has-type"), subject: StateRefSchema, semanticType: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("has-state"), subject: StateRefSchema, state: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("authorized"),
      action: z.string().min(1),
      subject: StateRefSchema,
      authorityRequirementRef: z.string().min(1),
    })
    .strict(),
]);
export type Predicate = z.infer<typeof PredicateSchema>;

// ---------------------------------------------------------------------------
// Shared enums — mirror of prism plan-ir.ts :339 (ConsumptionMode) and :858
// (StateClass).
// ---------------------------------------------------------------------------

const ConsumptionModeSchema = z.enum(["read", "exclusive-use", "consume-whole", "consume-part"]);
const StateClassSchema = z.enum(["asset", "fact", "node-output"]);

// ---------------------------------------------------------------------------
// PortType — mirror of prism plan-ir.ts :802-808.
// ---------------------------------------------------------------------------

export const PortTypeSchema = z
  .object({
    semanticType: z.string().min(1),
    unit: UnitSchema.optional(),
    required: z.boolean(),
  })
  .strict();
export type PortType = z.infer<typeof PortTypeSchema>;

// ---------------------------------------------------------------------------
// EffectSignature — mirror of prism plan-ir.ts :860-953. Closed per-kind
// templates constraining effect kind + semantic class + transitions + bounds.
// ---------------------------------------------------------------------------

export const EffectSignatureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assert-fact"), semanticType: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("retract-fact"), semanticType: z.string().min(1).optional() }).strict(),
  z
    .object({
      kind: z.literal("update-state"),
      stateClass: StateClassSchema,
      allowedTransitions: z
        .array(z.object({ from: z.string().min(1).optional(), to: z.string().min(1) }).strict())
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create-asset"),
      semanticType: z.string().min(1),
      maxQuantity: QuantitySchema.optional(),
      quantityParamName: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("consume-asset"),
      semanticType: z.string().min(1).optional(),
      maxQuantity: QuantitySchema.optional(),
      quantityParamName: z.string().min(1).optional(),
      allowedConsumptionModes: z.array(ConsumptionModeSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("transform-asset"),
      inputSemanticTypes: z.array(z.string().min(1)).min(1),
      outputSemanticTypes: z.array(z.string().min(1)).min(1),
      minInputs: z.number().int().nonnegative().optional(),
      maxInputs: z.number().int().nonnegative().optional(),
      minOutputs: z.number().int().nonnegative().optional(),
      maxOutputs: z.number().int().nonnegative().optional(),
      transformClass: z.string().min(1).optional(),
      implementationDigest: Hex32Schema.optional(),
      mutatesInput: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("emit-output"), port: z.string().min(1) }).strict(),
]);
export type EffectSignature = z.infer<typeof EffectSignatureSchema>;

// ---------------------------------------------------------------------------
// PredicateSignature — mirror of prism plan-ir.ts :955-977.
// ---------------------------------------------------------------------------

export const PredicateSignatureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), stateClass: StateClassSchema }).strict(),
  z.object({ kind: z.literal("equals") }).strict(),
  z.object({ kind: z.literal("comparison") }).strict(),
  z.object({ kind: z.literal("within-range") }).strict(),
  z
    .object({
      kind: z.literal("has-type"),
      stateClass: StateClassSchema,
      semanticType: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("has-state"), stateClass: StateClassSchema, state: z.string().min(1).optional() })
    .strict(),
  z.object({ kind: z.literal("authorized"), action: z.string().min(1).optional() }).strict(),
]);
export type PredicateSignature = z.infer<typeof PredicateSignatureSchema>;

// ---------------------------------------------------------------------------
// ParameterDefinition — mirror of prism plan-ir.ts :997-1012. Domain-general
// (semanticType + unit + min/max Quantity + open enumValues set).
// ---------------------------------------------------------------------------

export const ParameterDefinitionSchema = z
  .object({
    name: z.string().min(1),
    semanticType: z.string().min(1),
    required: z.boolean(),
    unit: UnitSchema.optional(),
    minimum: QuantitySchema.optional(),
    maximum: QuantitySchema.optional(),
    enumValues: z.array(JsonValueSchema).optional(),
  })
  .strict();
export type ParameterDefinition = z.infer<typeof ParameterDefinitionSchema>;

// ---------------------------------------------------------------------------
// CapabilityContract + registry snapshot — mirror of prism plan-ir.ts
// :1014-1046. THE projection target of the D2 adapter.
// ---------------------------------------------------------------------------

export const CapabilityContractSchema = z
  .object({
    capabilityType: z.string().min(1),
    version: z.string().min(1),
    inputPorts: z.record(PortTypeSchema),
    outputPorts: z.record(PortTypeSchema),
    allowedEffectSignatures: z.array(EffectSignatureSchema),
    allowedPreconditionSignatures: z.array(PredicateSignatureSchema),
    requiredPreconditions: z.array(PredicateSchema),
    parameters: z.array(ParameterDefinitionSchema),
    requiredEffects: z.array(EffectSignatureSchema),
  })
  .strict();
export type CapabilityContract = z.infer<typeof CapabilityContractSchema>;

export const CapabilityContractRegistrySnapshotSchema = z
  .object({
    registryVersion: z.string().min(1),
    contracts: z.record(CapabilityContractSchema),
  })
  .strict();
export type CapabilityContractRegistrySnapshot = z.infer<typeof CapabilityContractRegistrySnapshotSchema>;

// ---------------------------------------------------------------------------
// The CSD `composition` block — the D1-minimal authoring surface. It carries
// the seven CapabilityContract port/effect/precondition/param fields EXCEPT
// `capabilityType`/`version` (those derive from the CSD's class + version, never
// re-declared). Each field is OPTIONAL so a CSD can declare composability
// incrementally (migration); the D2 adapter is the gate that requires a COMPLETE
// block before projecting a contract and FAILS CLOSED on a present-but-partial
// one (never invents a missing field). `.strict()` — an unknown/misspelled key
// is rejected, not silently dropped.
// ---------------------------------------------------------------------------

export const CompositionBlockSchema = z
  .object({
    inputPorts: z.record(PortTypeSchema).optional(),
    outputPorts: z.record(PortTypeSchema).optional(),
    allowedEffectSignatures: z.array(EffectSignatureSchema).optional(),
    requiredEffects: z.array(EffectSignatureSchema).optional(),
    allowedPreconditionSignatures: z.array(PredicateSignatureSchema).optional(),
    requiredPreconditions: z.array(PredicateSchema).optional(),
    parameters: z.array(ParameterDefinitionSchema).optional(),
  })
  .strict();
export type CompositionBlock = z.infer<typeof CompositionBlockSchema>;
