/**
 * OperatorBindingDTO v0 — one read of everything an operator has bound to PCC
 * (ledger R8/R41; shape agreed with pcc-operator-ux, bus #2896/#2944).
 *
 * The server derives every field from its own records: kernels, capability
 * rows, human skills, job-offer claims and the payout-destination store. A
 * caller never declares its executor kind, its assurance tier or its payee.
 *
 * Money: `moneyAuthority` is the literal "none". Binding capacity to PCC never
 * grants authority to move money; the scope checker enforces that (ledger
 * R28), and this field lets a UI say so without inferring it. Execution rights
 * come from the bindings, never from the key's scopes.
 *
 * Payout: the payee view is a masked READ of the destination the server
 * resolves from its own payout-destination store (N21). A binding never sets,
 * changes or authorizes a payout, and grants no spend authority (R41).
 *
 * Capability types are CSD urls (amendment A1). A binding, a kit and an
 * opportunity compare capability types directly, so a legacy type string such
 * as "3d-printing" can never silently fail to match. Capacity whose legacy type
 * resolves to no CSD is listed in `unmappedCapacity`, never claimable, so an
 * operator can see why it matches nothing.
 *
 * v0, FROZEN FOR CONSUMERS (steward ruling #3058): adk, readmodels,
 * operator-ux and refvertical build against this shape. Any change needs
 * their ack on the bus first; a breaking change is a new version. adk (#3785)
 * and operator-ux (#3997) acked amendment A1.
 *
 * Versioning: pre-release until first merge; afterwards EVERY shape or enum
 * change bumps OPERATOR_BINDING_SCHEMA, enforced by the pinned shape
 * fingerprint in kits-contracts.test.ts (astra pack 112 MEDIUM 8).
 */

import { z } from "zod";

import type { SHA256, Timestamp } from "./common.js";
import { CSD_CAPABILITY_URL_PATTERN } from "./capability-kit.js";

export const OPERATOR_BINDING_SCHEMA = "pcc.operator-binding.v0" as const;

/** Derived from which backends the principal has; never caller-declared. */
export type ExecutorKind = "machine" | "human" | "digital" | "workcell" | "fleet";

export interface OperatorBindingEntry {
  kind: "kernel" | "skill" | "digital-kernel";
  id: string;
  /** CSD url of the capability this binding serves, e.g. pcc://capabilities/liquid-handling/v1. */
  capabilityType: string;
  /** The Capability Kit version this binding hosts, if any. */
  kitDigest: SHA256 | null;
  presence: "online" | "offline" | "unknown";
  /** A typed summary of the capability's availability; never an endpoint or any authority field. */
  availability: AvailabilitySummary | null;
  /** Capped by the server from proven evidence; never the self-declared tier. */
  assuranceTierCap: 0 | 1 | 2 | 3;
  lastSeenAt: Timestamp | null;
}

/** Capacity the server knows about whose legacy type resolves to no CSD. Never claimable. */
export interface OperatorUnmappedCapacity {
  kind: "kernel" | "skill" | "digital-kernel";
  id: string;
  /** The legacy type string as recorded, e.g. "3d-printing". */
  legacyType: string;
}

/** What a binding may say about availability (astra pack 112 MEDIUM 5): a closed, typed shape. */
export interface AvailabilitySummary {
  mode: "always" | "windows" | "cron" | "manual-claim" | "delegate-to-agent";
  windows?: Array<{ start: string; end: string; daysOfWeek?: number[]; timezone?: string }>;
  cron?: string;
  timezone?: string;
  describe?: string;
}

export interface OperatorPayeeView {
  kind: "wallet" | "fiat_ref";
  /** Never the full destination: see maskPayoutDestination. */
  maskedDestination: string;
  /** Which record the destination came from, e.g. the payout-wallet store (N21). */
  source: string;
  verified: boolean;
}

export interface OperatorBindingDTO {
  schema: typeof OPERATOR_BINDING_SCHEMA;
  principal: {
    operatorId: string;
    /** "self_asserted" until provisioning binds the id to a proven credential. */
    identityStatus: "self_asserted" | "proven";
  };
  executorKinds: ExecutorKind[];
  bindings: OperatorBindingEntry[];
  /** Capacity that matches no CSD, and so no work; shown so the operator sees why. */
  unmappedCapacity: OperatorUnmappedCapacity[];
  /** From the server's payout-destination store only; null when none is set. */
  payee: OperatorPayeeView | null;
  moneyAuthority: "none";
  executionAuthority: {
    /** CSD urls the principal may claim work for, derived from bindings. */
    canClaimCapabilityTypes: string[];
  };
  /** READ time of this projection. */
  asOf: Timestamp;
}

const MASK = "…"; // "…"

/**
 * Mask a payout destination for display: the first 6 and last 4 characters,
 * joined by an ellipsis. Short values are masked entirely except their last 2.
 */
export function maskPayoutDestination(destination: string): string {
  const d = destination.trim();
  if (d.length <= 12) return `${MASK}${d.slice(-2)}`;
  return `${d.slice(0, 6)}${MASK}${d.slice(-4)}`;
}

/**
 * Exactly the two shapes maskPayoutDestination produces (astra pack 112 MEDIUM
 * 5): "…" + the last 2 characters, or the first 6 + "…" + the last 4. A full
 * address of any case or kind, with or without an ellipsis, cannot fit.
 */
const MASKED_DESTINATION = new RegExp(`^(?:${MASK}[^${MASK}]{2}|[^${MASK}]{6}${MASK}[^${MASK}]{4})$`);

export const OperatorPayeeViewSchema = z
  .object({
    kind: z.enum(["wallet", "fiat_ref"]),
    maskedDestination: z
      .string()
      .regex(MASKED_DESTINATION, "maskedDestination must be masked exactly as maskPayoutDestination masks it"),
    source: z.string().min(1).max(200),
    verified: z.boolean(),
  })
  .strict();

const IsoTimestamp = z.string().datetime({ offset: true });

export const AvailabilitySummarySchema = z
  .object({
    mode: z.enum(["always", "windows", "cron", "manual-claim", "delegate-to-agent"]),
    windows: z
      .array(
        z
          .object({
            start: z.string().min(1).max(40),
            end: z.string().min(1).max(40),
            daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
            timezone: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    cron: z.string().min(1).max(120).optional(),
    timezone: z.string().min(1).max(64).optional(),
    describe: z.string().max(2000).optional(),
  })
  .strict();

export const OperatorBindingEntrySchema = z
  .object({
    kind: z.enum(["kernel", "skill", "digital-kernel"]),
    id: z.string().min(1),
    capabilityType: z.string().regex(CSD_CAPABILITY_URL_PATTERN, "Must be a CSD url"),
    kitDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
    presence: z.enum(["online", "offline", "unknown"]),
    availability: AvailabilitySummarySchema.nullable(),
    assuranceTierCap: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    lastSeenAt: IsoTimestamp.nullable(),
  })
  .strict();

export const OperatorUnmappedCapacitySchema = z
  .object({
    kind: z.enum(["kernel", "skill", "digital-kernel"]),
    id: z.string().min(1),
    legacyType: z.string().min(1).max(120),
  })
  .strict();

export const OperatorBindingDTOSchema = z
  .object({
    schema: z.literal(OPERATOR_BINDING_SCHEMA),
    principal: z
      .object({
        operatorId: z.string().min(1),
        identityStatus: z.enum(["self_asserted", "proven"]),
      })
      .strict(),
    executorKinds: z.array(z.enum(["machine", "human", "digital", "workcell", "fleet"])),
    bindings: z.array(OperatorBindingEntrySchema),
    unmappedCapacity: z.array(OperatorUnmappedCapacitySchema).max(500),
    payee: OperatorPayeeViewSchema.nullable(),
    moneyAuthority: z.literal("none"),
    executionAuthority: z
      .object({ canClaimCapabilityTypes: z.array(z.string().regex(CSD_CAPABILITY_URL_PATTERN, "Must be a CSD url")) })
      .strict(),
    asOf: IsoTimestamp,
  })
  .strict()
  .superRefine((dto, ctx) => {
    // Claim rights must come from bindings: a type with no binding can't be claimable.
    const bound = new Set(dto.bindings.map((b) => b.capabilityType));
    for (const t of dto.executionAuthority.canClaimCapabilityTypes) {
      if (!bound.has(t)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `claim right for unbound type ${t}` });
      }
    }
  });
