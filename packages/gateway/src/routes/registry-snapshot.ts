/**
 * Registry-snapshot routes — the D2 compiler ABI, served for public read with
 * historical retrievability.
 *
 *   GET /api/compose/registry-snapshot                    — compute + serve the current snapshot
 *   GET /api/compose/registry-snapshot/:registryDigest    — fetch a previously-served snapshot by digest
 *
 * The snapshot is the inc-1 artifact: `buildContractRegistrySnapshot` projects the
 * live CSD registry (the SAME registry `/api/csd/*` serves — see getCsdRegistry)
 * into a `CapabilityContractRegistrySnapshot`, and `computeRegistrySnapshotDigest`
 * content-addresses it as `registryDigest` (`sha256:<hex>` = sha256(canonicalize)).
 *
 * DETERMINISM: identical captured CSD state → identical `snapshot` + `registryDigest`.
 * All observational metadata (generatedAt / served-by) is carried in HTTP HEADERS
 * (or the outer response envelope) and NEVER inside `snapshot` — `snapshot` is the
 * hashed artifact, so anything mutable inside it would break the digest.
 *
 * NOT A SETTLEMENT PROOF: `registryDigest` is a CONTENT COMMITMENT (integrity +
 * retrievability of the compiler ABI). It asserts nothing about on-chain escrow,
 * funding, or verification — it is not a settlement/on-chain proof. Provenance
 * signing is deliberately out of scope (content-addressing supplies integrity).
 *
 * PUBLIC READ: this is the compiler ABI; both routes are unauthenticated reads
 * (allowlisted in middleware/api-gate.ts). No mutation surface is exposed.
 */

import type { FastifyInstance } from "fastify";
import {
  buildContractRegistrySnapshot,
  computeRegistrySnapshotDigest,
  canonicalize,
  D2AdapterError,
  type CsdRegistry,
  type CapabilityContractRegistrySnapshot,
} from "@pcc/spec";
import { getCsdRegistry } from "./csd.js";
import {
  getRegistrySnapshotStore,
  isValidRegistryDigest,
  RegistrySnapshotCollisionError,
} from "../services/registry-snapshot-store.js";

/** The response envelope for both routes. `snapshot` is the hashed artifact; the
 * two sibling fields mirror provenance labels in the OUTER envelope (never inside
 * `snapshot`). */
interface RegistrySnapshotEnvelope {
  registryVersion: string;
  snapshot: CapabilityContractRegistrySnapshot;
  registryDigest: string;
}

const MAX_CAPTURE_ATTEMPTS = 3;

/**
 * A synchronous point-in-time fingerprint of the WHOLE registry (every CSD's
 * url + version + status, sorted). Any register/retire changes it. Computed with
 * no `await` inside, so it captures an atomic view within one event-loop tick.
 */
function revisionToken(registry: CsdRegistry): string {
  return registry
    .list()
    .map((c) => `${c.url}@${c.version}:${c.status}`)
    .sort()
    .join("|");
}

/**
 * Capture the snapshot from ONE consistent revision of the CSD store.
 *
 * `buildContractRegistrySnapshot` is async (it awaits per-CSD identity
 * resolution), so a concurrent HTTP register/retire could mutate the in-memory
 * registry mid-build. We bracket the build with a before/after revision check
 * and retry on mismatch (bounded) — we never project a mid-mutation registry.
 * Only active/published CSDs enter the snapshot (the adapter already excludes
 * drafts, retired, and composition-less CSDs).
 */
async function captureConsistentSnapshot(
  registry: CsdRegistry,
): Promise<CapabilityContractRegistrySnapshot> {
  for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt++) {
    const before = revisionToken(registry);
    const snapshot = await buildContractRegistrySnapshot(registry);
    const after = revisionToken(registry);
    if (before === after) return snapshot;
    // registry mutated during the build — retry against the settled state
  }
  const err = new Error(
    "registry snapshot could not be captured atomically — the CSD registry is " +
      "mutating under load; retry shortly",
  );
  (err as Error & { statusCode?: number }).statusCode = 503;
  throw err;
}

export async function registrySnapshotRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/compose/registry-snapshot ──────────────────────────────
  // Compute the current snapshot from the live CSD registry, persist it
  // write-once by digest, and serve it. Static path — Fastify's router
  // prefers it over the parametric `/api/compose/:id` regardless of order.
  app.get("/api/compose/registry-snapshot", async (_req, reply) => {
    const registry = getCsdRegistry();

    let snapshot: CapabilityContractRegistrySnapshot;
    try {
      snapshot = await captureConsistentSnapshot(registry);
    } catch (err) {
      if (err instanceof D2AdapterError) {
        // The registry cannot be projected losslessly (partial composition block
        // or two active revisions of one class). Deterministic registry-state
        // conflict — surface the fail-closed reason, do not serve a partial ABI.
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({
        error: status === 503 ? "registry_unstable" : "snapshot_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Canonical bytes = the exact digest preimage (inc-1 canonicalize); the digest
    // is sha256 of those same bytes. Persist the exact bytes under the digest.
    const canonical = canonicalize(snapshot);
    const registryDigest = await computeRegistrySnapshotDigest(snapshot);
    const bytes = new TextEncoder().encode(canonical);

    try {
      await getRegistrySnapshotStore().put(registryDigest, bytes);
    } catch (err) {
      if (err instanceof RegistrySnapshotCollisionError) {
        // A stored digest whose bytes differ from the freshly-computed bytes is
        // an integrity fault (a deterministic snapshot can't legitimately do
        // this) — never overwrite; report it rather than serving over it.
        return reply.code(500).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    // Observational metadata → headers only (never inside `snapshot`).
    reply.header("ETag", `"${registryDigest}"`); // strong, quoted; value IS the digest
    reply.header("X-PCC-Registry-Snapshot-Generated-At", new Date().toISOString());
    reply.header("X-PCC-Served-By", "pcc-gateway");

    const body: RegistrySnapshotEnvelope = {
      registryVersion: snapshot.registryVersion,
      snapshot,
      registryDigest,
    };
    return reply.send(body);
  });

  // ── GET /api/compose/registry-snapshot/:registryDigest ──────────────
  // Return the exact stored artifact for a digest (an already-funded job's ABI
  // is always recoverable). 404 when the digest was never served/stored.
  app.get<{ Params: { registryDigest: string } }>(
    "/api/compose/registry-snapshot/:registryDigest",
    async (req, reply) => {
      const registryDigest = decodeURIComponent(req.params.registryDigest);
      if (!isValidRegistryDigest(registryDigest)) {
        return reply.code(400).send({
          error: "invalid_registry_digest",
          message: `"${registryDigest}" is not a valid registryDigest (expected sha256:<64 hex>)`,
        });
      }

      const bytes = await getRegistrySnapshotStore().get(registryDigest);
      if (!bytes) {
        return reply.code(404).send({
          error: "not_found",
          message: `No stored registry snapshot for digest ${registryDigest}`,
        });
      }

      // The stored bytes are the canonical snapshot JSON — parse back to the
      // artifact. `snapshot`'s recomputed digest equals the requested digest
      // (canonicalization is key-order independent).
      const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as CapabilityContractRegistrySnapshot;

      reply.header("ETag", `"${registryDigest}"`);
      reply.header("X-PCC-Served-By", "pcc-gateway");

      const body: RegistrySnapshotEnvelope = {
        registryVersion: snapshot.registryVersion,
        snapshot,
        registryDigest,
      };
      return reply.send(body);
    },
  );
}
