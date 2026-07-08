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
  // Approval-as-evidence (D8) — pre-agreed verification policy snapshotted
  // at commit. Nullable: legacy/pre-D8 sessions and sessions committed
  // without an explicit policy carry null here (the oracle lane treats a
  // missing policy the same as defaultTrivialPolicy()). Source of truth
  // for the full policy body is the verificationPolicies table, keyed by
  // policyId; these two columns are a fast pointer + integrity anchor.
  policyId: text("policy_id"),
  policyHash: text("policy_hash"),
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

/** OT-2 chat messages — relay between user and remote OT-2 agent */
export const ot2ChatMessages = sqliteTable("ot2_chat_messages", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull(),
  role: text("role").notNull(), // "user" | "assistant" | "system"
  content: text("content").notNull(),
  toolCalls: text("tool_calls", { mode: "json" }).$type<unknown[]>(),
  status: text("status").notNull().default("pending"), // "pending" | "processing" | "completed"
  createdAt: text("created_at").notNull(),
});

/** OT-2 camera frames — relay camera from remote OT-2 */
export const ot2CameraFrames = sqliteTable("ot2_camera_frames", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull(),
  frameData: text("frame_data").notNull(), // base64 JPEG
  capturedAt: text("captured_at").notNull(),
});

/** Execution scope — approved set of operations for a job */
export const executionScopes = sqliteTable("execution_scopes", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull(),
  jobId: text("job_id"),
  createdBy: text("created_by").notNull(), // agent ID that created the scope
  status: text("status").notNull().default("active"), // active | completed | revoked | expired
  // What's allowed
  allowedTools: text("allowed_tools", { mode: "json" }).notNull().$type<string[]>(),
  allowedPipettes: text("allowed_pipettes", { mode: "json" }).$type<string[]>(),
  allowedSlots: text("allowed_slots", { mode: "json" }).$type<number[]>(),
  maxCommands: integer("max_commands").notNull().default(100),
  commandCount: integer("command_count").notNull().default(0),
  // Troubleshooting budget
  maxRetries: integer("max_retries").notNull().default(3),
  retryCount: integer("retry_count").notNull().default(0),
  // Safe operations (always allowed regardless of scope):
  // home, lights, identify, health, pipettes, calibration status
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

/** Tool call relay — brain posts calls, executor picks them up */
export const toolCallRelay = sqliteTable("tool_call_relay", {
  id: text("id").primaryKey(),
  scopeId: text("scope_id"), // null for unscoped calls
  kernelId: text("kernel_id").notNull(),
  toolName: text("tool_name").notNull(),
  toolArgs: text("tool_args", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"), // pending | claimed | completed | failed | rejected
  result: text("result"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  claimedAt: text("claimed_at"),
  completedAt: text("completed_at"),
});
