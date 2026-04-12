/**
 * Query template types — parameterized queries for the NL interface.
 *
 * Inspired by the Venkiteela paper: LLM classifies intent, selects template,
 * extracts slots. Execution is deterministic SQL against the store.
 * Template-based achieves 99.1% accuracy vs ~52% for free-form LLM SQL.
 */

import type { Id, Timestamp } from "./common.js";

// ── Intent Classification ────────────────────────────────────────

/** Canonical intent classes for NL queries */
export type QueryIntent =
  | "job_status"           // "what's happening with my print job?"
  | "find_capability"      // "find a CNC mill for aluminum near SF"
  | "cheapest_capability"  // "cheapest 3D printer for PLA"
  | "spend_analytics"      // "how much have I spent this month?"
  | "operator_stats"       // "what's my kernel's reputation?"
  | "evidence_lookup"      // "show verification evidence for job X"
  | "settlement_status"    // "has escrow for job X been released?"
  | "template_search"      // "what templates exist for Prusa MK4?"
  | "compliance_query"     // "what evidence do I need for Tier 3?"
  | "network_status"       // "how many kernels are online?"
  | "job_history"          // "my last 10 jobs"
  | "kernel_health"        // "is kernel X healthy?"
  | "escrow_balance"       // "what's locked in escrow for job X?"
  | "capability_compare"   // "compare kernels A and B for CNC"
  | (string & {});

/** Result of intent classification */
export interface IntentClassification {
  intent: QueryIntent;
  confidence: number;
  /** Extracted slot values */
  slots: Record<string, string | number | boolean>;
  /** Original user query */
  originalQuery: string;
}

// ── Query Templates ──────────────────────────────────────────────

/** A parameterized query template */
export interface QueryTemplate {
  id: Id;
  /** Which intent this template handles */
  intent: QueryIntent;
  /** Human-readable name */
  name: string;
  /** Description of what this query answers */
  description: string;
  /** Version (semver) */
  version: string;
  /** SQL template with :param placeholders */
  sqlTemplate: string;
  /** Which data sources this query touches */
  dataSources: DataSource[];
  /** Parameter definitions (for slot extraction) */
  params: QueryParam[];
  /** Response format template */
  responseTemplate: string;
  /** Example queries that match this template */
  exampleQueries: string[];
  /** Author */
  authorId?: Id;
  /** Usage count */
  usageCount: number;
  /** Status */
  status: "draft" | "active" | "deprecated";
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

/** Data sources a query can touch */
export type DataSource =
  | "sqlite"     // primary store (jobs, kernels, capabilities, etc.)
  | "chain"      // on-chain data (escrow, settlement, proofs)
  | "storacha"   // evidence CIDs on IPFS/Storacha
  | "starknet"   // ZK proof anchors
  | (string & {});

/** A parameter in a query template */
export interface QueryParam {
  /** Parameter name (matches :param in SQL template) */
  name: string;
  /** Human-readable label */
  label: string;
  /** Parameter type */
  type: "string" | "number" | "boolean" | "date" | "address" | "id";
  /** Whether this parameter is required */
  required: boolean;
  /** Description (helps LLM extract the right value) */
  description: string;
  /** Example values */
  examples?: string[];
}

// ── NL Query Response ────────────────────────────────────────────

/** A grounded response from the NL query interface */
export interface NLQueryResponse {
  /** The answer in natural language */
  answer: string;
  /** Data that backs the answer */
  data: Record<string, unknown>[];
  /** Source citations */
  sources: QuerySource[];
  /** Which template was used */
  templateId: Id;
  /** Intent that was classified */
  intent: QueryIntent;
  /** Confidence of intent classification */
  confidence: number;
  /** Whether this response is from a template (deterministic) or fallback (AI-generated) */
  grounding: "template" | "fallback";
  /** Query execution time in ms */
  latencyMs: number;
}

/** Source citation for a query result */
export interface QuerySource {
  /** Data source type */
  source: DataSource;
  /** Table or contract name */
  table: string;
  /** Row IDs or block numbers */
  references: string[];
  /** Data freshness */
  asOf: Timestamp;
  /** Description */
  description: string;
}

// ── Semantic Metadata Layer (inspired by Wren AI MDL) ────────────

/** Business term definition — maps domain language to DB columns */
export interface SemanticField {
  /** Business term (e.g., "job status", "operator reputation") */
  businessTerm: string;
  /** Technical column path (e.g., "jobs.status", "shop_kernels.reputation") */
  columnPath: string;
  /** Data type */
  dataType: "string" | "number" | "boolean" | "timestamp" | "json" | "address";
  /** Human-readable description */
  description: string;
  /** Example values */
  examples?: string[];
  /** Synonyms the LLM should recognize */
  synonyms?: string[];
}
