/**
 * Capture Verification Protocol (CVP) schema — Wave 4.
 *
 * One row per CaptureVerifier verdict (capture_verdicts) and one row per
 * on-chain anchor submission (capture_anchors). Mirrors the DDL in
 * migrations/0001_capture_verdicts.sql and 0002_capture_anchors.sql.
 *
 * Spec source: ai/supervisor/wave4-spec.md §Database Migrations.
 *
 * These are kept in drizzle so gateway routes can use the `db.insert()` /
 * `db.select()` APIs rather than raw SQL — matches the house style.
 */
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * One row per CaptureVerifier verdict. The `result_json` column holds the
 * full `CaptureVerifierResult` for UI rehydration; the flat columns are
 * for indexed query paths (by job, operator, or hash).
 */
export const captureVerdicts = sqliteTable("capture_verdicts", {
  id: text("id").primaryKey(),
  jobId: text("job_id"),
  operatorId: text("operator_id").notNull(),
  captureHash: text("capture_hash").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  /** Integer ordinal 0..5 matching the on-chain uint8 class. */
  declaredClass: integer("declared_class").notNull(),
  verifiedClass: integer("verified_class").notNull(),
  /** 'PASS' | 'PARTIAL' | 'FAIL' */
  verdict: text("verdict").notNull(),
  /** JSON number[] of passed gate ordinals (G1..G6). */
  gatesPassed: text("gates_passed", { mode: "json" })
    .notNull()
    .$type<number[]>()
    .default([]),
  /** JSON number[] of failed gate ordinals. */
  gatesFailed: text("gates_failed", { mode: "json" })
    .notNull()
    .$type<number[]>()
    .default([]),
  /** JSON string[] of verifier warnings. */
  warnings: text("warnings", { mode: "json" })
    .notNull()
    .$type<string[]>()
    .default([]),
  /** 0/1 boolean — eligibility for on-chain anchoring. */
  anchorCandidate: integer("anchor_candidate").notNull().default(0),
  /** Full CaptureVerifierResult JSON — used by /status for UI rehydration. */
  resultJson: text("result_json", { mode: "json" })
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  /** "CC0".."CC5" for display — avoids reverse-mapping in the UI. */
  declaredClassStr: text("declared_class_str").notNull(),
  verifiedClassStr: text("verified_class_str").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * One row per on-chain anchor submission to CaptureClassRegistry.
 * 1:1 with capture_verdicts.
 */
export const captureAnchors = sqliteTable("capture_anchors", {
  verdictId: text("verdict_id").primaryKey().references(() => captureVerdicts.id),
  txHash: text("tx_hash").notNull().unique(),
  blockNumber: integer("block_number").notNull(),
  /** gas-used as string (wei / uint256 don't fit in SQLite INTEGER). */
  gasUsed: text("gas_used").notNull().default("0"),
  anchoredAt: text("anchored_at").notNull(),
});
