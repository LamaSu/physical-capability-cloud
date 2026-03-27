import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";

/** Operator policy — one row per kernel */
export const operatorPolicies = sqliteTable("operator_policies", {
  kernelId: text("kernel_id").primaryKey().references(() => shopKernels.id),
  policy: text("policy", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

/** Pending job approvals — jobs awaiting operator decision */
export const pendingApprovals = sqliteTable("pending_approvals", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  jobId: text("job_id").notNull(),
  sessionId: text("session_id"),
  submittedBy: text("submitted_by").notNull(),
  jobSummary: text("job_summary", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
  rejectionReason: text("rejection_reason"),
  expiresAt: text("expires_at").notNull(),
});

/** Negotiation sessions — pre-lock-in protocol state */
export const negotiationSessions = sqliteTable("negotiation_sessions", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("created"),
  userAgentId: text("user_agent_id").notNull(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  capabilityType: text("capability_type").notNull(),
  capabilityId: text("capability_id"),
  network: text("network"),
  selections: text("selections", { mode: "json" }).notNull().default({}).$type<Record<string, unknown>>(),
  operatorConstraints: text("operator_constraints", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  scheduling: text("scheduling", { mode: "json" }).$type<Record<string, unknown>>(),
  quote: text("quote", { mode: "json" }).$type<Record<string, unknown>>(),
  contractTerms: text("contract_terms", { mode: "json" }).$type<Record<string, unknown>>(),
  jobId: text("job_id"),
  escrowAddress: text("escrow_address"),
  cwmId: text("cwm_id"),
  transitions: text("transitions", { mode: "json" }).notNull().default([]).$type<Array<Record<string, unknown>>>(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  committedAt: text("committed_at"),
});

/** Rate counters for policy enforcement */
export const policyRateCounters = sqliteTable("policy_rate_counters", {
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  windowKey: text("window_key").notNull(),
  count: integer("count").notNull().default(0),
  totalCost: text("total_cost").notNull().default("0"),
}, (table) => ({
  pk: primaryKey({ columns: [table.kernelId, table.windowKey] }),
}));
