/**
 * MADSci workflow.yaml parser.
 *
 * Loads + zod-validates a MADSci workflow file. Returns a typed Workflow.
 * Throws a descriptive error on schema mismatch so callers see the line.
 */

import { parse as parseYaml } from "yaml";
import {
  MadsciWorkflowSchema,
  type MadsciWorkflow,
} from "./types.js";

export class MadsciParseError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
    this.name = "MadsciParseError";
  }
}

/**
 * Parse a MADSci workflow YAML string.
 *
 * @param yamlText literal contents of a workflow.yaml file
 * @returns typed, validated MadsciWorkflow
 */
export function parseMadsciWorkflow(yamlText: string): MadsciWorkflow {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new MadsciParseError(
      "MADSci workflow YAML parse failed: " + (err as Error).message,
    );
  }
  const result = MadsciWorkflowSchema.safeParse(raw);
  if (!result.success) {
    throw new MadsciParseError(
      "MADSci workflow schema validation failed",
      result.error.issues,
    );
  }
  return result.data;
}
