/**
 * Galaxy-SynBioCAD — MCP tool definitions.
 *
 * Surfaces the @pcc/adapter-galaxy-synbiocad capability catalog (~50 synthetic-
 * biology / metabolic-engineering tools from brsynth/galaxytools: RetroPath2.0,
 * rpTools, Selenzyme, PartsGenie, DNA-Bot, StrainDesign, iCFree, …) so any MCP
 * client can discover the tools and their exact JSON-Schema I/O contracts, then
 * compose a design→build pipeline.
 *
 * Unlike the gateway-proxy tools in this server, these read the LOCAL catalog
 * (no network) — it is a static data asset generated from the upstream Galaxy
 * tool XMLs and shipped inside the adapter package.
 *
 *   1. pcc_galaxy_synbiocad_stages      — pipeline overview (stage → tool ids)
 *   2. pcc_galaxy_synbiocad_list_tools  — list/filter/search the catalog
 *   3. pcc_galaxy_synbiocad_tool_schema — full JSON-Schema I/O for one tool
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getCatalog,
  getTool,
  listTools,
  searchTools,
  toolsByStage,
  type GalaxyToolSpec,
} from "@pcc/adapter-galaxy-synbiocad";

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Stable tool-name list (consumed by tests + static introspection). */
export const GALAXY_SYNBIOCAD_TOOL_NAMES = [
  "pcc_galaxy_synbiocad_stages",
  "pcc_galaxy_synbiocad_list_tools",
  "pcc_galaxy_synbiocad_tool_schema",
] as const;

function compact(t: GalaxyToolSpec) {
  return {
    id: t.id,
    name: t.name,
    stage: t.stage,
    status: t.status,
    description: t.description ?? undefined,
    inputs: t.n_inputs,
    outputs: t.n_outputs,
    ...(t.superseded_by ? { superseded_by: t.superseded_by } : {}),
  };
}

/**
 * Wire the three Galaxy-SynBioCAD discovery tools onto the shared MCP server.
 * Called once from index.ts after the other tool groups are registered.
 */
export function registerGalaxySynBioCadTools(server: McpServer): void {
  server.tool(
    "pcc_galaxy_synbiocad_stages",
    "Overview of the Galaxy-SynBioCAD design→build pipeline: the ordered stages (retrosynthesis, pathway-analysis, enzyme-selection, genetic-design, dna-assembly, …) and the tool ids in each. Start here to see what the synthetic-biology / metabolic-engineering kernel can do.",
    {},
    async () => {
      const cat = getCatalog();
      const stages = Object.fromEntries(
        Object.entries(toolsByStage()).map(([stage, tools]) => [stage, tools.map((t) => t.id)]),
      );
      return toolResult({
        provider: cat.provider,
        commit: cat.commit,
        tool_count: cat.tool_count,
        stages,
      });
    },
  );

  server.tool(
    "pcc_galaxy_synbiocad_list_tools",
    "List the Galaxy-SynBioCAD tools an agent can choose from (compact: id, name, stage, status, input/output counts). Filter by `stage` and/or free-text `query`. Defaults to the advertised set (stable tools; excludes deprecated/draft). Use pcc_galaxy_synbiocad_tool_schema for one tool's full parameter contract.",
    {
      stage: z
        .string()
        .optional()
        .describe("Filter to one pipeline stage, e.g. 'retrosynthesis', 'dna-assembly'"),
      query: z.string().optional().describe("Free-text search over id/name/description/stage"),
    },
    async ({ stage, query }: { stage?: string; query?: string }) => {
      const tools = query ? searchTools(query, { stage }) : listTools({ stage });
      return toolResult({ count: tools.length, tools: tools.map(compact) });
    },
  );

  server.tool(
    "pcc_galaxy_synbiocad_tool_schema",
    "Get the full contract for one Galaxy-SynBioCAD tool: JSON-Schema input_schema (typed params with defaults, ranges, enums, dataset formats) and output_schema, plus stage/citations/help. This is what an agent fills in to run the tool via the adapter's execute({tool_id, params}).",
    {
      toolId: z
        .string()
        .describe("Catalog tool id, e.g. 'retropath2', 'rptools_rpfba', 'selenzy-wrapper'"),
    },
    async ({ toolId }: { toolId: string }) => {
      const t = getTool(toolId);
      if (!t) {
        const near = getCatalog()
          .tools.map((x) => x.id)
          .filter((x) => x.includes(toolId) || toolId.includes(x))
          .slice(0, 8);
        return toolResult({ error: `unknown Galaxy-SynBioCAD tool '${toolId}'`, did_you_mean: near });
      }
      return toolResult({
        id: t.id,
        name: t.name,
        version: t.version,
        stage: t.stage,
        status: t.status,
        description: t.description,
        superseded_by: t.superseded_by,
        input_schema: t.input_schema,
        output_schema: t.output_schema,
        requirements: t.requirements,
        citations: t.citations,
        help: t.help,
      });
    },
  );
}
