import { sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";
import { transferNodes } from "./orchestrator.js";

/** A publishable, shareable protocol recipe */
export const protocolTemplates = sqliteTable("protocol_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  version: text("version").notNull(),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  status: text("status").notNull(), // "draft" | "published" | "deprecated" | "archived"
  tags: text("tags", { mode: "json" }).notNull().$type<string[]>(),
  requiredCapabilities: text("required_capabilities", { mode: "json" }).notNull().$type<string[]>(),
  parameters: text("parameters", { mode: "json" }).notNull().$type<Record<string, unknown>[]>(),
  defaultValues: text("default_values", { mode: "json" }).notNull().$type<Record<string, string | number | boolean>>(),
  estimatedTotalDurationMs: integer("estimated_total_duration_ms").notNull(),
  forkCount: integer("fork_count").notNull().default(0),
  runCount: integer("run_count").notNull().default(0),
  rating: real("rating"),
  forkedFrom: text("forked_from"),
  contentHash: text("content_hash"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

/** An abstract step in a protocol template */
export const protocolSteps = sqliteTable("protocol_steps", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull().references(() => protocolTemplates.id),
  capabilityType: text("capability_type").notNull(),
  label: text("label").notNull(),
  action: text("action").notNull(),
  params: text("params", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  parameterBindings: text("parameter_bindings", { mode: "json" }).$type<Array<{
    stepParamKey: string;
    protocolParamKey: string;
  }>>(),
  estimatedDurationMs: integer("estimated_duration_ms").notNull(),
  requiredLabware: text("required_labware"),
  producesEvidence: integer("produces_evidence", { mode: "boolean" }).notNull(),
  dependsOn: text("depends_on", { mode: "json" }).notNull().$type<string[]>(),
  position: text("position", { mode: "json" }).$type<{ x: number; y: number }>(),
  notes: text("notes"),
});

/** An abstract transfer between two protocol steps */
export const protocolTransfers = sqliteTable("protocol_transfers", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull().references(() => protocolTemplates.id),
  fromStepId: text("from_step_id").notNull().references(() => protocolSteps.id),
  toStepId: text("to_step_id").notNull().references(() => protocolSteps.id),
  labwareType: text("labware_type").notNull(),
  constraints: text("constraints", { mode: "json" }).$type<{
    maxWeightKg?: number;
    maxDimensionMm?: number;
    temperatureRange?: { min: number; max: number; unit: string };
    timeConstraintMs?: number;
    orientationRequired?: boolean;
  }>(),
  preferredAutomationLevel: text("preferred_automation_level"),
  notes: text("notes"),
});

/** A fork of a protocol template */
export const protocolForks = sqliteTable("protocol_forks", {
  id: text("id").primaryKey(),
  sourceTemplateId: text("source_template_id").notNull().references(() => protocolTemplates.id),
  sourceTemplateVersion: text("source_template_version").notNull(),
  forkedBy: text("forked_by").notNull(),
  parameterOverrides: text("parameter_overrides", { mode: "json" }).notNull().$type<Record<string, string | number | boolean>>(),
  stepOverrides: text("step_overrides", { mode: "json" }).$type<Array<{
    action: string;
    stepId?: string;
    step?: Record<string, unknown>;
    modifications?: Record<string, unknown>;
  }>>(),
  name: text("name").notNull(),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

/** A concrete execution of a protocol */
export const protocolRuns = sqliteTable("protocol_runs", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull().references(() => protocolTemplates.id),
  templateVersion: text("template_version").notNull(),
  forkId: text("fork_id").references(() => protocolForks.id),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  jobId: text("job_id"),
  parameterValues: text("parameter_values", { mode: "json" }).notNull().$type<Record<string, string | number | boolean>>(),
  status: text("status").notNull(), // ProtocolRunStatus
  currentStepIndex: integer("current_step_index").notNull().default(0),
  initiatedBy: text("initiated_by").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
  sampleIds: text("sample_ids", { mode: "json" }).notNull().$type<string[]>(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

/** A protocol step bound to a real instrument for a specific run */
export const protocolRunSteps = sqliteTable("protocol_run_steps", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => protocolRuns.id),
  protocolStepId: text("protocol_step_id").notNull().references(() => protocolSteps.id),
  nodeId: text("node_id").notNull(),
  deviceId: text("device_id"),
  action: text("action").notNull(),
  resolvedParams: text("resolved_params", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  actualDurationMs: integer("actual_duration_ms"),
  status: text("status").notNull(), // ProtocolRunStepStatus
  evidenceHash: text("evidence_hash"),
  claimId: text("claim_id"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
});

/** A protocol transfer bound to a real agent for a specific run */
export const protocolRunTransfers = sqliteTable("protocol_run_transfers", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => protocolRuns.id),
  protocolTransferId: text("protocol_transfer_id").notNull().references(() => protocolTransfers.id),
  fromNodeId: text("from_node_id").notNull(),
  toNodeId: text("to_node_id").notNull(),
  transferAgentId: text("transfer_agent_id"),
  automationLevel: text("automation_level").notNull(),
  mechanism: text("mechanism").notNull(),
  episodeRecorded: integer("episode_recorded", { mode: "boolean" }).notNull().default(false),
  episodeId: text("episode_id"),
  status: text("status").notNull(), // ProtocolRunTransferStatus
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

/** Tracks automation progression for a specific instrument-to-instrument transfer */
export const automationStatuses = sqliteTable("automation_statuses", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  fromNodeId: text("from_node_id").notNull(),
  toNodeId: text("to_node_id").notNull(),
  transferAgentId: text("transfer_agent_id").notNull(),
  currentLevel: text("current_level").notNull(), // AutomationLevel
  episodeCount: integer("episode_count").notNull().default(0),
  minEpisodesForTraining: integer("min_episodes_for_training").notNull(),
  vlaModelId: text("vla_model_id"),
  vlaModelName: text("vla_model_name"),
  vlaSuccessRate: real("vla_success_rate"),
  advanceThreshold: real("advance_threshold").notNull(),
  lastEpisodeAt: text("last_episode_at"),
  lastTrainedAt: text("last_trained_at"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
}, (table) => ({
  uniqueTransferPair: unique("uq_automation_kernel_from_to").on(
    table.kernelId,
    table.fromNodeId,
    table.toNodeId,
  ),
}));

/** What/who performs a physical transfer between instruments */
export const transferAgents = sqliteTable("transfer_agents", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // "robot" | "human" | "integrated"
  agentRef: text("agent_ref").notNull(),
  label: text("label").notNull(),
  capabilities: text("capabilities", { mode: "json" }).$type<string[]>(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

/** Protocol lifecycle event */
export const protocolEvents = sqliteTable("protocol_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => protocolRuns.id),
  timestamp: text("timestamp").notNull(),
  type: text("type").notNull(), // ProtocolEventType
  stepId: text("step_id"),
  transferId: text("transfer_id"),
  payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
});
