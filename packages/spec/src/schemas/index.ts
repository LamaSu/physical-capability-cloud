import { z } from "zod";

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

/**
 * Per-capability settlement mode (Week 2 — centralized substrate).
 *
 * - "centralized": gateway holds the ledger, signs receipts with its
 *   server Ed25519 key, anchors a daily Merkle root via Anchor.sol.
 *   No per-milestone gas. Default for new capabilities.
 * - "onchain": uses MilestoneEscrow.sol on Base Sepolia for every
 *   settlement. Higher trust, higher gas. Existing capabilities that
 *   were configured for on-chain escrow keep this mode.
 *
 * The schema field is OPTIONAL: capabilities authored before Week 2
 * have no settlementMode and are interpreted as "centralized" by
 * default. To opt into on-chain escrow, set "onchain" explicitly.
 */
export const SettlementModeSchema = z.enum(["centralized", "onchain"]);
export type SettlementMode = z.infer<typeof SettlementModeSchema>;

/** Default settlement mode applied when a capability omits the field. */
export const DEFAULT_SETTLEMENT_MODE: SettlementMode = "centralized";

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
  /**
   * Per-capability settlement mode (Week 2 centralized substrate).
   * Optional for backward compatibility; absence is interpreted as
   * `DEFAULT_SETTLEMENT_MODE` ("centralized") by consumers via
   * `resolveSettlementMode()`. Existing on-chain capabilities must set
   * "onchain" explicitly to keep their MilestoneEscrow.sol behavior.
   */
  settlementMode: SettlementModeSchema.optional(),
  /**
   * Week 7 B: per-capability default for the approval gate. When true,
   * settlements for this capability fire the SSE approval-request gate
   * unless explicitly overridden at the session or call layer. Optional
   * for backward compatibility; absence falls through to the
   * approvalThresholdUsd / env / default-false layers.
   */
  requiresApproval: z.boolean().optional(),
  /**
   * Week 7 B: per-capability amount threshold (USD). When set, settles
   * whose amount meets this threshold fire the approval gate even if
   * `requiresApproval` is false/unset. Useful for capabilities that
   * are usually unattended but require operator confirmation above a
   * configured monetary cutoff.
   */
  approvalThresholdUsd: z.number().nonnegative().optional(),
});

/**
 * Resolve a capability's effective settlement mode. Centralizes the
 * default-application logic so callers don't independently re-derive
 * "centralized" — that would silently flip an on-chain capability if a
 * caller forgot to handle the missing-field case.
 */
export function resolveSettlementMode(
  capability: { settlementMode?: SettlementMode } | null | undefined,
): SettlementMode {
  return capability?.settlementMode ?? DEFAULT_SETTLEMENT_MODE;
}

// ============================================================
// Evidence Schemas
// ============================================================

export const EvidenceEventTypeSchema = z.enum([
  "gcode_received", "gcode_hash_verified", "gcode_loaded",
  "execution_started", "execution_progress", "execution_completed", "execution_failed",
  "power_profile_sample", "power_profile_summary", "vibration_signature",
  "acoustic_signature", "temperature_log",
  "camera_snapshot", "cv_inspection_result",
  "tee_attestation",
  "custody_sealed", "custody_handoff_initiated", "custody_handoff_confirmed",
  "courier_pickup_confirmed", "courier_delivery_confirmed",
  // CVP events (paired with packages/spec/src/types/evidence.ts).
  "capture_class_declared",
  "capture_nonce_issued",
  "capture_submitted",
  "capture_signature_verified",
  "capture_liveness_result",
  "capture_multi_sensor_fusion",
  "capture_anchor_committed",
]);

export const EvidenceSourceSchema = z.object({
  deviceId: z.string(),
  deviceType: z.enum([
    "controller", "camera", "power_monitor", "vibration_sensor",
    "acoustic_sensor", "temperature_sensor", "tee", "courier_api", "human",
  ]),
  kernelId: z.string(),
  firmwareVersion: z.string().optional(),
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
