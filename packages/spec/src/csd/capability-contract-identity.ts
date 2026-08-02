/**
 * M1 — canonical capability-CONTRACT identity (composable-capability substrate,
 * design doc §5 "resolve capability identity first; blocks D2").
 *
 * DISTINCT from `@pcc/spec`'s `identity/` module, which is W3C DID / Verifiable
 * Credential / ERC-8004 *entity* identity (WHO an agent or operator is). This is
 * *contract* identity: WHICH capability contract revision a reference denotes.
 * Also distinct from the job-terms-source role (what a job costs/pays).
 *
 * PCC identifies a capability four incompatible ways today — a vestigial closed
 * 16-value enum, the live open `CapabilityType` string union, free-form DB
 * `type` strings, and CSD `url` slugs — with only lossy, one-directional
 * helpers (`findUrlByType`, `csdRegisteredTypes`, `getApiCapabilityTypes`) to
 * cross them. This module is the single canonical resolver those consolidate
 * behind.
 *
 * THE LOAD-BEARING FIX (Sol review Q1 + verified in registry.ts): a CSD `url`
 * is a MUTABLE pointer — `CsdRegistry.register()` is `this.csds.set(url, data)`
 * with silent overwrite, no version-pin or content guard — so
 * `pcc://capabilities/fdm/v2` can change meaning across POSTs. A url therefore
 * cannot be content identity. Canonical identity is a THREE-part value:
 *   - `capabilityClass`      — coarse discovery/filter slug (NOT identity)
 *   - `capabilityContractId` — the versioned CSD url (a logical, MUTABLE ref)
 *   - `capabilityContractDigest` — SHA-256 of the canonicalized RESOLVED CSD:
 *       the IMMUTABLE identity that pins the exact revision even if the url is
 *       later overwritten. This is what a downstream (a D2 snapshot, a compiled
 *       plan, an escrow root) must bind — never the bare url.
 *
 * Deliberately STRICTER than `findUrlByType`: identity resolution matches only
 * the exact url or the url class-slug and FAILS CLOSED on an unresolvable or
 * ambiguous reference — never the fuzzy name/first-match that is fine for usage
 * attribution but unsound for identity.
 *
 * Pure + offline: reads the registry, canonicalizes, hashes. Contacts nothing.
 */

import type { CSD } from "./schema.js";
import type { CsdRegistry } from "./registry.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import type { SHA256 } from "../types/common.js";

/** CSD capability url shape: `pcc://capabilities/<class>/<version>`. */
const CAPABILITY_URL_RE = /^pcc:\/\/capabilities\/([^/]+)\/([^/]+)$/i;

export interface CapabilityContractIdentity {
  /** Coarse discovery/filter classification — the url class-slug (e.g. "fdm").
   * NOT identity: many revisions and versions share one class. */
  readonly capabilityClass: string;
  /** The versioned CSD url (e.g. "pcc://capabilities/fdm/v2"). A logical
   * reference — but a MUTABLE pointer, so not sufficient as identity alone. */
  readonly capabilityContractId: string;
  /** SHA-256 of the canonicalized RESOLVED CSD (baseDefinition inheritance
   * applied). The IMMUTABLE identity — bind THIS downstream, not the url. */
  readonly capabilityContractDigest: SHA256;
}

/** Thrown on any unresolvable / ambiguous / malformed capability reference.
 * Identity resolution is fail-closed: it never silently picks a winner. */
export class CapabilityContractIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityContractIdentityError";
  }
}

/** Extract the class-slug from a capability url; throws if the url is not the
 * canonical `pcc://capabilities/<class>/<version>` shape. */
export function capabilityClassOf(url: string): string {
  const m = url.match(CAPABILITY_URL_RE);
  if (!m) {
    throw new CapabilityContractIdentityError(
      `UNRECOGNIZED_CONTRACT_URL: "${url}" is not pcc://capabilities/<class>/<version>`,
    );
  }
  return m[1]!.toLowerCase();
}

/**
 * The immutable content digest of a RESOLVED CSD (inheritance already applied).
 * Uses the shared canonicalizer (lexicographically sorted keys at all depths)
 * so key-insertion order never affects the digest.
 *
 * NOTE (v2 refinement, Sol Q7 "version compatibility"): this digests the WHOLE
 * resolved document, including lifecycle fields (`status`, `version`). A future
 * revision should separate the semantic *contract* (params/constraints/
 * invariants/ports/effects/pricing) from volatile lifecycle so a status flip
 * does not change identity. For now, whole-document is the sound, simple choice
 * and fully achieves the anti-mutable-url goal (any content change ⇒ new digest).
 */
export async function computeContractDigest(resolved: CSD): Promise<SHA256> {
  return sha256(canonicalize(resolved));
}

/**
 * Resolve any capability reference — a full CSD url, or a bare class/type
 * string — to exactly ONE registered contract url, or throw. Fail-closed:
 *   - a full `pcc://capabilities/.../...` url must be registered;
 *   - a bare class matching exactly one contract resolves to it;
 *   - a bare class matching several revisions resolves ONLY if exactly one is
 *     `status:"active"`, else AMBIGUOUS.
 * Never falls back to fuzzy name matching (unsound for identity).
 */
export function resolveContractId(reference: string, registry: CsdRegistry): string {
  if (CAPABILITY_URL_RE.test(reference)) {
    if (!registry.get(reference)) {
      throw new CapabilityContractIdentityError(`UNKNOWN_CONTRACT_URL: "${reference}" is not registered`);
    }
    return reference;
  }

  const lower = reference.toLowerCase();
  const matches = registry.list().filter((c) => {
    const m = c.url.match(CAPABILITY_URL_RE);
    return m !== null && m[1]!.toLowerCase() === lower;
  });

  if (matches.length === 0) {
    throw new CapabilityContractIdentityError(
      `UNRESOLVED_CAPABILITY: no registered contract for "${reference}" — pass a full pcc://capabilities/<class>/<version> url, or register one`,
    );
  }
  if (matches.length === 1) return matches[0]!.url;

  const active = matches.filter((c) => c.status === "active");
  if (active.length === 1) return active[0]!.url;
  throw new CapabilityContractIdentityError(
    `AMBIGUOUS_CAPABILITY: "${reference}" matches ${matches.length} contracts [${matches
      .map((c) => c.url)
      .join(", ")}] with ${active.length} active — specify a full versioned url`,
  );
}

/**
 * Resolve a capability reference to its canonical, digest-bound identity.
 * Applies baseDefinition inheritance (via `registry.resolve`) before hashing,
 * so the digest reflects the fully-resolved contract. Throws
 * `CapabilityContractIdentityError` on an unresolvable/ambiguous reference and
 * rethrows a registry resolution failure (e.g. a broken baseDefinition chain).
 */
export async function resolveCapabilityContractIdentity(
  reference: string,
  registry: CsdRegistry,
): Promise<CapabilityContractIdentity> {
  const capabilityContractId = resolveContractId(reference, registry);
  const resolved = registry.resolve(capabilityContractId);
  const capabilityContractDigest = await computeContractDigest(resolved);
  return {
    capabilityClass: capabilityClassOf(capabilityContractId),
    capabilityContractId,
    capabilityContractDigest,
  };
}
