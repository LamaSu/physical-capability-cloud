import { eq, and, inArray } from "drizzle-orm";
import { evidenceBundles, evidenceEvents, captureVerdicts } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IEvidenceBundleRepository, EvidenceTenantOpts } from "../interfaces/IEvidenceBundleRepository.js";

export class EvidenceBundleRepository implements IEvidenceBundleRepository {
  constructor(private db: StoreDB) {}

  findAll(opts?: EvidenceTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(evidenceBundles)
        .where(eq(evidenceBundles.tenantId, opts.tenantId))
        .all();
    }
    return this.db.select().from(evidenceBundles).all();
  }

  findById(id: string) {
    return this.db.select().from(evidenceBundles).where(eq(evidenceBundles.id, id)).get();
  }

  findByJob(jobId: string, opts?: EvidenceTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(evidenceBundles)
        .where(and(eq(evidenceBundles.jobId, jobId), eq(evidenceBundles.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(evidenceBundles).where(eq(evidenceBundles.jobId, jobId)).all();
  }

  findByKernel(kernelId: string, opts?: EvidenceTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(evidenceBundles)
        .where(and(eq(evidenceBundles.kernelId, kernelId), eq(evidenceBundles.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(evidenceBundles).where(eq(evidenceBundles.kernelId, kernelId)).all();
  }

  insert(bundle: typeof evidenceBundles.$inferInsert) {
    return this.db.insert(evidenceBundles).values(bundle).returning().get();
  }

  findByHash(bundleHash: string) {
    // Normalize to bare lowercase 64-hex, then match every stored form.
    // Producers commit hashes as `sha256:<hex>` (gateway synth, spec sha256())
    // while on-chain/oracle callers pass `0x<hex>` — the digest is the key.
    let hex = bundleHash.trim();
    if (hex.startsWith("sha256:")) hex = hex.slice("sha256:".length);
    else if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
    hex = hex.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) return undefined;
    const candidates = [`sha256:${hex}`, `0x${hex}`, hex];
    return this.db
      .select()
      .from(evidenceBundles)
      .where(inArray(evidenceBundles.bundleHash, candidates))
      .get();
  }

  // ── Events ──────────────────────────────────────────────────────

  findEventsByBundle(bundleId: string) {
    return this.db.select().from(evidenceEvents).where(eq(evidenceEvents.bundleId, bundleId)).all();
  }

  insertEvent(event: typeof evidenceEvents.$inferInsert) {
    return this.db.insert(evidenceEvents).values(event).returning().get();
  }

  insertEvents(events: (typeof evidenceEvents.$inferInsert)[]) {
    if (events.length === 0) return [];
    return this.db.insert(evidenceEvents).values(events).returning().all();
  }

  // ── Capture verdicts (CVP cross-facade wiring) ───────────────────
  //
  // Exposes the Wave 4 `capture_verdicts` table through the evidence repo so
  // ComplianceFacade can tighten ALCOA+ flags when capture verification has
  // run for a job. See ai/research/cvp-alcoa-integration.md for the wiring
  // sketch; there is intentionally NO join between evidence_bundles and
  // capture_verdicts (a job can have verdicts without evidence bundles and
  // vice versa — the only link is jobId).

  findCaptureVerdictsByJob(jobId: string) {
    return this.db
      .select()
      .from(captureVerdicts)
      .where(eq(captureVerdicts.jobId, jobId))
      .all();
  }
}
