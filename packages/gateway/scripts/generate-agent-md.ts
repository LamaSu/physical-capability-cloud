import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAgentMd, type AgentMdSources } from "../src/docs/render-agent-md.js";

// From packages/gateway: node --import tsx scripts/generate-agent-md.ts
const root = new URL("../../../", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const sources: AgentMdSources = {
  runbook: read("starter/runbook/runbook.json"),
  index: read("starter/runbook/index.json"),
  buyer: read("starter/buyer/buyer-path.json"),
  agentPackage: { attempt_reporting: read("apps/dashboard/public/agent-package.json").attempt_reporting },
};
const output = fileURLToPath(new URL("apps/dashboard/public/.well-known/agent.md", root));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, renderAgentMd(sources), "utf8");
console.log(`Generated ${output}`);
