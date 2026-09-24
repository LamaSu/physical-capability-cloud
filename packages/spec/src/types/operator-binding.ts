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
 * v0, FROZEN FOR CONSUMERS (steward ruling #3058): adk, readmodels,
 * operator-ux and refvertical build against this shape. Any change needs
 * their ack on the bus first; a breaking change is a new version.
 */

import { z } from "zod";

import type { SHA256, Timestamp } from "./common.js";

export const OPERATOR_BINDING_SCHEMA = "pcc.operator-binding.v0" as const;

/** Derived from which backends the principal has; never caller-declared. */
export type ExecutorKind = "machine" | "human" | "digital" | "workcell" | "fleet";

export interface OperatorBindingEntry {
  kind: "kernel" | "skill" | "digital-kernel";
  id: string;
  capabilityType: string;
  /** The Capability Kit version this binding hosts, if any. */
  kitDigest: SHA256 | null;
  presence: "online" | "offline" | "unknown";
  availability: Record<string, unknown> | null;
  /** Capped by the server from proven evidence; never the self-declared tier. */
  assuranceTierCap: 0 | 1 | 2 | 3;
  lastSeenAt: Timestamp | null;
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
  /** From the server's payout-destination store only; null when none is set. */
  payee: OperatorPayeeView | null;
  moneyAuthority: "none";
  executionAuthority: {
    /** Capability types the principal may claim work for, derived from bindings. */
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

const FULL_EVM_ADDRESS = /0x[0-9a-fA-F]{40}/;

export const OperatorPayeeViewSchema = z
  .object({
    kind: z.enum(["wallet", "fiat_ref"]),
    maskedDestination: z
      .string()
      .min(1)
      .max(64)
      .refine((v) => v.includes(MASK) && !FULL_EVM_ADDRESS.test(v), {
        message: "maskedDestination must be masked (see maskPayoutDestination)",
      }),
    source: z.string().min(1).max(200),
    verified: z.boolean(),
  })
  .strict();

export const OperatorBindingEntrySchema = z
  .object({
    kind: z.enum(["kernel", "skill", "digital-kernel"]),
    id: z.string().min(1),
    capabilityType: z.string().min(1),
    kitDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
    presence: z.enum(["online", "offline", "unknown"]),
    availability: z.record(z.unknown()).nullable(),
    assuranceTierCap: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    lastSeenAt: z.string().nullable(),
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
    payee: OperatorPayeeViewSchema.nullable(),
    moneyAuthority: z.literal("none"),
    executionAuthority: z
      .object({ canClaimCapabilityTypes: z.array(z.string().min(1)) })
      .strict(),
    asOf: z.string().min(1),
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
