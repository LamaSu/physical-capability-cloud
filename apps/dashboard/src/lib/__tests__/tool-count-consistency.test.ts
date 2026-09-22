// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE_TOOL_COUNT } from "../agent-package-meta.js";

const REPO_ROOT = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
const CATALOG_PATH = "apps/dashboard/public/agent-package.json";

const TEXT_FILES = [
  "apps/dashboard/index.html",
  "apps/dashboard/public/landing.html",
  "apps/dashboard/public/about.md",
  "apps/dashboard/public/about.html",
  "apps/dashboard/public/index.md",
  "apps/dashboard/public/llms.txt",
  "apps/dashboard/public/MCP_INSTALL.md",
  "apps/dashboard/public/FOUR_SLOTS.md",
  "apps/dashboard/public/skills/pcc.md",
  "apps/dashboard/public/whitepaper.md",
  "CLAUDE.md",
  "docs/AGENT_INTEGRATION.md",
  "docs/FOUR_SLOTS.md",
  "docs/MCP_INSTALL.md",
  "docs/quickstart/claude-code.md",
  "docs/quickstart/claude-web.md",
  "docs/OPENCLAW_INTEGRATION.md",
];

const TSX_FILES = [
  "apps/dashboard/src/components/AgentLandingHero.tsx",
  "apps/dashboard/src/pages/OnboardLandingPage.tsx",
  "apps/dashboard/src/pages/LandingPage.tsx",
  "apps/dashboard/src/pages/SystemDashboardPage.tsx",
];

// Duplicated verbatim from scripts/sync-tool-count.mjs.
const RULES = [
  { name: "R1", re: /(\d+)(-tool agent package)/g },
  { name: "R2", re: /(\d+)(-tool agent-pack\b)/g },
  { name: "R3", re: /(Agent [Pp]ackage — )(\d+)( tools)/g },
  { name: "R4", re: /(agent-package\.json — )(\d+)( tools)/g },
  { name: "R5", re: /(agent-package\.json[^\s]{0,3}\s*\()(\d+)( tools)/g },
  { name: "R6", re: /(full spec — )(\d+)( tools)/g },
  { name: "R7", re: /([Aa]gent-package \()(\d+)( tools)/g },
  { name: "R8", re: /(## \d+\. Agent Package \()(\d+)( Tools\))/g },
  { name: "R9", re: /(containing )(\d+)( tools with input schemas)/g },
  { name: "R10", re: /(\| `tools` \| )(\d+)( entries)/g },
  { name: "R11", re: /(agent-package\s+contains )(\d+)( tool schemas)/g },
  { name: "R12", re: /(agent-package \+ )(\d+)( tools)/g },
  { name: "R13", re: /(and cache the )(\d+)(\s+tools)/g },
  { name: "R14", re: /(the )(\d+)( agent-package tools)/g },
  { name: "R15", re: /(the live )(\d+)(-tool\s+package)/g },
  { name: "R16", re: /(exposes all )(\d+)( agent-package tools)/g },
];

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function readCatalog() {
  const pkg = JSON.parse(readRepoFile(CATALOG_PATH));

  expect(
    pkg !== null && typeof pkg === "object",
    `${CATALOG_PATH} must contain a JSON object`,
  ).toBe(true);
  expect(
    Array.isArray(pkg.tools),
    `${CATALOG_PATH}: tools must be an array`,
  ).toBe(true);
  expect(
    pkg.tools.length,
    `${CATALOG_PATH}: tools must be non-empty`,
  ).toBeGreaterThan(0);

  const N: number = pkg.tools.length;
  return { pkg, N };
}

function rewriteWithRules(source: string, count: number): string {
  let rewritten = source;

  for (const { name, re } of RULES) {
    rewritten = rewritten.replace(
      new RegExp(re.source, re.flags),
      (_match, first, second, third) =>
        name === "R1" || name === "R2"
          ? `${count}${second}`
          : `${first}${count}${third}`,
    );
  }

  return rewritten;
}

describe("agent-package tool count — single source of truth", () => {
  it("parses the catalog and requires a non-empty tools[]", () => {
    readCatalog();
  });

  it("keeps the package's top-level toolCount equal to tools.length", () => {
    const { pkg, N } = readCatalog();

    expect(
      pkg.toolCount,
      `${CATALOG_PATH}: toolCount must equal tools.length; run node scripts/sync-tool-count.mjs`,
    ).toBe(N);
  });

  it("keeps metadata.tool_count equal to tools.length", () => {
    const { pkg, N } = readCatalog();

    expect(
      pkg.metadata?.tool_count,
      `${CATALOG_PATH}: metadata.tool_count must equal tools.length; run node scripts/sync-tool-count.mjs`,
    ).toBe(N);
  });

  it("exports the catalog count from the generated module", () => {
    const { N } = readCatalog();

    expect(
      AGENT_PACKAGE_TOOL_COUNT,
      "agent-package-meta.ts is stale; run node scripts/sync-tool-count.mjs",
    ).toBe(N);
  });

  it("states tools.length exactly once in llms.txt's HTTP /mcp claim", () => {
    const { N } = readCatalog();
    const file = "apps/dashboard/public/llms.txt";
    const source = readRepoFile(file);
    const rule = RULES.find(({ name }) => name === "R16")!;
    const matches = [
      ...source.matchAll(new RegExp(rule.re.source, rule.re.flags)),
    ];

    expect(
      matches,
      `${file}: the HTTP /mcp claim must contain exactly one R16 count`,
    ).toHaveLength(1);

    const match = matches[0]!;

    expect(
      match[2],
      `${file}: the HTTP /mcp agent-package count must equal tools.length`,
    ).toBe(String(N));

    const claimLine = source.split("\n")[lineAt(source, match.index!) - 1]!;

    expect(claimLine).toContain("The MCP server exposes");
    expect(claimLine).toContain("`https://capability.network/mcp`");
  });

  it.each([
    "apps/dashboard/public/FOUR_SLOTS.md",
    "docs/FOUR_SLOTS.md",
    "apps/dashboard/public/whitepaper.md",
  ])("%s omits package versions beside tool counts", (file) => {
    expect(
      readRepoFile(file),
      `${file}: omit independently drifting package versions beside tool counts`,
    ).not.toMatch(/tools,\s*v\d/);
  });

  describe("published text counts", () => {
    for (const file of TEXT_FILES) {
      it(`${file} agrees with tools.length`, () => {
        const { N } = readCatalog();
        const source = readRepoFile(file);
        const stale: string[] = [];

        for (const { name, re } of RULES) {
          const group = name === "R1" || name === "R2" ? 1 : 2;

          for (const match of source.matchAll(
            new RegExp(re.source, re.flags),
          )) {
            const previous = match[group]!;
            const offset =
              match.index! + (group === 1 ? 0 : match[1]!.length);

            if (previous !== String(N)) {
              stale.push(
                `${file}:${lineAt(source, offset)}  ${previous} → ${N} (${name})`,
              );
            }
          }
        }

        expect(
          stale,
          `Run node scripts/sync-tool-count.mjs:\n${stale.join("\n")}`,
        ).toEqual([]);
      });
    }
  });

  describe("React surfaces use the generated constant", () => {
    for (const file of TSX_FILES) {
      it(`${file} imports the constant and has no R1/R2 literal`, () => {
        const source = readRepoFile(file);

        expect(
          source,
          `${file}: import AGENT_PACKAGE_TOOL_COUNT from agent-package-meta`,
        ).toMatch(
          /\bimport\s*\{[^}]*\bAGENT_PACKAGE_TOOL_COUNT\b[^}]*\}\s*from\s*["'][^"']*agent-package-meta(?:\.js|\.ts)?["']/,
        );

        const hardcoded: string[] = [];

        for (const { name, re } of RULES.slice(0, 2)) {
          for (const match of source.matchAll(
            new RegExp(re.source, re.flags),
          )) {
            hardcoded.push(
              `${file}:${lineAt(source, match.index!)}  ${match[0]} (${name})`,
            );
          }
        }

        expect(
          hardcoded,
          `Replace hardcoded counts with AGENT_PACKAGE_TOOL_COUNT:\n${hardcoded.join("\n")}`,
        ).toEqual([]);
      });
    }
  });

  describe("stdio MCP-server claim stays separate", () => {
    it("preserves the published MCP claims in about.md and llms.txt", () => {
      expect(
        readRepoFile("apps/dashboard/public/about.md"),
      ).toContain("77-tool MCP server");
      expect(
        readRepoFile("apps/dashboard/public/llms.txt"),
      ).toContain("The MCP server exposes");
    });

    it.each([
      ["R1", "254-tool agent package"],
      ["R2", "254-tool agent-pack"],
      ["R3", "Agent Package — 254 tools"],
      ["R4", "agent-package.json — 254 tools"],
      ["R5", "agent-package.json (254 tools)"],
      ["R5", "**agent-package.json** (254 tools)"],
      [
        "R5",
        "`https://capability.network/agent-package.json` (254 tools, system prompt, input schemas, endpoint mappings)",
      ],
      [
        "R5",
        "**Agent Package**: [capability.network/agent-package.json](https://capability.network/agent-package.json) (254 tools, for any LLM agent)",
      ],
      ["R6", "full spec — 254 tools"],
      ["R7", "agent-package (254 tools)"],
      [
        "R7",
        "- Agent-package (254 tools): https://capability.network/agent-package.json",
      ],
      ["R8", "## 10. Agent Package (254 Tools)"],
      [
        "R9",
        "The agent package is a single JSON file any LLM can consume, containing 254 tools with input schemas and endpoint mappings.",
      ],
      [
        "R10",
        "| `tools` | 254 entries. Each has `name`, `description`, `input_schema` (JSON Schema), and `endpoint` (`{method, path}`). |",
      ],
      [
        "R11",
        "`https://capability.network/api/...` endpoints. The agent-package\ncontains 254 tool schemas — Claude treats them like its own tool palette.",
      ],
      [
        "R12",
        "at what price — DHT + agent-package + 254 tools), **execution** (the",
      ],
      [
        "R13",
        "1. Once: have the OpenClaw agent fetch\n   `https://capability.network/agent-package.json` and cache the 254\n   tools (PUBLIC, no auth required).",
      ],
      [
        "R14",
        "- `docs/AGENT_INTEGRATION.md` — the 254 agent-package tools + MCP\n  server + REST surface",
      ],
      [
        "R15",
        "- `https://capability.network/agent-package.json` — the live 254-tool\n  package OpenClaw agents fetch and cache",
      ],
      [
        "R16",
        "The MCP server exposes all 254 agent-package tools, plus MCP-only helpers, over Streamable HTTP at `https://capability.network/mcp`.",
      ],
    ])(
      "%s rewrites %s without changing adjacent MCP counts",
      (rule, claim) => {
        const { N } = readCatalog();
        const matchingRules = RULES.flatMap(({ name, re }) =>
          [...claim.matchAll(new RegExp(re.source, re.flags))].map(
            () => name,
          ),
        );

        expect(
          matchingRules,
          `${claim}: each count must match exactly one rule`,
        ).toEqual([rule]);

        const suffix =
          "; 77-tool MCP server\n" +
          "The MCP server exposes 254 real tools\n" +
          "MCP installation: 63 tools\n";
        const source = claim + suffix;
        const expected = claim.replace("254", String(N)) + suffix;

        expect(rewriteWithRules(source, N)).toBe(expected);
      },
    );
  });
});
