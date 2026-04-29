// @pcc/template-data-product — manifest for the orchestrator registry.
//
// Publishes a queryable dataset (Postgres / Snowflake / BigQuery / REST /
// GraphQL / MCP / CSV) as a paid PCC capability. First digital-class
// template; companion to the physical-operator template that ships in
// @pcc/template-physical-operator.

import { defineTemplate } from "@pcc/orchestrator-sdk";
import { DATA_PRODUCT_SYSTEM_PROMPT } from "./system-prompt.js";

export default defineTemplate({
  slug: "data-product",
  display_name: "Data Product",
  description:
    "Publish a queryable dataset as a paid PCC capability. Walks through dataset identification, schema capture, pricing, and registration.",
  produces: { kind: "data-product", capability_class: "digital" },
  adapters: {
    chat: { required: true },
    voice: { required: false, fallback: "chat" },
    mcp: { required: false },
  },
  connectors_optional: ["postgres", "snowflake", "bigquery", "rest", "graphql", "mcp"],
  system_prompt: DATA_PRODUCT_SYSTEM_PROMPT,
  flow: () => import("./flow.js"),
});
