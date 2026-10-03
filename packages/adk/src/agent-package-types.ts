/** One agent-package tool's HTTP endpoint, as pinned in generated/agent-pin.ts. */
export interface AgentToolEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Gateway path with {param} placeholders. */
  path: string;
  /** Required input fields, from the tool's input_schema. */
  required: readonly string[];
}
