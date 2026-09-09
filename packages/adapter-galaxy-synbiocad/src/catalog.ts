/**
 * Catalog loader + selection helpers.
 *
 * The catalog is a data asset (catalog.json) generated from the upstream Galaxy
 * tool XMLs. We read it at runtime relative to this module so the same code
 * works from src/ (vitest) and dist/ (built). This is the menu agents choose
 * from — every tool exposes a JSON-Schema input/output contract.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { DigitalWorkflowStep } from "@pcc/spec";
import type { GalaxyCatalog, GalaxyToolSpec } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Canonical left-to-right order of the design→build pipeline. */
export const PIPELINE_STAGES = [
  "retrosynthesis",
  "cheminformatics",
  "pathway-analysis",
  "enzyme-selection",
  "biosensor-design",
  "genetic-design",
  "dna-assembly",
  "cell-free",
  "ml-modeling",
  "reporting",
  "data-io",
  "workflow-params",
  "draft",
] as const;

let _catalog: GalaxyCatalog | null = null;

/** Load (and memoize) the full generated catalog. */
export function getCatalog(): GalaxyCatalog {
  if (!_catalog) {
    _catalog = JSON.parse(readFileSync(join(HERE, "catalog.json"), "utf-8")) as GalaxyCatalog;
  }
  return _catalog;
}

export interface ListToolsOptions {
  stage?: string;
  status?: GalaxyToolSpec["status"] | GalaxyToolSpec["status"][];
  /** Include deprecated standalone wrappers (default false). */
  includeDeprecated?: boolean;
  /** Include draft + experimental tools (default false). */
  includeUnstable?: boolean;
}

/**
 * List tools, defaulting to the "advertised" set: stable only, no deprecated
 * duplicates, no drafts. This is what a kernel would offer for job routing.
 */
export function listTools(opts: ListToolsOptions = {}): GalaxyToolSpec[] {
  const { stage, status, includeDeprecated = false, includeUnstable = false } = opts;
  const statusFilter = status ? (Array.isArray(status) ? status : [status]) : null;
  return getCatalog().tools.filter((t) => {
    if (stage && t.stage !== stage) return false;
    if (statusFilter) return statusFilter.includes(t.status);
    if (!includeDeprecated && t.status === "deprecated") return false;
    if (!includeUnstable && (t.status === "draft" || t.status === "experimental")) return false;
    return true;
  });
}

/** Get one tool by exact id (returns the first match; ids can duplicate across dirs). */
export function getTool(id: string): GalaxyToolSpec | undefined {
  return getCatalog().tools.find((t) => t.id === id);
}

/** Get a tool or throw a descriptive error (used by the executor). */
export function requireTool(id: string): GalaxyToolSpec {
  const t = getTool(id);
  if (!t) {
    const near = getCatalog()
      .tools.map((x) => x.id)
      .filter((x) => x.includes(id) || id.includes(x))
      .slice(0, 5);
    throw new Error(
      `Unknown Galaxy-SynBioCAD tool '${id}'.` +
        (near.length ? ` Did you mean: ${near.join(", ")}?` : " See getCatalog().tools for the menu."),
    );
  }
  return t;
}

/** Group advertised tools by pipeline stage, in canonical order. */
export function toolsByStage(opts: ListToolsOptions = {}): Record<string, GalaxyToolSpec[]> {
  const grouped: Record<string, GalaxyToolSpec[]> = {};
  for (const stage of PIPELINE_STAGES) {
    const inStage = listTools({ ...opts, stage });
    if (inStage.length) grouped[stage] = inStage;
  }
  return grouped;
}

/** Free-text search over id / name / description / stage. */
export function searchTools(query: string, opts: ListToolsOptions = {}): GalaxyToolSpec[] {
  const q = query.toLowerCase();
  return listTools(opts).filter((t) =>
    [t.id, t.name, t.description ?? "", t.stage, t.category].join(" ").toLowerCase().includes(q),
  );
}

/**
 * Convert a single tool into a `DigitalWorkflowStep`. This is the composition
 * bridge: a workflow DAG can mix Galaxy digital steps with physical steps
 * (both carry `dependsOn`), so "design a pathway → synthesize the DNA → run it
 * on an OT-2" is one graph.
 */
export function toWorkflowStep(
  id: string,
  overrides: Partial<DigitalWorkflowStep> = {},
): DigitalWorkflowStep {
  const t = requireTool(id);
  return {
    stepId: overrides.stepId ?? `galaxy:${t.id}`,
    stepType: "api_call",
    description:
      overrides.description ??
      `${t.name}${t.description ? " — " + t.description : ""} [Galaxy-SynBioCAD/${t.stage}]`,
    inputSchema: t.input_schema,
    outputSchema: t.output_schema,
    dependsOn: overrides.dependsOn ?? [],
    constraints: overrides.constraints ?? {
      requiredEvidence: ["execution_trace", "output_hash"],
    },
  };
}
