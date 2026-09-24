/**
 * EconomicAgreementV1 — the input the economics compiler accepts (docs/ECONOMIC_AGREEMENTS.md §1-§2).
 *
 * Every object is `.strict()`: a field this module does not define is a schema error, never ignored,
 * so an agent cannot smuggle a term past the compiler. Amounts are decimal strings (never JS numbers).
 * Rights (`licenses`, `use`) and payments (`clauses`, `splits`, `units`, `fee`) are separate facts and
 * are hashed separately (see ./hash.ts).
 */

import { z } from "zod";
import { CONTRIBUTOR_ROLES } from "../payouts.js";

// ── Grammar ──────────────────────────────────────────────────────────────────

/**
 * 1-128 printable ASCII characters, no space. Exactly composition's `ID_PATTERN`
 * (csd/composition-commitment.ts), so every plan node id is a valid `unitRef`. ASCII keeps string
 * order equal to byte order in every language, and canonical JSON escapes only `"` and `\`.
 */
export const ID_PATTERN = /^[\x21-\x7E]{1,128}$/;
export const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** 2^128 − 1: the escrow's `toUint128` bound on a unit's gross. */
export const MAX_UNIT_GROSS = (1n << 128n) - 1n;
/** The escrow's MIN_BONDABLE_GROSS. */
export const MIN_UNIT_GROSS = 5n;
/** The escrow's MAX_FEE_BPS. */
export const MAX_FEE_BPS = 1000;
/**
 * Units per agreement. An agreement can span several V-next jobs (one per operator); grouping units
 * into jobs, and the escrow's per-job limits (16 units, 256 legs), belong to the accepted-plan compiler.
 */
export const MAX_AGREEMENT_UNITS = 256;
/** The escrow's MAX_PAYOUT_LEGS_PER_UNIT. */
export const MAX_LEGS_PER_UNIT = 16;
export const MAX_SPLIT_DEPTH = 8;
/**
 * Allocations (clause-to-party paths through splits, §4.5) over the whole agreement. Shared splits make
 * the number of paths multiply per level, so it is counted before anything is expanded (§3,
 * TOO_MANY_ALLOCATIONS). Real agreements use a few hundred.
 */
export const MAX_AGREEMENT_ALLOCATIONS = 65_536;

function isValidLabel(s: string): boolean {
  if (s.normalize("NFC") !== s) return false;
  const codePoints = [...s];
  if (codePoints.length < 1 || codePoints.length > 200) return false;
  for (const ch of codePoints) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return false;
    if (cp >= 0xd800 && cp <= 0xdfff) return false; // an unpaired surrogate survives spread as itself
  }
  return true;
}

export const IdSchema = z.string().regex(ID_PATTERN, "invalid id");
export const AmountSchema = z.string().regex(AMOUNT_PATTERN, "invalid amount");
export const AddressSchema = z.string().regex(ADDRESS_PATTERN, "invalid address");
export const HashSchema = z.string().regex(HASH_PATTERN, "invalid hash");
export const LabelSchema = z.string().refine(isValidLabel, "invalid label");
export const BpsSchema = z.number().int().min(0).max(10000);
export const TimeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const RoleSchema = z.enum(CONTRIBUTOR_ROLES);

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const IdSetSchema = (min: number, max: number) =>
  z.array(IdSchema).min(min).max(max).refine(uniqueStrings, "duplicate entry");

/** A license scope entry: a concrete id, or "*" for any. */
export const ScopeEntrySchema = z.union([z.literal("*"), IdSchema]);
const ScopeSetSchema = (min: number, max: number) =>
  z.array(ScopeEntrySchema).min(min).max(max).refine(uniqueStrings, "duplicate entry");

// ── Parties, units, splits ───────────────────────────────────────────────────

export const PartyKindSchema = z.enum(["person", "organization", "guild", "treasury", "agent", "protocol"]);

export const PartySchema = z
  .object({
    partyId: IdSchema,
    label: LabelSchema,
    kind: PartyKindSchema,
    payTo: AddressSchema.nullable(),
  })
  .strict();
export type Party = z.infer<typeof PartySchema>;

export const UnitSchema = z
  .object({
    unitRef: IdSchema,
    label: LabelSchema,
    gross: AmountSchema,
    components: z
      .array(z.object({ ref: IdSchema, uses: AmountSchema.refine((v) => v !== "0", "uses must be >= 1") }).strict())
      .max(64),
    measures: z.array(z.object({ key: IdSchema, value: AmountSchema }).strict()).max(64),
  })
  .strict();
export type Unit = z.infer<typeof UnitSchema>;

export const PayeeSchema = z.union([
  z.object({ party: IdSchema }).strict(),
  z.object({ split: IdSchema }).strict(),
]);
export type Payee = z.infer<typeof PayeeSchema>;

export const SplitMemberSchema = z
  .object({
    to: PayeeSchema,
    weight: z.number().int().min(1).max(1_000_000),
    role: RoleSchema.nullable(),
    subject: IdSchema.nullable(),
  })
  .strict();
export type SplitMember = z.infer<typeof SplitMemberSchema>;

export const SplitSchema = z
  .object({
    splitId: IdSchema,
    label: LabelSchema,
    members: z.array(SplitMemberSchema).min(1).max(32),
  })
  .strict();
export type Split = z.infer<typeof SplitSchema>;

// ── Rules and clauses ────────────────────────────────────────────────────────

export const RateSourceSchema = z
  .object({
    scheduleHash: HashSchema,
    evaluatedAt: TimeSchema,
    context: z
      .object({
        jobValueCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        jobsPerDay: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        captureClass: z.enum(["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"]).nullable(),
      })
      .strict(),
  })
  .strict();
export type RateSource = z.infer<typeof RateSourceSchema>;

export const FixedRuleSchema = z.object({ kind: z.literal("fixed"), amount: AmountSchema }).strict();

export const PerUseRuleSchema = z
  .object({
    kind: z.literal("per_use"),
    rate: AmountSchema,
    per: z.union([
      z.object({ component: IdSchema }).strict(),
      z.object({ measure: IdSchema }).strict(),
    ]),
    cap: AmountSchema.nullable(),
  })
  .strict();

export const PassThroughRuleSchema = z
  .object({
    kind: z.literal("pass_through"),
    cost: AmountSchema,
    markupBps: BpsSchema,
    costRef: IdSchema.nullable(),
  })
  .strict();

export const PercentRuleSchema = z
  .object({
    kind: z.literal("percent"),
    bps: BpsSchema,
    of: z.enum(["gross", "net"]),
    min: AmountSchema.nullable(),
    max: AmountSchema.nullable(),
    rateSource: RateSourceSchema.nullable(),
  })
  .strict()
  .refine((r) => r.bps > 0 || r.min !== null, "a percent rule with bps 0 and no min pays nothing");

export const ResidualRuleSchema = z.object({ kind: z.literal("residual") }).strict();

/** Parsed so they can be refused loudly (OD-4 is an operator decision), never silently reinterpreted. */
export const MeteredRuleSchema = z.object({ kind: z.literal("metered"), rate: AmountSchema, meter: IdSchema }).strict();
export const DownstreamRuleSchema = z
  .object({ kind: z.literal("downstream"), bps: BpsSchema, horizon: IdSchema })
  .strict();

export const RuleSchema = z.union([
  FixedRuleSchema,
  PerUseRuleSchema,
  PassThroughRuleSchema,
  PercentRuleSchema,
  ResidualRuleSchema,
  MeteredRuleSchema,
  DownstreamRuleSchema,
]);
export type Rule = z.infer<typeof RuleSchema>;
export type PercentRule = z.infer<typeof PercentRuleSchema>;

/**
 * A license requirement for a royalty whose rate comes from a published rate schedule. The rate is
 * job-dependent, so the license names the schedule rather than a number: it is met by a `percent`
 * clause pinned from exactly that schedule (same `of` / `min` / `max`), and the compiler refuses
 * unless it can re-evaluate the schedule and confirm the pinned bps (RATE_UNVERIFIED).
 */
export const PercentByScheduleRuleSchema = z
  .object({
    kind: z.literal("percent_by_schedule"),
    scheduleHash: HashSchema,
    of: z.enum(["gross", "net"]),
    min: AmountSchema.nullable(),
    max: AmountSchema.nullable(),
  })
  .strict();

/** Rules a license may require (a license never requires a residual or an OD-4 kind). */
export const RequirableRuleSchema = z.union([
  FixedRuleSchema,
  PerUseRuleSchema,
  PassThroughRuleSchema,
  PercentRuleSchema,
  PercentByScheduleRuleSchema,
]);
export type RequirableRule = z.infer<typeof RequirableRuleSchema>;

export const AppliesToSchema = z.union([
  z.object({ units: IdSetSchema(1, MAX_AGREEMENT_UNITS) }).strict(),
  z.object({ usingComponent: IdSchema }).strict(),
  z.object({ oncePerAgreementUsing: IdSchema }).strict(),
  z.object({ allUnits: z.literal(true) }).strict(),
]);
export type AppliesTo = z.infer<typeof AppliesToSchema>;

export const LicenseRefSchema = z.object({ licenseId: IdSchema, version: z.number().int().min(1).max(1_000_000_000) }).strict();

/**
 * A once-per-agreement amount is spread over the units that use the component (§2.4), so only a rule
 * with an agreement-level amount can carry it.
 */
export const ONCE_PER_AGREEMENT_RULE_KINDS = ["fixed", "pass_through"] as const;

export const ClauseSchema = z
  .object({
    clauseId: IdSchema,
    label: LabelSchema,
    role: RoleSchema,
    to: PayeeSchema,
    subject: IdSchema.nullable(),
    appliesTo: AppliesToSchema,
    underLicense: LicenseRefSchema.nullable(),
    rule: RuleSchema,
  })
  .strict()
  .refine(
    (c) => !("oncePerAgreementUsing" in c.appliesTo) || (ONCE_PER_AGREEMENT_RULE_KINDS as readonly string[]).includes(c.rule.kind),
    { message: "a once-per-agreement clause needs a fixed or pass_through rule", path: ["rule"] },
  );
export type Clause = z.infer<typeof ClauseSchema>;

// ── Rights ───────────────────────────────────────────────────────────────────

export const LICENSE_CLASSES = ["open", "permissive", "share-alike", "noncommercial", "proprietary"] as const;
export const LicenseClassSchema = z.enum(LICENSE_CLASSES);

/** Ordered weakest to strongest (docs §2.5, §4.1 step 3). */
export const AUTHORITY_LEVELS = [
  "self-asserted",
  "counterparty-accepted",
  "registry-anchored",
  "externally-attested",
] as const;
export const AuthoritySchema = z.enum(AUTHORITY_LEVELS);
export type Authority = z.infer<typeof AuthoritySchema>;

/**
 * Who a required payment goes to. `licensor` is the licensor alone. `distribution` is the licensor's
 * own declared division of that payment (for example a model author and the datasets it was trained
 * on), flat, so a composer cannot re-route a required royalty through a split of its own invention.
 */
export const RequirementPayeeSchema = z.union([
  z.object({ licensor: z.literal(true) }).strict(),
  z
    .object({
      distribution: z
        .array(
          z
            .object({
              party: IdSchema,
              weight: z.number().int().min(1).max(1_000_000),
              role: RoleSchema.nullable(),
              subject: IdSchema.nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(32)
        .refine((m) => uniqueStrings(m.map((x) => x.party)), "duplicate party in distribution"),
    })
    .strict(),
]);

export const PaymentRequirementSchema = z
  .object({
    requirementId: IdSchema,
    role: RoleSchema,
    /** "using-unit": owed in every unit that uses the subject. "agreement": owed once, spread over them. */
    per: z.enum(["using-unit", "agreement"]),
    payee: RequirementPayeeSchema,
    rule: RequirableRuleSchema,
  })
  .strict()
  .refine((q) => q.per !== "agreement" || (ONCE_PER_AGREEMENT_RULE_KINDS as readonly string[]).includes(q.rule.kind), {
    message: "a once-per-agreement payment needs a fixed or pass_through rule",
    path: ["rule"],
  })
  .refine((q) => q.rule.kind !== "percent" || q.rule.rateSource === null, {
    message: "a license states its percent; a rate source belongs to a clause pinned from a schedule",
    path: ["rule", "rateSource"],
  });
export type PaymentRequirement = z.infer<typeof PaymentRequirementSchema>;

export const LicenseSchema = z
  .object({
    licenseId: IdSchema,
    version: z.number().int().min(1).max(1_000_000_000),
    label: LabelSchema,
    licensor: IdSchema,
    subject: IdSchema,
    class: LicenseClassSchema,
    shareAlikeTag: IdSchema.nullable(),
    grants: z
      .object({
        commercialUse: z.boolean(),
        compose: z.boolean(),
        resell: z.boolean(),
        modify: z.boolean(),
        fieldsOfUse: ScopeSetSchema(1, 32),
        regions: ScopeSetSchema(1, 32),
      })
      .strict(),
    requires: z
      .object({
        attribution: z.boolean(),
        payments: z.array(PaymentRequirementSchema).max(8),
      })
      .strict(),
    validFrom: TimeSchema.nullable(),
    validUntil: TimeSchema.nullable(),
    authority: AuthoritySchema,
  })
  .strict()
  .refine((l) => (l.class === "share-alike") === (l.shareAlikeTag !== null), {
    message: "shareAlikeTag is required exactly when class is share-alike",
    path: ["shareAlikeTag"],
  })
  .refine((l) => uniqueStrings(l.requires.payments.map((p) => p.requirementId)), {
    message: "duplicate requirementId",
    path: ["requires", "payments"],
  });
export type License = z.infer<typeof LicenseSchema>;

export const IntendedUseSchema = z
  .object({
    /**
     * Always true: every unit the compiler accepts pays out a gross of at least 5 base units, so every
     * deal it compiles is paid work. A `false` here would only exist to dodge a noncommercial license.
     */
    commercial: z.literal(true),
    composite: z.boolean(),
    resell: z.boolean(),
    fieldOfUse: IdSchema,
    region: IdSchema,
    modifies: IdSetSchema(0, 64),
    outbound: z
      .object({ class: LicenseClassSchema, shareAlikeTag: IdSchema.nullable() })
      .strict()
      .refine((o) => (o.class === "share-alike") === (o.shareAlikeTag !== null), {
        message: "shareAlikeTag is required exactly when class is share-alike",
        path: ["shareAlikeTag"],
      }),
  })
  .strict();
export type IntendedUse = z.infer<typeof IntendedUseSchema>;

// ── The agreement ────────────────────────────────────────────────────────────

export const EconomicAgreementSchema = z
  .object({
    schema: z.literal("pcc.economic-agreement.v1"),
    agreementId: IdSchema,
    version: z.number().int().min(1).max(1_000_000_000),
    supersedes: HashSchema.nullable(),
    asOf: TimeSchema,
    currency: z
      .object({ code: z.string().regex(/^[A-Z0-9]{2,12}$/), decimals: z.number().int().min(0).max(36) })
      .strict(),
    payer: IdSchema,
    parties: z.array(PartySchema).min(1).max(64),
    units: z.array(UnitSchema).min(1).max(MAX_AGREEMENT_UNITS),
    splits: z.array(SplitSchema).max(64),
    clauses: z.array(ClauseSchema).min(1).max(128),
    licenses: z.array(LicenseSchema).max(64),
    use: IntendedUseSchema,
    fee: z.object({ feeBps: z.number().int().min(0).max(MAX_FEE_BPS), feeRecipient: AddressSchema.nullable() }).strict(),
    terms: z
      .object({ acceptBy: TimeSchema.nullable(), changePolicy: z.literal("new-version-required") })
      .strict(),
  })
  .strict();
export type EconomicAgreement = z.infer<typeof EconomicAgreementSchema>;
