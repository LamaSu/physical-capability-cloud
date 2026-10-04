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
 * Read times: `asOf` and every binding's `lastSeenAt` may not run more than
 * MAX_AS_OF_SKEW_MS (opportunity.ts) ahead of the clock that parses them (astra
 * pack 112b). That bounds a forged future time; it cannot prove the time is true,
 * so the server must assign both from its own clock.
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
 * Versioning: pre-release until first merge; afterwards EVERY shape, enum or
 * accepted-value change bumps OPERATOR_BINDING_SCHEMA. kits-contracts.test.ts
 * pins three things for it: the structural fingerprint of the schema; a semantic
 * corpus of accept and reject cases
 * (__tests__/kits-corpus/pcc.operator-binding.v0.json) with a case for each
 * refinement rule; and the digest of THIS file, which moves on any edit here,
 * including a refinement whose effect lies outside the corpus (astra pack 112
 * MEDIUM 8, 112b, 112c). The read-time bound it imports from opportunity.ts is
 * pinned with that file.
 */

import { z } from "zod";

import type { SHA256, Timestamp } from "./common.js";
import { CSD_CAPABILITY_URL_PATTERN } from "./capability-kit.js";
import { readTimeIsNotInFuture } from "./opportunity.js";

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
  /** A typed summary of the capability's availability, with no endpoint or authority field (see AvailabilitySummary). */
  availability: AvailabilitySummary | null;
  /** Capped by the server from proven evidence; never the self-declared tier. */
  assuranceTierCap: 0 | 1 | 2 | 3;
  /** A read time: never more than MAX_AS_OF_SKEW_MS ahead of the clock that parses it. */
  lastSeenAt: Timestamp | null;
}

/** Capacity the server knows about whose legacy type resolves to no CSD. Never claimable. */
export interface OperatorUnmappedCapacity {
  kind: "kernel" | "skill" | "digital-kernel";
  id: string;
  /** The legacy type string as recorded, e.g. "3d-printing". */
  legacyType: string;
}

/**
 * What a binding may say about availability (astra pack 112 MEDIUM 5): a closed,
 * typed shape with no endpoint or authority FIELD (strict, nested windows
 * included). `describe` is display text for the operator: a consumer must never
 * parse, fetch or execute it. The schema refuses ASCII `scheme://` text in it as
 * a backstop (astra pack 112b); it cannot recognise any other way of writing an
 * endpoint or an instruction. Its other strings are typed values (a time of day,
 * a cron expression, a timezone name) whose schema bounds their length only.
 */
export interface AvailabilitySummary {
  mode: "always" | "windows" | "cron" | "manual-claim" | "delegate-to-agent";
  windows?: Array<{ start: string; end: string; daysOfWeek?: number[]; timezone?: string }>;
  cron?: string;
  timezone?: string;
  /** Display text only; see AvailabilitySummary. */
  describe?: string;
}

export interface OperatorPayeeView {
  kind: "wallet" | "fiat_ref";
  /** Masked by maskPayoutDestination; the schema checks only the FORM of the mask. */
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
  /** READ time of this projection: never more than MAX_AS_OF_SKEW_MS ahead of the clock that parses it. */
  asOf: Timestamp;
}

const MASK = "…"; // "…"

/**
 * Mask a payout destination for display. It trims first, then: under 8
 * characters, the mask alone; under 40, the mask and the last 2 characters;
 * otherwise the first 6 and the last 4 around the mask. It reveals at most 25%
 * of the destination: an EVM address (42 characters) shows 6+4, and shorter
 * destinations show 2 characters or none. Lengths count UTF-16 code units.
 */
export function maskPayoutDestination(destination: string): string {
  const d = destination.trim();
  if (d.length < 8) return MASK;
  if (d.length < 40) return `${MASK}${d.slice(-2)}`;
  return `${d.slice(0, 6)}${MASK}${d.slice(-4)}`;
}

/**
 * The three FORMS maskPayoutDestination produces (astra pack 112b), for a
 * destination that holds no mask character itself: the bare mask, the mask and 2
 * characters, or 6 characters, the mask and 4 characters. The schema checks the
 * FORM only and cannot know the source length, so it cannot tell "abcdef…ghij"
 * masking a longer value from one that reconstructs a whole 10-character value;
 * the helper is what guarantees the ratio. A full address of 12 or more
 * characters, with or without an ellipsis, cannot fit any form.
 */
const MASKED_DESTINATION = new RegExp(`^(?:${MASK}|${MASK}[^${MASK}]{2}|[^${MASK}]{6}${MASK}[^${MASK}]{4})$`);

/** ASCII `scheme://` text, in any case: the backstop that keeps an endpoint out of `describe`. */
const URL_SCHEME_TEXT = /[a-z][a-z0-9+.-]*:\/\//i;

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

/** A read time: an ISO timestamp no more than MAX_AS_OF_SKEW_MS ahead of the clock that parses it (shared with OpportunityDTO). */
const ReadTimestamp = IsoTimestamp.refine(
  readTimeIsNotInFuture,
  "a read time may not run more than MAX_AS_OF_SKEW_MS ahead of the clock",
);

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
    describe: z
      .string()
      .max(2000)
      .refine((d) => !URL_SCHEME_TEXT.test(d), "describe is display text: it may not contain URL-scheme text such as https://")
      .optional(),
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
    lastSeenAt: ReadTimestamp.nullable(),
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
    asOf: ReadTimestamp,
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
