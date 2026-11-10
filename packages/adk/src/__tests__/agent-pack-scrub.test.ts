import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SOURCE } from "../../scripts/generate-agent-pin.mjs";
import { AGENT_TOOLS } from "../agent-package.js";

const FEE_WORDING =
  /\bplatform (?:fees?|tax(?:es)?)\b|\bprotocol fees?\b|\bpcc(?:['\u2019]s)? (?:cut|fees?)\b|\bfee (?:rate|collection|recipient|flows?)\b|\b2\.35 ?%/i;
const COPIES = [
  "apps/dashboard/public/skills/pcc.md",
  "skills/pcc/SKILL.md",
  ".claude/skills/pcc/SKILL.md",
  "agent-package-test.json",
  "starter/runbook/08-publish.md",
];
const REMOVED = [
  ["protocol_fee", "GET", "/api/protocol/fee/{amount}"],
  ["protocol_token_fees", "GET", "/api/protocol/token/{tokenAddress}/fees"],
  ["protocol_escrow_fees", "GET", "/api/protocol/escrow/{escrowAddress}/fees"],
  ["pcc_protocol_fee", "GET", "/api/protocol/fee"],
  ["marketplace_create_listing", "POST", "/api/marketplace/listings"],
  ["marketplace_update_listing", "PUT", "/api/marketplace/listings/{id}"],
  ["marketplace_delete_listing", "DELETE", "/api/marketplace/listings/{id}"],
  ["marketplace_place_order", "POST", "/api/marketplace/orders"],
  ["protocol_create_escrow", "POST", "/api/protocol/create-escrow"],
] as const;

const FIXTURE_AND_RELAY_REMOVED = [
  ["list_protocols", "GET", "/api/protocols"],
  ["get_protocol", "GET", "/api/protocols/{id}"],
  ["create_protocol", "POST", "/api/protocols"],
  ["update_protocol", "PUT", "/api/protocols/{id}"],
  ["publish_protocol", "POST", "/api/protocols/{id}/publish"],
  ["fork_protocol", "POST", "/api/protocols/{id}/fork"],
  ["get_protocol_forks", "GET", "/api/protocols/{id}/forks"],
  ["validate_protocol", "POST", "/api/protocols/{id}/validate"],
  ["list_protocol_runs", "GET", "/api/protocol-runs"],
  ["get_protocol_run", "GET", "/api/protocol-runs/{runId}"],
  ["create_protocol_run", "POST", "/api/protocols/{id}/runs"],
  ["start_protocol_run", "POST", "/api/protocol-runs/{runId}/start"],
  ["pause_protocol_run", "POST", "/api/protocol-runs/{runId}/pause"],
  ["resume_protocol_run", "POST", "/api/protocol-runs/{runId}/resume"],
  ["cancel_protocol_run", "POST", "/api/protocol-runs/{runId}/cancel"],
  ["get_workflows", "GET", "/api/orchestrator/workflows"],
  ["get_workflow", "GET", "/api/orchestrator/workflows/{workflowId}"],
  ["get_transfer_graphs", "GET", "/api/orchestrator/graphs"],
  ["list_automation_status", "GET", "/api/automation-status"],
  ["get_automation_status", "GET", "/api/automation-status/{fromNodeId}/{toNodeId}"],
  ["record_episode", "POST", "/api/automation-status/{fromNodeId}/{toNodeId}/episode"],
  ["advance_automation", "POST", "/api/automation-status/{fromNodeId}/{toNodeId}/advance"],
  ["list_transfer_agents", "GET", "/api/transfer-agents"],
  ["get_logistics_overview", "GET", "/api/logistics"],
  ["get_shipments", "GET", "/api/logistics/shipments"],
  ["create_shipment", "POST", "/api/logistics/shipments"],
  ["get_shipment_quote", "POST", "/api/logistics/shipments/quote"],
  ["get_installations", "GET", "/api/logistics/installations"],
  ["get_space_bookings", "GET", "/api/logistics/bookings"],
  ["search_spaces", "GET", "/api/spaces"],
  ["get_space", "GET", "/api/spaces/{id}"],
  ["match_spaces", "POST", "/api/spaces/match"],
  ["get_marketplace_overview", "GET", "/api/marketplace"],
  ["get_equipment_classes", "GET", "/api/marketplace/classes"],
  ["get_demand_supply", "GET", "/api/marketplace/demand-supply"],
  ["calculate_roi", "POST", "/api/marketplace/roi"],
  ["marketplace_categories", "GET", "/api/marketplace/categories"],
  ["marketplace_list_listings", "GET", "/api/marketplace/listings"],
  ["marketplace_get_listing", "GET", "/api/marketplace/listings/{id}"],
  ["marketplace_list_orders", "GET", "/api/marketplace/orders"],
  ["marketplace_get_order", "GET", "/api/marketplace/orders/{id}"],
  ["list_conversations", "GET", "/api/agents/conversations"],
  ["get_depin_stats", "GET", "/api/rewards"],
  ["mint_certificate", "POST", "/api/certificates/mint"],
  ["release_milestone", "POST", "/api/escrow/chain/{address}/release/{milestoneIndex}"],
  ["submit_attestation", "POST", "/api/escrow/chain/{address}/attestation/{milestoneIndex}"],
  ["pcc_create_scope", "POST", "/api/ot2/scope"],
  ["pcc_revoke_scope", "POST", "/api/ot2/scope/{scopeId}/revoke"],
  ["pcc_scope_audit", "GET", "/api/ot2/scope/{scopeId}/audit"],
  ["pcc_relay_tool_call", "POST", "/api/ot2/tool-call"],
  ["pcc_get_tool_result", "GET", "/api/ot2/tool-result/{callId}"],
  ["pcc_camera_latest", "GET", "/api/ot2/camera/snapshot"],
  ["pcc_chat_send", "POST", "/api/ot2/chat"],
  ["pcc_chat_history", "GET", "/api/ot2/chat/messages"],
  ["pcc_get_tool_manifest", "GET", "/api/relay/{kernelId}/manifest"],
  ["pcc_relay_generic_tool_call", "POST", "/api/relay/{kernelId}/tool-call"],
] as const;

const REPO = resolve(dirname(SOURCE), "../../..");
const packText = readFileSync(SOURCE, "utf8");
const pack = JSON.parse(packText) as {
  tools: Array<{ name: string; endpoint: { method: string; path: string } }>;
};

const testPack = JSON.parse(readFileSync(resolve(REPO, "agent-package-test.json"), "utf8")) as {
  system_prompt: string;
  tools: Array<{ name: string }>;
};

/** Decode every string value, including strings nested in schemas and examples. */
function strings(value: unknown, location: string): Array<[string, string]> {
  if (typeof value === "string") return [[location, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${location}/${i}`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      strings(item, `${location}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`),
    );
  }
  return [];
}

describe("agent pack scrub", () => {
  it("AT1 (N203) the served pack and the copies this pack scrubs say nothing about a platform or protocol fee", () => {
    const texts: Array<[string, string]> = [
      ...strings(pack, "agent-package.json"),
      ...COPIES.flatMap((file) =>
        readFileSync(resolve(REPO, file), "utf8").split(/\r?\n/).map((line, i): [string, string] =>
          [`${file}:${i + 1}`, line],
        ),
      ),
    ];
    const matches = texts.flatMap(([location, text]) =>
      [...text.matchAll(new RegExp(FEE_WORDING.source, "gi"))].map((match) => `${location}: ${match[0]}`),
    );
    expect(matches).toEqual([]);
  });

  it("AT2 the fee pattern catches each planted phrase and passes each near miss", () => {
    for (const phrase of [
      "The gateway charges a 2.35% protocol fee on settlement.",
      "Stakers earn future protocol fees when the capability goes live.",
      "current fee rate",
      "have fee collection and registry tracking built in",
      "No platform tax",
      "the PCC cut",
      "The protocol charges 2.35% on settlement",
    ]) {
      expect(phrase).toMatch(FEE_WORDING);
    }
    for (const phrase of [
      "Submit a bug report, suggestion, or general feedback about the PCC network.",
      "platform feedback",
      "feed rate",
      "Provides optimal routing and fee estimates for funding PCC escrow contracts",
    ]) {
      expect(phrase).not.toMatch(FEE_WORDING);
    }
  });

  it("AT3 the nine retired tools are gone from the pack and the pin, by name and by endpoint", () => {
    const problems: string[] = [];
    for (const [name, method, path] of REMOVED) {
      if (pack.tools.some((tool) => tool.name === name)) problems.push(`${name}: name remains in pack tools`);
      if (packText.includes(JSON.stringify(name))) problems.push(`${name}: quoted name remains in pack text`);
      if (Object.prototype.hasOwnProperty.call(AGENT_TOOLS, name)) problems.push(`${name}: name remains in pin`);
      const inPack = pack.tools.some((tool) => tool.endpoint.method === method && tool.endpoint.path === path);
      const inPin = Object.values(AGENT_TOOLS).some((tool) => tool.method === method && tool.path === path);
      if (inPack || inPin) {
        problems.push(`${name}: ${method} ${path} remains in ${[inPack && "pack", inPin && "pin"].filter(Boolean).join(" and ")}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("AT4 the 56 fixture and relay-gated tools are gone from both packs and the pin", () => {
    const problems: string[] = [];
    for (const [name, method, path] of FIXTURE_AND_RELAY_REMOVED) {
      if (pack.tools.some((tool) => tool.name === name)) problems.push(`${name}: name remains in pack tools`);
      if (packText.includes(JSON.stringify(name))) problems.push(`${name}: quoted name remains in pack text`);
      if (Object.prototype.hasOwnProperty.call(AGENT_TOOLS, name)) problems.push(`${name}: name remains in pin`);
      const inPack = pack.tools.some((tool) => tool.endpoint.method === method && tool.endpoint.path === path);
      const inPin = Object.values(AGENT_TOOLS).some((tool) => tool.method === method && tool.path === path);
      if (inPack || inPin) {
        problems.push(`${name}: ${method} ${path} remains in ${[inPack && "pack", inPin && "pin"].filter(Boolean).join(" and ")}`);
      }
      if (testPack.tools.some((tool) => tool.name === name)) problems.push(`${name}: name remains in test pack tools`);
      if (testPack.system_prompt.includes(name)) problems.push(`${name}: name remains in test pack system prompt`);
    }
    expect(problems).toEqual([]);
  });
});
