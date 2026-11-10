import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLISHED_SURFACES, UNCHECKED_SURFACES } from "../public-claims.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const FEE_WORDING =
  /\bplatform (?:fees?|tax(?:es)?)\b|\bprotocol fees?\b|\bpcc(?:['\u2019]s)? (?:cut|fees?)\b|\bfee (?:rate|collection|recipient|flows?)\b|\b2\.35 ?%/i;
const NEW_FEE = /\bfees?\b|pccfee|treasury|feebps|protocol-fee|\btax(?:es)?\b/i;
const NESTING = /\bnested transactions?\b|pays? the network twice|\btake a cut\b/i;
const ALLOWED: Array<{ file: string; text: string; owner: string; reason: string }> = [
  { file: "README.md", text: "The protocol charges 2.35% on settlement", owner: "not-served", reason: "a repo file that no host serves" },
  { file: "PCC-NETWORK.md", text: "The protocol fee is 2.35%", owner: "managed-elsewhere", reason: "its template lives in another repo" },
  { file: "apps/dashboard/public/whitepaper.md", text: "The Coordination Tax", owner: "kept", reason: "about other platforms" },
  { file: "apps/dashboard/public/whitepaper.md", text: "takes a license fee", owner: "kept", reason: "about other platforms" },
  { file: "apps/dashboard/public/whitepaper.md", text: "Treasury balance, soulbound certificate registry", owner: "operator", reason: "vision text" },
  { file: "apps/dashboard/public/FOUR_SLOTS.md", text: "+20% rush fee", owner: "kept", reason: "an operator's own price" },
  { file: "docs/FOUR_SLOTS.md", text: "+20% rush fee", owner: "kept", reason: "an operator's own price" },
  { file: "docs/ADAPTER_BOUNTIES.md", text: "Tax treatment?", owner: "kept", reason: "a recipient's own taxes" },
  { file: "docs/ADAPTER_BOUNTIES.md", text: "consult a local tax advisor", owner: "kept", reason: "a recipient's own taxes" },
  { file: "docs/ADAPTER_BOUNTIES.md", text: "vendor-API fees", owner: "kept", reason: "a third party's fee" },
  { file: "apps/dashboard/public/.well-known/mcp/server-card.json", text: "certificates, and treasury balance.", owner: "adk", reason: "adk's copy row" },
  { file: "apps/dashboard/public/agent-package.json", text: "routing and fee estimates", owner: "kept", reason: "a third party's fee" },
  { file: "apps/dashboard/public/agent-package.json", text: "network-treasury", owner: "api-enum", reason: "a role the API defines" },
  { file: "packages/onboard-kit/AGENT_INSTRUCTIONS.md", text: "flat fee per job", owner: "kept", reason: "an operator's own price" },
  { file: "docs/SETUP_AGENT_SPEC.md", text: "`/api/treasury`", owner: "gateway", reason: "gateway's served docs" },
  { file: "docs/STORY_PROTOCOL_INTEGRATION_PLAN.md", text: "Network Treasury | 10 | 10% | PCC protocol fee", owner: "gateway", reason: "gateway's served docs" },
  { file: "docs/AGENT_INTEGRATION.md", text: "`network-treasury`", owner: "api-enum", reason: "a role the API defines" },
  { file: "docs/AGENT_INTEGRATION.md", text: "DePIN epochs, certificates, claims, treasury.", owner: "adk", reason: "adk's copy row" },
  { file: "docs/AGENT_INTEGRATION.md", text: "The protocol charges a 2.35% fee on every settlement", owner: "adk", reason: "adk's copy row" },
  { file: "docs/AGENT_INTEGRATION.md", text: "DePIN rewards, certificates, treasury", owner: "adk", reason: "adk's copy row" },
  { file: "packages/mcp-server/README.md", text: "kernel certificates + treasury balance", owner: "adk", reason: "adk's copy row" },
];

const FILES = [...new Set([
  ...PUBLISHED_SURFACES,
  ...Object.keys(UNCHECKED_SURFACES),
  "packages/onboard-kit/AGENT_INSTRUCTIONS.md",
  "docs/CAPABILITY_PROFILES.md",
  "docs/SETUP_AGENT_SPEC.md",
  "docs/STORY_PROTOCOL_INTEGRATION_PLAN.md",
  "docs/AGENT_INTEGRATION.md",
  "docs/quickstart/README.md",
  "apps/dashboard/public/api/agent/tools.json",
  "packages/mcp-server/README.md",
])].filter((file) => /\.(md|html|json)$/.test(file)
  && !/^apps\/dashboard\/public\/(?:pizza-|pcc-agent-package-pizza\.json$|(?:order|driver|operator|operator-capture)\.html$)/.test(file));

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

function lines(file: string): Array<{ text: string; line: number }> {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  if (!file.endsWith(".json")) {
    return source.split("\n").map((text, index) => ({ text, line: index + 1 }));
  }
  let offset = 0;
  return strings(JSON.parse(source)).flatMap((value) => {
    const encoded = JSON.stringify(value);
    const start = source.indexOf(encoded, offset);
    offset = start + encoded.length;
    const line = source.slice(0, start).split("\n").length;
    return value.split("\n").map((text, index) => ({ text, line: line + index }));
  });
}

describe("served copy outside the pizza demo", () => {
  it("no served page, document, agent file or MCP text carries fee, treasury, tax or nesting wording outside its allowlist", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const { text, line } of lines(file)) {
        if ([FEE_WORDING, NEW_FEE, NESTING].some((pattern) => pattern.test(text))
          && !ALLOWED.some((entry) => entry.file === file && text.toLowerCase().includes(entry.text.toLowerCase()))) {
          violations.push(`${file}:${line}: ${text}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every allowlist entry still matches a served line", () => {
    const stale = ALLOWED.filter((entry) => !FILES.includes(entry.file)
      || !lines(entry.file).some(({ text }) => text.toLowerCase().includes(entry.text.toLowerCase())));
    expect(stale).toEqual([]);
  });
});
