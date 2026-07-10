import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";
import { jobs } from "./jobs.js";

/** A collection of evidence events for one job step */
export const evidenceBundles = sqliteTable("evidence_bundles", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id),
  stepId: text("step_id").notNull(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  assuranceTier: integer("assurance_tier").notNull(),
  bundleHash: text("bundle_hash").notNull(),
  kernelSignature: text("kernel_signature", { mode: "json" }).notNull().$type<{
    signer: string;
    algorithm: string;
    value: string;
  }>(),
  /** Wave 4.1.x — tenant scoping. Nullable; backfilled at write time from
   *  the buyer/operator on the parent job. Routes pass `tenantOpts(req)`. */
  tenantId: text("tenant_id"),
  createdAt: text("created_at").notNull(),
});

/** A single evidence event — one signal from one source */
export const evidenceEvents = sqliteTable("evidence_events", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id),
  type: text("type").notNull(), // EvidenceEventType
  timestamp: text("timestamp").notNull(),
  source: text("source", { mode: "json" }).notNull().$type<{
    deviceId: string;
    deviceType: string;
    kernelId: string;
    firmwareVersion?: string;
    /** Fabricated-by-design marker (mock/simulated adapter paths) — see
     *  @pcc/spec EvidenceSource.simulated. JSON mode round-trips the whole
     *  object so the flag already persists; this annotation keeps the
     *  column TYPE honest about it. */
    simulated?: boolean;
  }>(),
  payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  hash: text("hash").notNull(),
});
