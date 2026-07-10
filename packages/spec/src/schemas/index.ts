import { z } from "zod";
import { EVIDENCE_DEVICE_TYPES, EVIDENCE_EVENT_TYPES } from "../types/evidence.js";

// ============================================================
// Common Schemas
// ============================================================

export const SHA256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "Must be sha256:<64 hex chars>");
export const PedersenHashSchema = z.string().regex(/^pedersen:[a-f0-9]{64}$/, "Must be pedersen:<64 hex chars>");
export const HashDigestSchema = z.union([SHA256Schema, PedersenHashSchema]);
export const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Must be 0x<40 hex chars>");
export const TimestampSchema = z.string().datetime();
export const AmountSchema = z.string().regex(/^\d+(\.\d+)?$/, "Must be numeric string");
export const CurrencySchema = z.enum(["USDC", "ETH", "DAI"]);
export const AssuranceTierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

export const GeoLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const TimeWindowSchema = z.object({
  start: TimestampSchema,
  end: TimestampSchema,
});

export const SignatureSchema = z.object({
  signer: AddressSchema,
  algorithm: z.enum(["secp256k1", "ed25519"]),
  value: z.string(),
});

// ============================================================
// Capability Schemas
// ============================================================

export const CapabilityTypeSchema = z.enum([
  "cnc-3axis", "cnc-5axis", "fdm", "sla", "sls", "mjf",
  "lathe", "laser-cut", "waterjet", "sheet-metal",
  "injection-mold", "courier-pickup", "courier-delivery",
  "inspection", "assembly", "custom",
]);

export const WorkEnvelopeSchema = z.object({
  x: z.number().positive(),
  y: z.number().positive(),
  z: z.number().positive(),
  unit: z.enum(["mm", "in"]),
});

export const PricingModelSchema = z.object({
  currency: CurrencySchema,
  baseCost: AmountSchema,
  perMinute: AmountSchema.optional(),
  perGram: AmountSchema.optional(),
  perCm3: AmountSchema.optional(),
  minimum: AmountSchema,
});

export const CapabilitySchema = z.object({
  id: z.string(),
  kernelId: z.string(),
  type: CapabilityTypeSchema,
  name: z.string(),
  description: z.string().optional(),
  materials: z.array(z.string()),
  tolerances: z.object({
    linear: z.string().optional(),
    surface: z.string().optional(),
    positional: z.string().optional(),
  }).optional(),
  envelope: WorkEnvelopeSchema.optional(),
  assuranceTiers: z.array(AssuranceTierSchema),
  pricing: PricingModelSchema,
  availability: z.object({
    timezone: z.string(),
    windows: z.record(z.string(), z.array(TimeWindowSchema)),
    blackouts: z.array(z.string()).optional(),
  }),
  location: GeoLocationSchema,
  queueDepth: z.number().int().min(0),
  tags: z.array(z.string()).optional(),
});

// ============================================================
// Evidence Schemas
// ============================================================

// Derived from the TS union's single source of truth (types/evidence.ts
// EVIDENCE_EVENT_TYPES) — this enum had drifted to 27 hand-listed values
// while the TS union grew to 56, so sila instrument_result, modbus
// sensor_data_summary, machine-log printer_log_captured, batch and
// digital-workflow events failed EvidenceEventSchema.parse wherever it was
// enforced (same drift bug as deviceType below).
export const EvidenceEventTypeSchema = z.enum(EVIDENCE_EVENT_TYPES);

export const EvidenceSourceSchema = z.object({
  deviceId: z.string(),
  // Derived from the TS union's single source of truth (types/evidence.ts
  // EVIDENCE_DEVICE_TYPES) — this enum had drifted to 9 hand-listed values
  // while the TS type grew to 26, so sila / modbus / opentrons / instrument
  // events failed EvidenceEventSchema.parse wherever it was enforced.
  deviceType: z.enum(EVIDENCE_DEVICE_TYPES),
  kernelId: z.string(),
  firmwareVersion: z.string().optional(),
  // Fabricated-by-design marker (mock/simulated adapters). Kept in the schema
  // so schema-validated round-trips do not strip the honesty tag.
  simulated: z.boolean().optional(),
});

export const EvidenceEventSchema = z.object({
  id: z.string(),
  type: EvidenceEventTypeSchema,
  timestamp: TimestampSchema,
  source: EvidenceSourceSchema,
  payload: z.record(z.string(), z.unknown()),
  hash: SHA256Schema,
});

export const EvidenceBundleSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  stepId: z.string(),
  kernelId: z.string(),
  assuranceTier: AssuranceTierSchema,
  events: z.array(EvidenceEventSchema).min(1),
  bundleHash: SHA256Schema,
  kernelSignature: SignatureSchema,
  createdAt: TimestampSchema,
});

// ============================================================
// CWM Schemas
// ============================================================

export const StepInputSchema = z.object({
  fileHash: SHA256Schema,
  mimeType: z.string(),
  storageRef: z.string(),
  filename: z.string().optional(),
});

export const CourierParamsSchema = z.object({
  from: z.union([
    z.object({ stepId: z.string() }),
    z.object({ address: z.string(), location: GeoLocationSchema }),
  ]),
  to: z.union([
    z.object({ stepId: z.string() }),
    z.object({ address: z.string(), location: GeoLocationSchema }),
  ]),
  packageWeight: z.number().positive().optional(),
  packageDimensions: z.object({
    x: z.number().positive(),
    y: z.number().positive(),
    z: z.number().positive(),
    unit: z.enum(["mm", "in"]),
  }).optional(),
  priority: z.enum(["economy", "standard", "express"]).optional(),
  handling: z.string().optional(),
});

export const CWMStepSchema = z.object({
  id: z.string(),
  capability: CapabilityTypeSchema,
  params: z.record(z.string(), z.unknown()),
  inputs: z.array(StepInputSchema).optional(),
  courier: CourierParamsSchema.optional(),
  assuranceTier: AssuranceTierSchema,
  dependsOn: z.array(z.string()),
  preferredKernel: z.string().optional(),
  maxPrice: AmountSchema.optional(),
  estimatedDuration: z.number().positive().optional(),
});

export const CWMSettlementSchema = z.object({
  currency: CurrencySchema,
  maxBudget: AmountSchema,
  escrowContract: AddressSchema.optional(),
  payer: AddressSchema,
});

export const CWMSchema = z.object({
  version: z.literal("1.0"),
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(CWMStepSchema).min(1),
  settlement: CWMSettlementSchema,
  createdAt: TimestampSchema,
  submitter: AddressSchema,
  deadline: TimestampSchema.optional(),
  tags: z.array(z.string()).optional(),
});

// ============================================================
// Settlement Schemas
// ============================================================

export const EscrowStatusSchema = z.enum([
  "unfunded", "funded", "locked", "releasing",
  "released", "disputed", "refunded", "slashed",
]);

export const EscrowMilestoneSchema = z.object({
  stepId: z.string(),
  amount: AmountSchema,
  status: EscrowStatusSchema,
  evidenceBundleHash: SHA256Schema.optional(),
  verifierAttestationHash: SHA256Schema.optional(),
  challengeWindowStart: TimestampSchema.optional(),
  challengeWindowEnd: TimestampSchema.optional(),
  bondAmount: AmountSchema,
});

export const EscrowSchema = z.object({
  id: z.string(),
  cwmId: z.string(),
  contractAddress: AddressSchema,
  payer: AddressSchema,
  totalAmount: AmountSchema,
  currency: CurrencySchema,
  milestones: z.array(EscrowMilestoneSchema),
  status: z.enum(["created", "funded", "active", "completing", "completed", "disputed", "refunded"]),
  createdAt: TimestampSchema,
  deadline: TimestampSchema,
});

export const DisputeSchema = z.object({
  id: z.string(),
  escrowId: z.string(),
  milestoneStepId: z.string(),
  challenger: AddressSchema,
  challengerBond: AmountSchema,
  reason: z.string(),
  challengerEvidenceHash: SHA256Schema.optional(),
  status: z.enum(["filed", "under_review", "resolved_for_challenger", "resolved_for_operator", "dismissed"]),
  filedAt: TimestampSchema,
});

// ============================================================
// Kernel Schemas
// ============================================================

export const ShopKernelSchema = z.object({
  id: z.string(),
  name: z.string(),
  operatorAddress: AddressSchema,
  location: GeoLocationSchema,
  physicalAddress: z.string(),
  capabilities: z.array(CapabilitySchema),
  maxAssuranceTier: AssuranceTierSchema,
  publicKey: z.string(),
  reputation: z.number().min(0).max(1000),
  totalJobsCompleted: z.number().int().min(0),
  status: z.enum(["online", "offline", "maintenance", "suspended"]),
  registeredAt: TimestampSchema,
  lastHeartbeat: TimestampSchema,
  version: z.string(),
});
