import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * T2.7 — Operator ratings.
 *
 * One row per buyer rating of an operator after a completed job. The buyer
 * link via `jobId` lets us enforce the buyer-only check at the route layer
 * (rate limited to the buyer of that job). `operatorId` is the public
 * operator slug (machineRegistrations.id), not a wallet, so the public GET
 * stays sanitised.
 */
export const operatorRatings = sqliteTable("operator_ratings", {
  id: text("id").primaryKey(),
  operatorId: text("operator_id").notNull(),
  jobId: text("job_id").notNull(),
  buyerId: text("buyer_id").notNull(),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: text("created_at").notNull(),
});
