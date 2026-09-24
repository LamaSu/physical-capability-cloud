/**
 * Capability Kit — a reusable, content-addressed recipe for standing up a
 * capability (ledger R5/R6).
 *
 * A Kit REFERENCES existing PCC artifacts by digest; it never inlines or
 * re-defines them. Semantics are a CSD pinned by its capabilityContractDigest
 * (a CSD url alone is a mutable pointer). The adapter, tests, provenance
 * recipe, install recipe and any machine-native files (Opentrons labware, PLR
 * resources, CAD) are artifacts named by the sha256 of their bytes. Economic
 * and rights terms are hashes that the economics compiler produces and
 * compiles; a kit never carries its own royalty arithmetic.
 *
 * Identity: kitDigest = sha256(canonicalize(normalized manifest)), the same
 * construction as capabilityContractDigest. Array order does not change the
 * digest (capabilities, artifacts and compatibility lists are sorted first), so
 * two tools describing the same kit agree on its identity. A published version
 * never changes: an edit is a new manifest, whose parentKitDigest names the
 * version it revises or forks.
 *
 * The manifest holds content only. Who published it, when, its status and how
 * often it is reused are registry metadata, stamped by the server and never
 * part of the hashed bytes.
 */

import { z } from "zod";

import type { SHA256 } from "./common.js";
import { canonicalize, sha256 } from "../util/canonical.js";

export const KIT_MANIFEST_SCHEMA = "pcc.capability-kit/v1" as const;

/** What an artifact is for. Machine-native roles cover lab/workcell kits. */
export const KIT_ARTIFACT_ROLES = [
  "adapter",
  "method",
  "config-schema",
  "telemetry-map",
  "provenance-recipe",
  "tests",
  "install-recipe",
  "labware-definition",
  "plr-resource",
  "cad",
  "deck-layout",
  "economics-terms",
  "docs",
] as const;
export type KitArtifactRole = (typeof KIT_ARTIFACT_ROLES)[number];

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Must be sha256:<64 lowercase hex>");
/** The economics lane's domain-separated terms hash format. */
const TermsHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/, "Must be 0x<64 lowercase hex>");

export const KitArtifactRefSchema = z
  .object({
    role: z.enum(KIT_ARTIFACT_ROLES),
    /** Stable name within the kit, e.g. "opentrons-labware.json". */
    name: z.string().min(1).max(200),
    mediaType: z.string().min(1).max(120),
    /** sha256 of the exact artifact bytes (a JSON artifact: of its canonical form). */
    digest: Sha256DigestSchema,
    /**
     * Where the bytes can be fetched when the registry does not hold them:
     * a repository URL pinned to a commit, or an https URL. The digest, not the
     * source, is what binds the kit to its content.
     */
    source: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type KitArtifactRef = z.infer<typeof KitArtifactRefSchema>;

export const KitCapabilityRefSchema = z
  .object({
    /** CSD url, e.g. pcc://capabilities/liquid-handling/v1 */
    csdUrl: z.string().regex(/^pcc:\/\/capabilities\/[a-z0-9-]+\/v[0-9]+$/),
    /** Pins the exact CSD revision; see capability-contract-identity.ts. */
    capabilityContractDigest: Sha256DigestSchema,
  })
  .strict();
export type KitCapabilityRef = z.infer<typeof KitCapabilityRefSchema>;

const Label = z.string().min(1).max(120);

export const KitCompatibilitySchema = z
  .object({
    deviceFamilies: z.array(Label).max(50).optional(),
    models: z.array(Label).max(200).optional(),
    interfaces: z.array(Label).max(20).optional(),
    platforms: z.array(Label).max(20).optional(),
  })
  .strict();
export type KitCompatibility = z.infer<typeof KitCompatibilitySchema>;

export const KitEconomicsSchema = z
  .object({
    /** SPDX license id for the kit's own software and design artifacts. */
    spdxLicense: z.string().min(1).max(100).optional(),
    /**
     * Economics-lane hashes over the builder's clause set. Self-asserted (L0):
     * they fund nothing until they sit inside an accepted deal.
     */
    economicTermsHash: TermsHashSchema.optional(),
    rightsTermsHash: TermsHashSchema.optional(),
  })
  .strict();
export type KitEconomics = z.infer<typeof KitEconomicsSchema>;

export const CapabilityKitManifestV1Schema = z
  .object({
    schema: z.literal(KIT_MANIFEST_SCHEMA),
    name: z.string().min(1).max(200),
    /** Builder-chosen semver for humans; the digest is the identity. */
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "Must be semver"),
    description: z.string().max(4000).optional(),
    /** Digest of the version this one revises or forks; null for a first version. */
    parentKitDigest: Sha256DigestSchema.nullable(),
    capabilities: z.array(KitCapabilityRefSchema).min(1).max(20),
    artifacts: z.array(KitArtifactRefSchema).min(1).max(200),
    compatibility: KitCompatibilitySchema.optional(),
    /**
     * Assurance tiers the provenance recipe is DESIGNED to reach. A claim, not
     * a proof: a binding's tier is capped by the evidence it actually produces.
     */
    declaredAssuranceTiers: z.array(z.number().int().min(0).max(3)).max(4).optional(),
    economics: KitEconomicsSchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seenArtifacts = new Set<string>();
    for (const a of m.artifacts) {
      const key = `${a.role}\u0000${a.name}`;
      if (seenArtifacts.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate artifact ${a.role}/${a.name}` });
      }
      seenArtifacts.add(key);
    }
    const seenCsd = new Set<string>();
    for (const c of m.capabilities) {
      if (seenCsd.has(c.csdUrl)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate capability ${c.csdUrl}` });
      }
      seenCsd.add(c.csdUrl);
    }
  });
export type CapabilityKitManifestV1 = z.infer<typeof CapabilityKitManifestV1Schema>;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs: string[] | undefined): string[] | undefined =>
  xs === undefined ? undefined : [...new Set(xs)].sort(cmp);

/**
 * Validate a manifest and put every order-insensitive list in canonical order,
 * so the digest depends on content only. Throws on an invalid manifest.
 */
export function normalizeKitManifest(manifest: unknown): CapabilityKitManifestV1 {
  const m = CapabilityKitManifestV1Schema.parse(manifest);
  const compatibility = m.compatibility
    ? {
        deviceFamilies: sortedUnique(m.compatibility.deviceFamilies),
        models: sortedUnique(m.compatibility.models),
        interfaces: sortedUnique(m.compatibility.interfaces),
        platforms: sortedUnique(m.compatibility.platforms),
      }
    : undefined;
  return {
    ...m,
    capabilities: [...m.capabilities].sort((a, b) => cmp(a.csdUrl, b.csdUrl)),
    artifacts: [...m.artifacts].sort((a, b) => cmp(a.role, b.role) || cmp(a.name, b.name)),
    compatibility,
    declaredAssuranceTiers:
      m.declaredAssuranceTiers === undefined
        ? undefined
        : [...new Set(m.declaredAssuranceTiers)].sort((a, b) => a - b),
  };
}

/**
 * The kit's identity: sha256 over the canonical JSON of the normalized
 * manifest, as `sha256:<hex>`. Throws on an invalid manifest, so an invalid
 * kit never gets an identity.
 */
export async function computeKitDigest(manifest: unknown): Promise<SHA256> {
  return sha256(canonicalize(normalizeKitManifest(manifest)));
}

/** Artifact roles every reusable kit must carry. */
export const KIT_REQUIRED_ROLES: readonly KitArtifactRole[] = [
  "tests",
  "install-recipe",
  "provenance-recipe",
];

export interface KitCompleteness {
  complete: boolean;
  /** Human-readable gaps, e.g. "role:tests", "implementation", "license". */
  missing: string[];
}

/**
 * Whether a manifest is a REUSABLE kit rather than a one-off listing: another
 * operator can deploy it from the manifest alone. It needs an implementation
 * (an adapter or a method), tests, an install recipe, a provenance recipe and
 * a license (an SPDX id or a rights-terms hash). A kit-build bounty accepts
 * only a complete kit.
 */
export function validateKitCompleteness(manifest: CapabilityKitManifestV1): KitCompleteness {
  const roles = new Set(manifest.artifacts.map((a) => a.role));
  const missing: string[] = [];
  if (!roles.has("adapter") && !roles.has("method")) missing.push("implementation");
  for (const r of KIT_REQUIRED_ROLES) if (!roles.has(r)) missing.push(`role:${r}`);
  if (!manifest.economics?.spdxLicense && !manifest.economics?.rightsTermsHash) missing.push("license");
  return { complete: missing.length === 0, missing };
}
