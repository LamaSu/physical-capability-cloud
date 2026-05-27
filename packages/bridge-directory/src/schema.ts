/**
 * Zod schemas mirroring the JSON Schema in spec §6 of
 *   ai/research/bridge-directory-schema-2026-05-26.md
 *
 * These are the runtime contract for `bridges.json`. CI validates the file
 * against `BridgeDirectorySchema` on every commit (see __tests__).
 */

import { z } from "zod";

/** Namespace: lowercase alphanum + hyphen, max 31 chars (fits bytes32 +
 * null terminator).
 * Pattern from research doc §4. */
const NamespacePattern = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** EVM address with 0x prefix and 40 lowercase OR uppercase hex chars.
 * We normalize maintainerAddress to lowercase at validation time. */
const HexAddressPattern = /^0x[a-fA-F0-9]{40}$/;

/** semver — supports core + pre-release suffix (no build metadata). */
const SemverPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** npm package name OR scoped name (@scope/name) OR python distribution
 * name. We're permissive within ASCII identifier territory. */
const PackageNamePattern = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;

/** ENS subdomain, e.g. lamasu.eth, ops.lamasu.eth. */
const EnsNamePattern = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Reverse-DNS-style extension key, e.g. "com.lamasu.foo". */
const ExtensionKeyPattern = /^[a-z]+(\.[a-z][a-z0-9-]*)+$/;

/** chainId map key in JSON is a string of digits ("8453"). */
const ChainIdKeyPattern = /^[0-9]+$/;

// ---- Field-level schemas ----

export const BridgeStatusSchema = z.enum([
  "experimental",
  "active",
  "deprecated",
  "removed",
]);

export const BridgeSLASchema = z
  .object({
    uptime: z.number().min(0).max(100).optional(),
    responseMs: z.number().int().min(0).optional(),
    contact: z.string().max(200).optional(),
  })
  .strict();

/** registries comes in as { "8453": "0x...", "84532": "0x..." } in JSON.
 * We coerce keys to numbers in `parseRegistries` for the runtime type. */
export const RegistriesJsonSchema = z
  .record(z.string().regex(ChainIdKeyPattern), z.string().regex(HexAddressPattern))
  .refine(
    (obj) =>
      Object.entries(obj).every(([k]) => Number.isFinite(Number(k))),
    { message: "registries keys must be parseable as chainId integers" },
  );

/** extensions: free-form, but keys must be reverse-DNS-ish; values can be
 * any JSON-serializable primitive or nested object. */
export const ExtensionsSchema = z
  .record(z.string().regex(ExtensionKeyPattern), z.unknown())
  .refine(
    (obj) => Object.keys(obj).length <= 10,
    { message: "extensions may have at most 10 keys" },
  );

// ---- BridgeEntry ----

export const BridgeEntrySchema = z
  .object({
    namespace: z.string().regex(NamespacePattern),
    name: z.string().min(1).max(60),
    repoUrl: z.string().url().max(200),
    maintainerAddress: z
      .string()
      .regex(HexAddressPattern)
      .transform((s) => s.toLowerCase() as `0x${string}`),
    adapterPackage: z.string().regex(PackageNamePattern).max(64),
    version: z.string().regex(SemverPattern),
    status: BridgeStatusSchema,

    // optional
    trustTier: z.number().int().min(0).max(3).optional(),
    registries: RegistriesJsonSchema.optional(),
    configSchemaURI: z.string().url().max(200).optional(),
    sla: BridgeSLASchema.optional(),
    maintainerENS: z.string().regex(EnsNamePattern).max(64).optional(),
    capabilityTypes: z
      .array(z.string().max(40))
      .max(20)
      .optional(),
    description: z.string().max(200).optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .strict();

// ---- Directory envelope ----

export const BridgeDirectoryVersionSchema = z
  .object({
    major: z.number().int().min(0),
    minor: z.number().int().min(0),
    patch: z.number().int().min(0),
  })
  .strict();

export const BridgeDirectorySchema = z
  .object({
    name: z.string().min(1).max(60),
    timestamp: z.string().datetime({ offset: true }),
    version: BridgeDirectoryVersionSchema,
    bridges: z.array(BridgeEntrySchema).max(500),
  })
  .strict();

// ---- Helpers ----

/** Convert string-keyed registries from JSON into a number-keyed runtime map. */
export function parseRegistries(
  raw: Record<string, string> | undefined,
): Record<number, `0x${string}`> | undefined {
  if (!raw) return undefined;
  const out: Record<number, `0x${string}`> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[Number(k)] = v.toLowerCase() as `0x${string}`;
  }
  return out;
}
