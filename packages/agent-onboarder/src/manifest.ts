// @pcc/template-physical-operator — manifest for the orchestrator registry.
//
// This is the canonical entry point. The dashboard auto-discovers templates
// via @pcc/orchestrator-sdk's TemplateRegistry; importing this module's
// default export and calling `templates.register(manifest)` registers it.

import { defineTemplate } from "@pcc/orchestrator-sdk";
import { ONBOARDER_SYSTEM_PROMPT } from "./system-prompt.js";

export default defineTemplate({
  slug: "physical-operator",
  display_name: "Physical Operator",
  description:
    "Onboard a machine shop, fleet, lab, or warehouse to PCC. Captures capabilities, mints a settlement wallet, registers with the gateway, writes an SEO mirror.",
  produces: { kind: "kernel-agent", capability_class: "physical" },
  adapters: {
    chat: { required: true },
    voice: { required: false, fallback: "chat" },
    mcp: { required: false },
  },
  connectors_optional: [
    "postgres",
    "salesforce",
    "sharepoint",
    "sap",
    "csv",
    "octoprint",
    "modbus",
    "opcua",
    "sila",
    "generic-http",
  ],
  system_prompt: ONBOARDER_SYSTEM_PROMPT,
  // Lazy-import the flow surface so the registry can list templates without
  // pulling in their full implementation. The flow today is the
  // OnboarderAgent class plus the state-machine helpers — both re-exported
  // from this package's public index.
  flow: () => import("./onboarder-agent.js"),
});
