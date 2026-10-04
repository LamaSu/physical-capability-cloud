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
 *
 * The digest uses @pcc/spec's single canonicalizer (util/canonical.ts), never a
 * second one. Golden vectors are pinned in kits-contracts.test.ts; re-run them
 * whenever that canonicalizer changes (N15 / PR #359).
 *
 * Conventions (v0 amendment A4; no shape change):
 *   - The `provenance-recipe` artifact has mediaType
 *     `application/vnd.pcc.provenance-recipe+json;v=1`: which evidence
 *     primitives the kit emits, and which ones each tier requires. It is
 *     co-owned with the evidence lane.
 *   - `compatibility.interfaces` uses the kernel's AdapterType names
 *     (packages/kernel/src/kernel-config.ts) as the single source, for example
 *     opentrons, hamilton, octoprint, ipp, modbus, opcua, sila or generic-http.
 *     A kit never declares "mock".
 *
 * v0, FROZEN FOR CONSUMERS (steward ruling #3058): adk, readmodels,
 * operator-ux and refvertical build against this shape. Any change needs
 * their ack on the bus first; a breaking change is a new version. Amendment 1
 * (2026-09-29) was acked on the bus before it landed. It adds A4 (the
 * conventions above), A6 (artifact names are safe relative paths) and A7
 * (artifact roles intake-schema and safety-envelope), and shares the CSD url
 * pattern with the binding and opportunity contracts.
 *
 * Versioning: pre-release until first merge (no deployed producer or consumer
 * yet), so amendment 1 and the pack-112 and 112b fixes land under the same
 * literal. After the first merge, EVERY shape, enum or accepted-value change
 * bumps KIT_MANIFEST_SCHEMA. kits-contracts.test.ts pins three things for it: the
 * structural fingerprint of the schema; a semantic corpus of accept and reject
 * cases (__tests__/kits-corpus/pcc.capability-kit-v1.json) with a case for each
 * refinement rule; and the digest of THIS file, which moves on any edit here,
 * including a refinement whose effect lies outside the corpus. All three fail
 * until the bump is done deliberately (astra pack 112 MEDIUM 8, 112b, 112c). The
 * kit digest also reads util/canonical.ts, which its golden vectors pin.
 */

import { z } from "zod";

import type { SHA256 } from "./common.js";
import { canonicalize, sha256 } from "../util/canonical.js";

export const KIT_MANIFEST_SCHEMA = "pcc.capability-kit/v1" as const;

/**
 * A CSD capability url, e.g. pcc://capabilities/liquid-handling/v1. One pattern
 * shared by the kit manifest, OperatorBindingDTO and OpportunityDTO, so a
 * binding, a kit and an opportunity compare capability types directly.
 */
export const CSD_CAPABILITY_URL_PATTERN = /^pcc:\/\/capabilities\/[a-z0-9-]+\/v[0-9]+$/;

/**
 * An artifact name is a relative POSIX path (amendment A6). Segments are
 * [A-Za-z0-9._-]+, and there is no leading "/", no "." or ".." segment, no
 * backslash and no empty segment. An installer may write an artifact to disk by
 * its name, so a name must never be able to leave the kit's directory.
 */
export const KIT_ARTIFACT_NAME_PATTERN = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

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
  // Amendment A7 (adk #4099): the onboarding artifacts a device kit ships with.
  "intake-schema", // the filled human-intake record schema (packages/spec/src/onboarding/intake)
  "safety-envelope", // the operational/safety envelope (sensors' R8, packages/spec/src/onboarding)
] as const;
export type KitArtifactRole = (typeof KIT_ARTIFACT_ROLES)[number];

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Must be sha256:<64 lowercase hex>");
/** The economics lane's domain-separated terms hash format. */
const TermsHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/, "Must be 0x<64 lowercase hex>");

export const KitArtifactRefSchema = z
  .object({
    role: z.enum(KIT_ARTIFACT_ROLES),
    /** Stable name within the kit, e.g. "opentrons-labware.json" or "tests/test_method.py". */
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(KIT_ARTIFACT_NAME_PATTERN, "Must be a safe relative path (no leading '/', no '.' or '..' segment, no backslash)"),
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
    csdUrl: z.string().regex(CSD_CAPABILITY_URL_PATTERN),
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
    /** Kernel AdapterType names (see the A4 conventions above); never "mock". */
    interfaces: z.array(Label).max(20).optional(),
    platforms: z.array(Label).max(20).optional(),
  })
  .strict();
export type KitCompatibility = z.infer<typeof KitCompatibilitySchema>;

export const KitEconomicsSchema = z
  .object({
    /**
     * License expression for the kit's own software and design artifacts.
     * Parsing keeps any string; validateKitCompleteness counts only an allowed
     * license expression (isAllowedLicenseExpression) as a license.
     */
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
    // Set-valued lists hold each value once (astra pack 112 MEDIUM 6): a duplicate
    // is refused, never silently collapsed, so two accepted manifests never share
    // a digest.
    const lists: Array<[string, readonly unknown[] | undefined]> = [
      ["compatibility.deviceFamilies", m.compatibility?.deviceFamilies],
      ["compatibility.models", m.compatibility?.models],
      ["compatibility.interfaces", m.compatibility?.interfaces],
      ["compatibility.platforms", m.compatibility?.platforms],
      ["declaredAssuranceTiers", m.declaredAssuranceTiers],
    ];
    for (const [path, list] of lists) {
      if (list && new Set(list).size !== list.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate entry in ${path}` });
      }
    }
    // Text is Unicode NFC, so NFC and NFD spellings of a name can't be two kits.
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "string") {
        if (v.normalize("NFC") !== v) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${path} must be Unicode NFC` });
        }
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k);
      }
    };
    walk(m, "");
  });
export type CapabilityKitManifestV1 = z.infer<typeof CapabilityKitManifestV1Schema>;

/** Unicode code-point order (not UTF-16 unit order), portable across languages. */
const cmp = (a: string, b: string): number => {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i]!.codePointAt(0)!;
    const y = B[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return A.length - B.length;
};
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
  /**
   * Human-readable gaps, e.g. "role:tests", "implementation", "distinct-artifacts", or
   * "license" (neither an allowed license expression nor a rights-terms hash).
   */
  missing: string[];
}

/** PCC's allow-list of SPDX license and exception ids (see isAllowedLicenseExpression). */
const SPDX_LICENSE_IDS: ReadonlySet<string> = new Set([
  "0BSD", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-2.0", "Artistic-2.0", "BSD-2-Clause", "BSD-3-Clause",
  "BSL-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "CERN-OHL-P-2.0", "CERN-OHL-S-2.0", "CERN-OHL-W-2.0",
  "EPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "ISC", "LGPL-2.1-only",
  "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "MIT", "MPL-2.0", "OFL-1.1", "PostgreSQL",
  "Python-2.0", "TAPR-OHL-1.0", "Unlicense", "Zlib",
]);
const SPDX_EXCEPTION_IDS: ReadonlySet<string> = new Set(["Classpath-exception-2.0", "GCC-exception-3.1", "LLVM-exception"]);
const lowerAll = (ids: ReadonlySet<string>): ReadonlySet<string> => new Set([...ids].map((id) => id.toLowerCase()));
const SPDX_LICENSE_KEYS = lowerAll(SPDX_LICENSE_IDS);
const SPDX_EXCEPTION_KEYS = lowerAll(SPDX_EXCEPTION_IDS);
/** SPDX ids match case-insensitively (SPDX Annex D), folded as ASCII only: no Unicode case folding. */
const spdxKey = (t: string | undefined): string | null =>
  t !== undefined && /^[A-Za-z0-9.+-]+$/.test(t) ? t.toLowerCase() : null;

/**
 * SPDX expression syntax (AND, OR, WITH, parentheses) over PCC's ALLOW-LIST of
 * SPDX license and exception ids, plus LicenseRef-<id>. Not a general SPDX
 * validator. A real SPDX id outside the list (e.g. EUPL-1.2) and DocumentRef
 * references are refused by policy. Extend the list by PR. The operators are
 * upper case; the listed ids match ASCII case-insensitively.
 */
export function isAllowedLicenseExpression(expr: string): boolean {
  const tokens = expr.match(/\(|\)|[^\s()]+/g);
  if (!tokens || tokens.length === 0) return false;
  let i = 0;
  const isLicense = (t: string | undefined) =>
    SPDX_LICENSE_KEYS.has(spdxKey(t) ?? "") || /^LicenseRef-[A-Za-z0-9.-]+$/.test(t ?? "");
  const term = (): boolean => {
    if (tokens[i] === "(") {
      i++;
      if (!expression() || tokens[i] !== ")") return false;
      i++;
      return true;
    }
    if (!isLicense(tokens[i])) return false;
    i++;
    if (tokens[i] === "WITH") {
      i++;
      if (!SPDX_EXCEPTION_KEYS.has(spdxKey(tokens[i]) ?? "")) return false;
      i++;
    }
    return true;
  };
  const expression = (): boolean => {
    if (!term()) return false;
    while (tokens[i] === "AND" || tokens[i] === "OR") {
      i++;
      if (!term()) return false;
    }
    return true;
  };
  return expression() && i === tokens.length;
}

/**
 * STRUCTURAL completeness only (astra pack 112 HIGH 2): whether a manifest has
 * the SHAPE of a reusable kit rather than a one-off listing. It needs an
 * implementation (an adapter or a method), tests, an install recipe and a
 * provenance recipe as DISTINCT artifacts, and a license: an allowed license
 * expression (isAllowedLicenseExpression) or an economics rights-terms hash.
 *
 * It is NEVER the acceptance rule for a paid kit-build bounty. Acceptance (kits
 * K2) must fetch every referenced artifact, verify each digest, run role-specific
 * checks (the tests run, the install recipe installs, the provenance recipe
 * emits what it declares) and resolve the license or rights terms.
 */
export function validateKitCompleteness(manifest: CapabilityKitManifestV1): KitCompleteness {
  const roles = new Set(manifest.artifacts.map((a) => a.role));
  const missing: string[] = [];
  if (!roles.has("adapter") && !roles.has("method")) missing.push("implementation");
  for (const r of KIT_REQUIRED_ROLES) if (!roles.has(r)) missing.push(`role:${r}`);
  const spdx = manifest.economics?.spdxLicense;
  const licensed = (spdx !== undefined && isAllowedLicenseExpression(spdx)) || Boolean(manifest.economics?.rightsTermsHash);
  if (!licensed) missing.push("license");
  // One artifact may not stand in for another required role (same bytes for the
  // implementation, the tests and a recipe is not a kit).
  const requiredGroups: KitArtifactRole[][] = [["adapter", "method"], ["tests"], ["install-recipe"], ["provenance-recipe"]];
  const owner = new Map<string, number>();
  let shared = false;
  requiredGroups.forEach((group, gi) => {
    for (const a of manifest.artifacts) {
      if (!group.includes(a.role)) continue;
      const prev = owner.get(a.digest);
      if (prev !== undefined && prev !== gi) shared = true;
      owner.set(a.digest, gi);
    }
  });
  if (shared) missing.push("distinct-artifacts");
  return { complete: missing.length === 0, missing };
}
