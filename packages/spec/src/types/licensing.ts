/**
 * Licensing Terms types for automatic IP licensing on PCC.
 *
 * When a designer registers a CSD as an IP Asset on Story Protocol,
 * they attach LicensingTerms that define how derivatives can be auto-approved,
 * what revenue shares apply, and how royalties decay through the derivative tree.
 */

import { z } from "zod";

// ── AutoLicenseConditions ────────────────────────────────────────────

export const AutoLicenseConditionsSchema = z.object({
  /** Minimum revenue share the derivative must offer for auto-approval */
  minRevSharePercent: z.number().min(0).max(100),

  /** Minimum assurance tier required (0-3) */
  minAssuranceTier: z.number().int().min(0).max(3),

  /** Allowed capability types (empty = any) */
  allowedCapabilityTypes: z.array(z.string()),

  /** Allowed CSD kinds for derivatives */
  allowedKinds: z.array(z.enum(["base", "profile", "extension", "workflow"])),

  /**
   * Maximum similarity score before it's considered a clone (reject at or above this).
   * e.g., 0.95 — anything >= 0.95 is a clone, not a derivative
   */
  cloneThreshold: z.number().min(0).max(1),

  /**
   * Minimum similarity to trigger licensing requirement.
   * e.g., 0.6 — below this is original, no license needed
   */
  derivativeThreshold: z.number().min(0).max(1),

  /** Whether to allow commercial use */
  commercialUse: z.boolean(),

  /** Geographic restrictions (empty = global) */
  allowedRegions: z.array(z.string()),
});

export type AutoLicenseConditions = z.infer<typeof AutoLicenseConditionsSchema>;

// ── StandingOffer ────────────────────────────────────────────────────

export const StandingOfferSchema = z.object({
  /** Human-readable name, e.g. "Community", "Enterprise", "Research" */
  name: z.string().min(1),

  /** Revenue share for this tier */
  revSharePercent: z.number().min(0).max(100),

  /** Conditions specific to this offer */
  conditions: z.object({
    /** Max monthly job volume (0 = unlimited) */
    maxMonthlyJobs: z.number().int().min(0),

    /** Minimum assurance tier */
    minTier: z.number().int().min(0).max(3),

    /** Required capability types (empty = any) */
    capabilityTypes: z.array(z.string()),
  }),

  /** Whether this offer auto-accepts or requires manual approval */
  autoAccept: z.boolean(),
});

export type StandingOffer = z.infer<typeof StandingOfferSchema>;

// ── LicensingTerms ───────────────────────────────────────────────────

export const LicensingTermsSchema = z.object({
  /** Unique ID for this license offer */
  id: z.string().min(1),

  /** The IP Asset these terms apply to */
  ipId: z.string().min(1),

  /** Designer's wallet address (receives royalties) */
  designerAddress: z.string().min(1),

  /** Auto-license conditions — if ALL are met, derivative is auto-approved */
  autoLicense: AutoLicenseConditionsSchema,

  /** Standing offers — pre-approved deal types */
  standingOffers: z.array(StandingOfferSchema),

  /**
   * Revenue share defaults (can be overridden per standing offer).
   * 0-100, percentage of derivative revenue flowing to this IP.
   */
  defaultRevShare: z.number().min(0).max(100),

  /** Whether derivatives can themselves be derived from (infinite nesting) */
  allowSubDerivatives: z.boolean(),

  /**
   * Sub-derivative revenue decay per level.
   * e.g., 0.5 = each level gets 50% of parent's share.
   */
  derivativeDecayRate: z.number().min(0).max(1),

  /** ISO 8601 timestamp */
  createdAt: z.string(),

  /** ISO 8601 timestamp */
  updatedAt: z.string(),
});

export type LicensingTerms = z.infer<typeof LicensingTermsSchema>;

// ── LicenseGrant ─────────────────────────────────────────────────────

export const LicenseGrantSchema = z.object({
  /** Unique grant ID */
  id: z.string().min(1),

  /** Which licensing terms this grant is under */
  licensingTermsId: z.string().min(1),

  /** Parent IP Asset ID */
  parentIpId: z.string().min(1),

  /** Child (derivative) IP Asset ID */
  childIpId: z.string().min(1),

  /** Which standing offer was used (if any) */
  standingOfferId: z.string().optional(),

  /** Negotiated or auto-determined revenue share (percentage offered by derivative) */
  revSharePercent: z.number().min(0).max(100),

  /** Depth in the derivative tree (1 = direct derivative) */
  derivativeDepth: z.number().int().min(1),

  /**
   * Effective revenue share after decay.
   * For depth 1: revShare * 1
   * For depth 2: revShare * decayRate^1
   * For depth N: revShare * decayRate^(N-1)
   */
  effectiveRevShare: z.number().min(0).max(100),

  /** Grant status */
  status: z.enum(["pending", "active", "revoked", "expired"]),

  /** Wallet receiving royalties */
  recipientAddress: z.string(),

  /** ISO 8601 timestamp */
  grantedAt: z.string(),
});

export type LicenseGrant = z.infer<typeof LicenseGrantSchema>;
