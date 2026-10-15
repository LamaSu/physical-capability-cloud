import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Durable gateway attestation of one accepted settlement package per job. */
export const gatewayReceipts = sqliteTable(
  "gateway_receipts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    kernelId: text("kernel_id").notNull(),
    chainId: integer("chain_id").notNull(),
    escrow: text("escrow").notNull(),
    settlementUnitId: text("settlement_unit_id").notNull(),
    packageDigest: text("package_digest").notNull(),
    receivedAt: integer("received_at").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    signatureHex: text("signature_hex").notNull(),
    kid: text("kid").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    byJob: uniqueIndex("gateway_receipts_job_idx").on(t.jobId),
    byUnit: uniqueIndex("gateway_receipts_unit_idx").on(t.chainId, t.escrow, t.settlementUnitId),
  }),
);

/** Issued challenges persist across gateway restarts and can be consumed once. */
export const settlementChallenges = sqliteTable(
  "settlement_challenges",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    chainId: integer("chain_id").notNull(),
    escrow: text("escrow").notNull(),
    settlementUnitId: text("settlement_unit_id").notNull(),
    nonce: text("nonce").notNull(),
    tChallengeRef: text("t_challenge_ref").notNull(),
    state: text("state", { enum: ["issued", "consumed"] }).notNull(),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
  },
  (t) => ({
    stateValues: check("settlement_challenges_state_check", sql`${t.state} IN ('issued', 'consumed')`),
    openUnit: uniqueIndex("settlement_challenges_open_unit_idx")
      .on(t.chainId, t.escrow, t.settlementUnitId)
      .where(sql`${t.state} = 'issued'`),
  }),
);
