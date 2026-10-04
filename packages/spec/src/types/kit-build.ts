/**
 * Kit-build requests (kits K2, slice 0; ledger R7 and R45, PX-13's kit_build_request).
 * Pure contracts only, with no I/O:
 *   - KitBuildSpecV1: what a "kits.build" job offer asks to be built;
 *   - kitMeetsBuildSpec: whether a published, verified kit meets that spec (the
 *     check a kits.build delivery must pass);
 *   - kitBuildRequestFromOffer: the ONE constructor of kit_build_request
 *     OpportunityDTOs, from an offer and the producer's verified funding statement;
 *   - kitBuildSpecPrefill: R7's "fund a kit for this capability", from an approved
 *     public capability alone.
 * Design and lane agreements: returns/pcc-kits-work/k2-kit-build-requests-design.md
 * (escrow #6413, economics #6246, readmodels #6471).
 *
 * "Funded" is never read from the offer. Only the producer's statement can make a
 * request funded, and only when the producer re-read the escrow, found it HELD, and
 * found it bound to THIS offer by a server-recorded link. A funded request's reward
 * is the held amount the producer read, never the offer's pricing (a float in major
 * units, editable by its poster). Everything public about a request is derived: its
 * id from the offer id, its title from the capability. No poster-supplied text is
 * copied into it.
 */

import { z } from "zod";
import {
  CSD_CAPABILITY_URL_PATTERN,
  KIT_ARTIFACT_ROLES,
  KIT_REQUIRED_ROLES,
  validateKitCompleteness,
  type CapabilityKitManifestV1,
  type KitArtifactRole,
} from "./capability-kit.js";
import { OPPORTUNITY_SCHEMA, OpportunityDTOSchema, isPublicCapabilityUrl, type KitBuildRequestDTO } from "./opportunity.js";
import type { SHA256 } from "./common.js";

/** The job-offer category of a kit-build request. */
export const KIT_BUILD_CAPABILITY_TYPE = "kits.build" as const;

export const KIT_BUILD_SPEC_SCHEMA = "pcc.kit-build-spec.v1" as const;

/** USDC's on-chain decimals: rewards are base units, as escrow reads them (#6413). */
export const USDC_DECIMALS = 6;

/** A sha256 digest; the regex guarantees the `sha256:` template type the DTOs carry. */
const Sha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Must be sha256:<64 lowercase hex>")
  .refine((s): s is SHA256 => true);
const Label = z.string().min(1).max(120).regex(/^[^\n\r]*$/, "single line");

/** A list that holds each value once: a duplicate is refused, never collapsed. */
function uniqueList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .array(item)
    .min(1)
    .max(max)
    .refine((list) => new Set(list).size === list.length, "each entry at most once");
}

export const KitBuildSpecV1Schema = z
  .object({
    schema: z.literal(KIT_BUILD_SPEC_SCHEMA),
    /** The capability the kit must provide (a CSD url). */
    csdUrl: z.string().regex(CSD_CAPABILITY_URL_PATTERN),
    /** Pins the exact CSD revision the kit must carry for csdUrl. */
    capabilityContractDigest: Sha256Schema.optional(),
    /** Every family listed must be among the kit's compatibility.deviceFamilies. */
    deviceFamilies: uniqueList(Label, 50).optional(),
    /** Every interface listed must be among the kit's compatibility.interfaces. */
    interfaces: uniqueList(Label, 20).optional(),
    /** Artifact roles the kit must ship; default KIT_REQUIRED_ROLES. */
    requiredRoles: uniqueList(z.enum(KIT_ARTIFACT_ROLES), KIT_ARTIFACT_ROLES.length).optional(),
    /** "Improve this kit": the delivered kit must name it as its parent. */
    parentKitDigest: Sha256Schema.optional(),
  })
  .strict();

export type KitBuildSpecV1 = z.infer<typeof KitBuildSpecV1Schema>;

/** The spec in `input`, or null when it is not a valid KitBuildSpecV1. */
export function parseKitBuildSpec(input: unknown): KitBuildSpecV1 | null {
  const parsed = KitBuildSpecV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Why a kit does not meet a build spec: a closed set of reasons. */
export type KitSpecUnmetReason =
  | "capability_missing"
  | "contract_revision_mismatch"
  | "device_family_missing"
  | "interface_missing"
  | "role_missing"
  | "incomplete_kit"
  | "parent_mismatch";

export type KitSpecCheck = { ok: true } | { ok: false; reason: KitSpecUnmetReason; detail: string };

/**
 * Whether `manifest` meets `spec`. The caller must pass the manifest K1 verified
 * for the delivered digest; this function checks content only, never identity.
 */
export function kitMeetsBuildSpec(manifest: CapabilityKitManifestV1, spec: KitBuildSpecV1): KitSpecCheck {
  const capability = manifest.capabilities.find((c) => c.csdUrl === spec.csdUrl);
  if (!capability) return { ok: false, reason: "capability_missing", detail: spec.csdUrl };
  if (spec.capabilityContractDigest !== undefined && capability.capabilityContractDigest !== spec.capabilityContractDigest) {
    return { ok: false, reason: "contract_revision_mismatch", detail: spec.capabilityContractDigest };
  }
  const families = manifest.compatibility?.deviceFamilies ?? [];
  for (const family of spec.deviceFamilies ?? []) {
    if (!families.includes(family)) return { ok: false, reason: "device_family_missing", detail: family };
  }
  const interfaces = manifest.compatibility?.interfaces ?? [];
  for (const iface of spec.interfaces ?? []) {
    if (!interfaces.includes(iface)) return { ok: false, reason: "interface_missing", detail: iface };
  }
  const roles = new Set<KitArtifactRole>(manifest.artifacts.map((a) => a.role));
  for (const role of spec.requiredRoles ?? KIT_REQUIRED_ROLES) {
    if (!roles.has(role)) return { ok: false, reason: "role_missing", detail: role };
  }
  const completeness = validateKitCompleteness(manifest);
  if (!completeness.complete) return { ok: false, reason: "incomplete_kit", detail: completeness.missing.join(",") };
  if (spec.parentKitDigest !== undefined && manifest.parentKitDigest !== spec.parentKitDigest) {
    return { ok: false, reason: "parent_mismatch", detail: spec.parentKitDigest };
  }
  return { ok: true };
}

/**
 * `amount` major units as a decimal string of base units with `decimals` places,
 * exactly, or null. It works from the number's shortest round-trip decimal form
 * (String(amount)), so no float arithmetic touches the value. It refuses a
 * non-finite or non-positive number, exponent notation, and more fractional
 * digits than `decimals`.
 */
export function decimalToBaseUnits(amount: number, decimals: number): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const text = String(amount);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) return null;
  const digits = (m[1]! + fraction.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  return digits === "0" ? null : digits;
}

/**
 * The producer's VERIFIED statement about an offer's funding. readmodels re-reads
 * the escrow on chain (escrow #6413) through the server-recorded binding; nothing
 * in it may come from the offer body.
 */
export interface KitBuildFundingStatement {
  kind: "escrow";
  /** The escrow id the binding names. */
  id: string;
  /** The offer the server-recorded binding links this escrow to. */
  offerId: string;
  /** "held": every milestone Funded, Locked, Evidenced or Attested, and the row not given back. */
  state: "held" | "released" | "refunded" | "unknown";
  /** The held amount in base units, as a decimal string, as read from the chain. */
  amount: string;
  /** The token the held amount is in, e.g. "USDC". */
  currency: string;
  verifiedAt: string;
}

/** The offer fields the constructor reads, as the job-offer ledger stores them. */
export interface KitBuildOfferView {
  id: string;
  capabilityType: string;
  requirements: unknown;
  status: string;
  pricing?: { amount: number; currency: string; model: string } | null;
  deadlineIso?: string | null;
}

/** The public id of the request built from offer `offerId`: derived, never chosen. */
export function kitBuildRequestId(offerId: string): string {
  return `kit-build:${offerId}`;
}

/** The public title of a request for `csdUrl`: derived from the capability, never poster text. */
export function kitBuildRequestTitle(csdUrl: string): string {
  const m = /^pcc:\/\/capabilities\/([a-z0-9-]+)\/v([0-9]+)$/.exec(csdUrl);
  return m ? `Build a Capability Kit for ${m[1]} v${m[2]}` : "Build a Capability Kit";
}

/**
 * The kit_build_request OpportunityDTO for `offer` as of `asOf` (the producer's
 * read time), or null when the offer is not an open, valid kits.build request.
 *
 * - Funded (authority "authoritative", reward fundingStatus "funded", fundingRef
 *   {kind: "escrow", id}) ONLY when `funding` is the producer's statement for this
 *   very offer, in state "held", with an exact base-unit amount.
 * - A statement verified for ANOTHER offer refuses the whole request (null): it
 *   means the producer joined the wrong rows.
 * - Otherwise the request is unfunded ("derived_signal", no fundingRef). Its reward
 *   is shown only when the offer's fixed USDC pricing converts exactly.
 * - The result must pass OpportunityDTOSchema, or the constructor returns null.
 */
export function kitBuildRequestFromOffer(
  offer: KitBuildOfferView,
  funding: KitBuildFundingStatement | null,
  asOf: string,
): KitBuildRequestDTO | null {
  if (offer.capabilityType !== KIT_BUILD_CAPABILITY_TYPE || offer.status !== "open") return null;
  const spec = parseKitBuildSpec(offer.requirements);
  if (!spec) return null;
  if (funding !== null && funding.offerId !== offer.id) return null;

  const held: KitBuildFundingStatement | null =
    funding !== null &&
    funding.kind === "escrow" &&
    funding.state === "held" &&
    typeof funding.id === "string" &&
    funding.id !== "" &&
    typeof funding.amount === "string" &&
    /^[1-9][0-9]*$/.test(funding.amount) &&
    typeof funding.currency === "string" &&
    funding.currency !== ""
      ? funding
      : null;

  let money: Pick<KitBuildRequestDTO, "reward" | "fundingRef"> = {};
  if (held) {
    money = {
      reward: { amount: held.amount, currency: held.currency, fundingStatus: "funded" },
      fundingRef: { kind: "escrow", id: held.id },
    };
  } else if (offer.pricing && offer.pricing.model === "fixed" && offer.pricing.currency === "USDC") {
    const amount = decimalToBaseUnits(offer.pricing.amount, USDC_DECIMALS);
    if (amount !== null) money = { reward: { amount, currency: "USDC", fundingStatus: "unfunded" } };
  }

  const dto: KitBuildRequestDTO = {
    schema: OPPORTUNITY_SCHEMA,
    kind: "kit_build_request",
    id: kitBuildRequestId(offer.id),
    capabilityType: spec.csdUrl,
    ...(spec.capabilityContractDigest !== undefined ? { capabilityContractDigest: spec.capabilityContractDigest } : {}),
    title: kitBuildRequestTitle(spec.csdUrl),
    ...money,
    ...(typeof offer.deadlineIso === "string" ? { deadline: offer.deadlineIso } : {}),
    authority: held !== null ? "authoritative" : "derived_signal",
    asOf,
  };
  const parsed = OpportunityDTOSchema.safeParse(dto);
  return parsed.success && parsed.data.kind === "kit_build_request" ? (parsed.data as KitBuildRequestDTO) : null;
}

/**
 * R7's prefill, "fund a kit for this capability": the draft spec for an APPROVED
 * public capability, or null. It derives nothing beyond the capability itself, so
 * no demand detail can reach a request through it.
 */
export function kitBuildSpecPrefill(capabilityType: string, approvedUrls: Iterable<string>): KitBuildSpecV1 | null {
  if (typeof capabilityType !== "string" || !isPublicCapabilityUrl(capabilityType)) return null;
  let approved = false;
  for (const url of approvedUrls) {
    if (url === capabilityType) approved = true;
  }
  if (!approved) return null;
  return { schema: KIT_BUILD_SPEC_SCHEMA, csdUrl: capabilityType };
}
