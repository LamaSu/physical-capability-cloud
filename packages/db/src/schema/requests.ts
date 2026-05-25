import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import type { CapabilityNode } from "@pcc/spec";

/**
 * Capability Request — high-level request that gets decomposed into a
 * capability DAG. Persists what was previously the in-memory requestsStore in
 * the gateway. compositionSignature is indexed so the demand-intel aggregator
 * can fold many envelopes that share the same composition shape efficiently.
 */
export const capabilityRequests = sqliteTable(
  "capability_requests",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    requesterEmail: text("requester_email"),
    requesterWallet: text("requester_wallet"),
    budget: integer("budget").notNull(),
    currency: text("currency").notNull().default("USDC"),
    deadline: text("deadline").notNull(),
    urgency: text("urgency").notNull(), // "standard" | "rush" | "emergency"
    status: text("status").notNull(), // RequestStatus
    capabilityDag: text("capability_dag", { mode: "json" }).notNull().$type<CapabilityNode[]>(),
    totalEstimatedCost: integer("total_estimated_cost").notNull().default(0),
    totalEstimatedHours: integer("total_estimated_hours").notNull().default(0),
    /** 0x + 64 hex chars — sha256 of sorted capabilityTypes + sorted dependency edges */
    compositionSignature: text("composition_signature"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    bySig: index("requests_composition_sig_idx").on(t.compositionSignature),
    byStatus: index("requests_status_idx").on(t.status),
    byUrgency: index("requests_urgency_idx").on(t.urgency),
    byCreated: index("requests_created_at_idx").on(t.createdAt),
  }),
);
