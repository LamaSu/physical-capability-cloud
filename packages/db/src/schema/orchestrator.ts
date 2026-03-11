import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";
import { jobs } from "./jobs.js";

/** The physical topology graph of a kernel */
export const transferGraphs = sqliteTable("transfer_graphs", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

/** A physical location in the kernel topology */
export const transferNodes = sqliteTable("transfer_nodes", {
  id: text("id").primaryKey(),
  graphId: text("graph_id").notNull().references(() => transferGraphs.id),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  deviceId: text("device_id"),
  label: text("label").notNull(),
  nodeType: text("node_type").notNull(), // "instrument" | "station" | "staging" | "manual"
  capabilities: text("capabilities", { mode: "json" }).notNull().$type<string[]>(),
  position: text("position", { mode: "json" }).$type<{ x: number; y: number; z?: number }>(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

/** A valid physical path between two nodes */
export const transferEdges = sqliteTable("transfer_edges", {
  id: text("id").primaryKey(),
  graphId: text("graph_id").notNull().references(() => transferGraphs.id),
  fromNodeId: text("from_node_id").notNull().references(() => transferNodes.id),
  toNodeId: text("to_node_id").notNull().references(() => transferNodes.id),
  mechanism: text("mechanism").notNull(), // TransferMechanism
  transferTimeMs: integer("transfer_time_ms").notNull(),
  bidirectional: integer("bidirectional", { mode: "boolean" }).notNull(),
  constraints: text("constraints", { mode: "json" }).$type<{
    maxWeightKg?: number;
    labwareTypes?: string[];
    maxDimensionMm?: number;
  }>(),
  transferAgentId: text("transfer_agent_id"),
  automationLevel: text("automation_level"),
  episodeCount: integer("episode_count"),
  vlaModelId: text("vla_model_id"),
  vlaSuccessRate: real("vla_success_rate"),
});

/** A trackable unit moving through instruments */
export const samples = sqliteTable("samples", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id),
  label: text("label").notNull(),
  labwareType: text("labware_type").notNull(), // LabwareType
  currentNodeId: text("current_node_id").notNull().references(() => transferNodes.id),
  status: text("status").notNull(), // "created" | "in_transit" | "processing" | "idle" | "completed" | "failed"
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

/** Record of a sample moving between nodes */
export const sampleMovements = sqliteTable("sample_movements", {
  id: text("id").primaryKey(),
  sampleId: text("sample_id").notNull().references(() => samples.id),
  fromNodeId: text("from_node_id").notNull().references(() => transferNodes.id),
  toNodeId: text("to_node_id").notNull().references(() => transferNodes.id),
  mechanism: text("mechanism").notNull(), // TransferMechanism
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  evidenceHash: text("evidence_hash"),
});

/** A sequence of steps across instruments (intra-kernel DAG) */
export const instrumentWorkflows = sqliteTable("instrument_workflows", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  jobId: text("job_id").notNull().references(() => jobs.id),
  status: text("status").notNull(), // "pending" | "running" | "completed" | "failed" | "cancelled"
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
});

/** One operation at one instrument */
export const instrumentSteps = sqliteTable("instrument_steps", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull().references(() => instrumentWorkflows.id),
  nodeId: text("node_id").notNull().references(() => transferNodes.id),
  action: text("action").notNull(),
  params: text("params", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  estimatedDurationMs: integer("estimated_duration_ms").notNull(),
  requiredLabware: text("required_labware"),
  producesEvidence: integer("produces_evidence", { mode: "boolean" }).notNull(),
  dependsOn: text("depends_on", { mode: "json" }).notNull().$type<string[]>(),
});

/** A lock on an instrument */
export const resourceClaims = sqliteTable("resource_claims", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull().references(() => transferNodes.id),
  claimedBy: text("claimed_by").notNull(),
  claimedAt: text("claimed_at").notNull(),
  expiresAt: text("expires_at"),
  released: integer("released", { mode: "boolean" }).notNull().default(false),
  releasedAt: text("released_at"),
});
