/**
 * Types for the Galaxy-SynBioCAD capability catalog + execution surface.
 *
 * The catalog (src/catalog.json) is generated deterministically from the
 * brsynth/galaxytools Galaxy tool XMLs by scripts/build_catalog.py. Each tool
 * carries a JSON-Schema (Draft-07) `input_schema` / `output_schema` so an agent
 * can pick a tool and fill its parameters without reading the XML.
 */

/** JSON Schema (Draft-07) object — kept loose on purpose. */
export type JSONSchema = Record<string, unknown>;

/** One select option on a Galaxy `<param type="select">`. */
export interface GalaxyOption {
  value: string;
  label?: string | null;
  selected?: boolean;
}

/** A Galaxy `<validator>` (empty_field, regex, in_range, ...). */
export interface GalaxyValidator {
  type?: string;
  message?: string | null;
  expr?: string | null;
}

/**
 * A flattened leaf parameter. `path` is dotted (`adv.topx`, `sink.emptysink`)
 * and maps 1:1 to a Galaxy nested-input key by replacing "." with "|".
 */
export interface GalaxyParamSpec {
  name?: string;
  path?: string;
  type?: string; // integer | float | boolean | text | select | data | ...
  format?: string[]; // Galaxy datatypes for `data` params (sbml, sbol, csv, ...)
  default?: unknown;
  min?: string;
  max?: string;
  optional?: boolean;
  required?: boolean;
  label?: string;
  help?: string;
  options?: GalaxyOption[];
  checked_default?: boolean;
  truevalue?: string;
  falsevalue?: string;
  validators?: GalaxyValidator[];
  /** "conditional-selector" | "expand" | undefined (plain leaf) */
  role?: string;
}

/** A declared tool output dataset. */
export interface GalaxyOutputSpec {
  name: string;
  kind: string; // "data" | "collection"
  format?: string; // Galaxy datatype of the produced file
  label?: string;
  column_names?: string[];
  conditional_on?: string; // only produced when this filter is truthy
  collection_type?: string;
}

export type ToolStatus = "stable" | "experimental" | "deprecated" | "draft";

/** A single Galaxy-SynBioCAD tool as a normalized PCC capability. */
export interface GalaxyToolSpec {
  id: string;
  name: string;
  version?: string;
  profile?: string;
  /** Pipeline position: retrosynthesis, pathway-analysis, genetic-design, dna-assembly, ... */
  stage: string;
  status: ToolStatus;
  category: string;
  source_xml: string;
  description?: string | null;
  requirements: { type?: string; version?: string; package?: string | null }[];
  citations: string[];
  inputs: unknown[]; // nested form (conditionals/sections preserved)
  inputs_flat: GalaxyParamSpec[]; // flattened leaves w/ dotted paths
  outputs: GalaxyOutputSpec[];
  input_schema: JSONSchema;
  output_schema: JSONSchema;
  help?: string | null;
  n_inputs: number;
  n_outputs: number;
  /** Present on older standalone wrappers folded into the rptools suite. */
  superseded_by?: string;
  unresolved_macros?: boolean;
}

/** The full generated catalog. */
export interface GalaxyCatalog {
  source: string;
  commit: string;
  provider: string;
  standards: string[];
  tool_count: number;
  stages: Record<string, number>;
  duplicate_ids: Record<string, number>;
  tools: GalaxyToolSpec[];
}

// ---------------------------------------------------------------------------
// Execution surface (Galaxy REST)
// ---------------------------------------------------------------------------

/**
 * A reference to a dataset used as a `data` input. Either an existing history
 * dataset (`hda`), a fetchable URL, or inline content the client will upload.
 */
export interface GalaxyDatasetRef {
  src: "hda" | "ldda" | "url" | "inline";
  id?: string;
  url?: string;
  content?: string;
  name?: string;
  /** Galaxy datatype/extension to assign on upload (e.g. "csv", "sbml"). */
  ext?: string;
}

/** Params for a tool run — keyed by dotted param path (see GalaxyParamSpec.path). */
export type GalaxyParams = Record<string, unknown>;

export interface GalaxyRunInput {
  toolId: string;
  params: GalaxyParams;
  /** Optional existing Galaxy history to run in; the client creates one if absent. */
  historyId?: string;
  /** Override the resolved server tool_id (skips catalog-id → toolshed-id resolution). */
  serverToolId?: string;
}

export type GalaxyRunState = "ok" | "error" | "queued" | "running" | "paused";

export interface GalaxyOutputArtifact {
  name: string;
  datasetId?: string;
  ext?: string;
  downloadUrl?: string;
  /** Populated only when small outputs are inlined (mock, or fetchOutput()). */
  content?: string;
}

export interface GalaxyRunResult {
  toolId: string;
  /** The actual server tool_id used (full toolshed id), when resolved. */
  serverToolId?: string;
  state: GalaxyRunState;
  jobId?: string;
  historyId?: string;
  outputs: Record<string, GalaxyOutputArtifact>;
  stdout?: string;
  stderr?: string;
}

/**
 * The transport contract the adapter executes against. `GalaxyRestClient` is
 * the real implementation; `MockGalaxyClient` is the deterministic, no-server
 * implementation used in tests and `mockMode`.
 */
export interface GalaxyClient {
  runTool(input: GalaxyRunInput): Promise<GalaxyRunResult>;
  health(): Promise<boolean>;
  listTools?(): Promise<{ id: string; version?: string }[]>;
  fetchOutput?(artifact: GalaxyOutputArtifact): Promise<string>;
}
