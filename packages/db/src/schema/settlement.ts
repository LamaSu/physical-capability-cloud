import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** An escrow contract instance for a workflow */
export const escrows = sqliteTable("escrows", {
  id: text("id").primaryKey(),
  cwmId: text("cwm_id").notNull(),
  contractAddress: text("contract_address").notNull(),
  payer: text("payer").notNull(),
  totalAmount: text("total_amount").notNull(),
  currency: text("currency").notNull(), // "USDC" | "ETH" | "DAI"
  status: text("status").notNull(), // "created" | "funded" | "active" | "completing" | "completed" | "disputed" | "refunded"
  createdAt: text("created_at").notNull(),
  deadline: text("deadline").notNull(),
  /**
   * Which escrow contract version was used at createEscrow* time. Determines
   * the dispatch target at submitAttestation/release (V2 uses submitAttestationV2
   * + releaseMilestoneV2; V3 uses submitAttestationV3 + releaseMilestoneV3).
   * Defaults to "v2" for existing rows (they were created via V2 factory before
   * this column existed). New V3-created rows explicitly set "v3".
   */
  version: text("version").default("v2"),
});

/** A milestone in the escrow — corresponds to one CWM step */
export const escrowMilestones = sqliteTable("escrow_milestones", {
  id: text("id").primaryKey(),
  escrowId: text("escrow_id").notNull().references(() => escrows.id),
  stepId: text("step_id").notNull(),
  amount: text("amount").notNull(),
  status: text("status").notNull(), // EscrowStatus
  evidenceBundleHash: text("evidence_bundle_hash"),
  verifierAttestationHash: text("verifier_attestation_hash"),
  challengeWindowStart: text("challenge_window_start"),
  challengeWindowEnd: text("challenge_window_end"),
  bondAmount: text("bond_amount").notNull(),
});

/** A dispute filed against a milestone */
export const disputes = sqliteTable("disputes", {
  id: text("id").primaryKey(),
  escrowId: text("escrow_id").notNull().references(() => escrows.id),
  milestoneStepId: text("milestone_step_id").notNull(),
  challenger: text("challenger").notNull(),
  challengerBond: text("challenger_bond").notNull(),
  reason: text("reason").notNull(),
  challengerEvidenceHash: text("challenger_evidence_hash"),
  status: text("status").notNull(), // "filed" | "under_review" | "resolved_for_challenger" | "resolved_for_operator" | "dismissed"
  arbiters: text("arbiters", { mode: "json" }).$type<string[]>(),
  resolution: text("resolution", { mode: "json" }).$type<{
    decidedBy: string;
    decision: string;
    reasoning: string;
    refundAmount?: string;
    slashedAmount?: string;
    challengerSlashed?: string;
    timestamp: string;
  }>(),
  filedAt: text("filed_at").notNull(),
});
