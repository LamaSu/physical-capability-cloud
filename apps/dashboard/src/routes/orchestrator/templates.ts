// Template directory exposed to the dashboard. The authoritative manifests
// live in @pcc/template-* packages on the server; this is a small client-side
// mirror used by /orchestrator/[slug]/chat to render the right greeting and
// label without making an extra round-trip on first paint.
//
// Keep this in sync with packages/template-{physical-operator,data-product}/
// src/manifest.ts. When new templates ship, append them here. A future
// follow-up wires GET /api/orchestrator/templates to make this dynamic.

export interface TemplateClientManifest {
  slug: string;
  display_name: string;
  description: string;
  produces_kind: string;
  capability_class: "physical" | "digital";
  greeting: string;
  api_base: string; // backend route prefix, e.g. /api/onboard or /api/orchestrator/<slug>
}

export const TEMPLATES: Record<string, TemplateClientManifest> = {
  "physical-operator": {
    slug: "physical-operator",
    display_name: "Physical Operator",
    description:
      "Onboard a machine shop, fleet, lab, or warehouse to PCC. Drop website, ERP/CMMS connections, SOPs/MOPs — Navi extracts capabilities and registers the operator.",
    produces_kind: "kernel-agent",
    capability_class: "physical",
    greeting:
      "Hi — I'm Navi. I'll help you onboard a physical operator (machine shop, fleet, lab, warehouse) to PCC. While you're on the phone with the voice agent, drop docs and connections here. What's your company name? (e.g. \"Oakland Titanium Mills at https://oakland-titanium-mills.example\")",
    api_base: "/api/onboard"
  },
  "data-product": {
    slug: "data-product",
    display_name: "Data Product",
    description:
      "Publish a queryable dataset as a paid PCC capability. Walk through data location, schema, query interface (REST/GraphQL/SQL/MCP), pricing, refresh cadence.",
    produces_kind: "data-product",
    capability_class: "digital",
    greeting:
      "Hi — I'm Navi. I'll help you publish a queryable dataset as a paid PCC capability. Where does your data live? (e.g. Postgres, Snowflake, BigQuery, REST API, GraphQL endpoint, MCP server)",
    api_base: "/api/orchestrator/data-product"
  }
};

export const TEMPLATE_LIST: TemplateClientManifest[] = Object.values(TEMPLATES);
