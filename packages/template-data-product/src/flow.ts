// Data-product publisher flow — 5-state machine.
//
// States: identify -> describe -> schema -> price -> publish
//
// The flow is intentionally light today — the SDK's `runner.ts` (Wave 3+)
// will walk it. For now the flow file is the schema-of-states + transition
// rules so the manifest's `flow: () => import("./flow.js")` resolves to
// something the registry can introspect.

export type DataProductState = "identify" | "describe" | "schema" | "price" | "publish";

export interface DataProductSession {
  id: string;
  organization: string;
  state: DataProductState;
  /** Connection method: "postgres" | "snowflake" | "bigquery" | "rest" | "graphql" | "mcp" | "csv" */
  source_kind?: string;
  /** Free-form connection string / URL, redacted before storage. */
  source_uri_redacted?: string;
  description?: string;
  schema?: Record<string, unknown>;
  pricing?: {
    model: "per-query" | "per-row" | "flat";
    rate_cents: number;
  };
  registration_id?: string;
  updated_at: number;
}

const TRANSITIONS: Record<DataProductState, DataProductState[]> = {
  identify: ["describe"],
  describe: ["schema"],
  schema: ["price"],
  price: ["publish"],
  publish: [], // terminal
};

export function canTransition(from: DataProductState, to: DataProductState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStates(from: DataProductState): DataProductState[] {
  return TRANSITIONS[from] ?? [];
}

export const ALL_STATES: DataProductState[] = ["identify", "describe", "schema", "price", "publish"];
