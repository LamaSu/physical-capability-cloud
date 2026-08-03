/**
 * D2 — the pure, deterministic, offline projection
 *   CsdRegistry  ──▶  prism `CapabilityContractRegistrySnapshot`  (+ its digest)
 *
 * so the live gateway decomposer's DAG can later be compiled + settled against a
 * signed, reproducible capability-contract registry artifact. No network, no
 * chain, no `Date.now`/`Math.random` — mirrors the compiler's posture (design
 * doc §5; escrow root-shape answer coord #545).
 *
 * Doctrine (M1): a snapshot binds the RESOLVED capability contract, never a bare
 * mutable url. This adapter:
 *   - iterates ACTIVE CSDs; keys the snapshot by `capabilityClass` (M1's
 *     discovery slug, e.g. "fdm") — the `capabilityType` a plan node references,
 *     one active revision per class;
 *   - projects each CSD's `composition` block (the seam ABI mirror,
 *     `composition.ts`) VERBATIM into a `CapabilityContract`;
 *   - OMITS capabilities with no `composition` block (the migration story);
 *   - FAILS CLOSED — never invents a port/effect/guarantee/param from marketing
 *     metadata: a present-but-partial block throws `D2_LOSSY_COMPOSITION_MAPPING`
 *     naming the field; two active revisions of one class throw
 *     `D2_DUPLICATE_CAPABILITY_CLASS`.
 *
 * The content-addressed `computeRegistrySnapshotDigest` MUST agree byte-for-byte
 * with what prism commits as `registryDigest` (via ITS `canonicalHash`) for the
 * identical snapshot — see the golden cross-check in
 * `registry-contract-adapter.test.ts`.
 */

import type { CsdRegistry } from "./registry.js";
import { resolveCapabilityContractIdentity } from "./capability-contract-identity.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import type { SHA256 } from "../types/common.js";
import {
  CapabilityContractRegistrySnapshotSchema,
  type CapabilityContract,
  type CapabilityContractRegistrySnapshot,
  type CompositionBlock,
} from "./composition.js";

/**
 * Default `registryVersion` label when the caller omits one. A human/provenance
 * LABEL only — the digest is over the WHOLE snapshot content, so any contract
 * change is caught regardless of this label. Production callers SHOULD pass an
 * explicit version (e.g. a semver or a build tag) via `opts.registryVersion`.
 */
export const DEFAULT_REGISTRY_VERSION = "pcc-csd-registry-v1";

export type D2AdapterErrorCode = "D2_LOSSY_COMPOSITION_MAPPING" | "D2_DUPLICATE_CAPABILITY_CLASS";

/** Thrown when a composition block cannot be projected losslessly, or two active
 * revisions collide on one class. Fail-closed: the adapter never invents a
 * missing contract field, and never silently drops a colliding class. */
export class D2AdapterError extends Error {
  readonly code: D2AdapterErrorCode;
  constructor(code: D2AdapterErrorCode, message: string) {
    super(message);
    this.name = "D2AdapterError";
    this.code = code;
  }
}

/** The seven CapabilityContract port/effect/precondition/param fields a
 * composition block must fully populate (the block carries these; the adapter
 * adds `capabilityType`/`version`). Order sets which missing field is named
 * first by fail-on-lossy — any is a hard error. */
const REQUIRED_CONTRACT_FIELDS = [
  "inputPorts",
  "outputPorts",
  "allowedEffectSignatures",
  "allowedPreconditionSignatures",
  "requiredPreconditions",
  "parameters",
  "requiredEffects",
] as const;

function mapCompositionToContract(
  capabilityType: string,
  version: string,
  composition: CompositionBlock,
  url: string,
): CapabilityContract {
  for (const field of REQUIRED_CONTRACT_FIELDS) {
    if (composition[field] === undefined) {
      throw new D2AdapterError(
        "D2_LOSSY_COMPOSITION_MAPPING",
        `capability "${capabilityType}" ("${url}") declares a composition block but is missing ` +
          `required contract field "${field}" — refusing to invent it`,
      );
    }
  }
  // Every field is present (checked above); map 1:1 into the contract. The
  // non-null assertions are sound post-check and re-verified by the snapshot
  // parse in buildContractRegistrySnapshot.
  return {
    capabilityType,
    version,
    inputPorts: composition.inputPorts!,
    outputPorts: composition.outputPorts!,
    allowedEffectSignatures: composition.allowedEffectSignatures!,
    allowedPreconditionSignatures: composition.allowedPreconditionSignatures!,
    requiredPreconditions: composition.requiredPreconditions!,
    parameters: composition.parameters!,
    requiredEffects: composition.requiredEffects!,
  };
}

/**
 * Project a `CsdRegistry` into the prism compiler's
 * `CapabilityContractRegistrySnapshot`.
 *
 * ASYNC because the spec binds identity via M1's `resolveCapabilityContractIdentity`
 * (WebCrypto's `subtle.digest` is async); consistent with the async
 * `computeRegistrySnapshotDigest`. Pure + offline — deterministic output for
 * identical registry content, insertion-order-independent (the snapshot is keyed
 * by class and canonicalized with sorted keys downstream).
 */
export async function buildContractRegistrySnapshot(
  registry: CsdRegistry,
  opts?: { registryVersion?: string },
): Promise<CapabilityContractRegistrySnapshot> {
  const registryVersion = opts?.registryVersion ?? DEFAULT_REGISTRY_VERSION;
  const contracts: Record<string, CapabilityContract> = {};
  const seenClass = new Map<string, string>();

  for (const csd of registry.list()) {
    if (csd.status !== "active") continue; // only active revisions enter a snapshot
    const resolved = registry.resolve(csd.url); // apply baseDefinition inheritance
    const composition = resolved.composition;
    if (composition === undefined) continue; // no composition block → omit (migration)

    // M1 fail-closed identity: binds the resolved contract, gives the discovery
    // class that becomes the compiler's `capabilityType` (what a plan references).
    const identity = await resolveCapabilityContractIdentity(csd.url, registry);
    const capabilityClass = identity.capabilityClass;

    if (seenClass.has(capabilityClass)) {
      throw new D2AdapterError(
        "D2_DUPLICATE_CAPABILITY_CLASS",
        `two active composable CSDs map to capability class "${capabilityClass}": ` +
          `"${seenClass.get(capabilityClass)}" and "${csd.url}" — a snapshot binds exactly one ` +
          `active revision per class`,
      );
    }
    seenClass.set(capabilityClass, csd.url);

    contracts[capabilityClass] = mapCompositionToContract(
      capabilityClass,
      resolved.version,
      composition,
      csd.url,
    );
  }

  const snapshot = { registryVersion, contracts };

  // Final fail-closed gate: the projection MUST satisfy the prism seam ABI. Any
  // residual invalidity (schema drift, an inherited-contract conflict that
  // survived mapping) throws here naming the field — never a malformed snapshot.
  const parsed = CapabilityContractRegistrySnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    throw new D2AdapterError(
      "D2_LOSSY_COMPOSITION_MAPPING",
      `projected snapshot is not a valid CapabilityContractRegistrySnapshot at ` +
        `"${first?.path.join(".") ?? "<root>"}": ${first?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

/**
 * Content-addressed digest of a snapshot: `sha256(canonicalize(snapshot))` using
 * @pcc/spec's shared canonicalizer (sorted keys, no whitespace, undefined-key
 * omission, non-finite rejected upstream by the strict Quantity schema).
 *
 * ⚠ SERIALIZATION-MATCH: the CANONICAL BYTES equal what prism's `canonicalize`
 * (`src/hash.ts`) produces for the byte-identical snapshot (verified line-by-line
 * and pinned in the golden test), so the underlying SHA-256 is identical to what
 * prism commits as `registryDigest`. The ONE representational difference: this
 * returns the `SHA256` type (`sha256:<hex>`, the @pcc/spec + M1 convention) while
 * prism's `registryDigest: Hex32` is bare `<hex>` — a documented, lossless prefix,
 * NOT a hash divergence. Strip the `sha256:` prefix to compare against prism's
 * bare form (the escrow-wiring increment does this at the comparison boundary).
 */
export async function computeRegistrySnapshotDigest(
  snapshot: CapabilityContractRegistrySnapshot,
): Promise<SHA256> {
  return sha256(canonicalize(snapshot));
}
