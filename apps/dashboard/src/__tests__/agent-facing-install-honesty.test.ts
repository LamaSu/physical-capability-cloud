import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * An install command that an agent or a person copies from us must work today.
 *
 * pcc-node: its only PyPI release (0.1.0) is yanked, and 0.1.1 is pending, so no
 * surface may tell anyone to `pip install pcc-node` or link its PyPI page as if
 * it were installable. When a non-yanked release is published, set
 * PCC_NODE_ON_PYPI to true (and put the command back where it helps).
 *
 * @pcc packages: none is published to npm. public-install-honesty.test.ts (N26)
 * covers the npm case for public/; this file covers the agent-facing files
 * outside public/, and the pip case everywhere in public/.
 *
 * Claude Code has no `/skills install <url>`: `/skills` only lists skills (checked
 * against Claude Code 2.1.285). The install that works is downloading the skill
 * file into ~/.claude/skills/pcc/.
 */
const PCC_NODE_ON_PYPI = false;

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const PUBLIC = resolve(here, "../../public");

/** Agent-facing files outside public/: agents and operators copy commands from these. */
const AGENT_FACING = [
  "pcc.json",
  "PCC-NETWORK.md",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "skills/pcc/SKILL.md",
  ".claude/skills/pcc/SKILL.md",
  "docs/AGENT_INTEGRATION.md",
  "docs/quickstart/claude-code.md",
  "apps/dashboard/src/pages/LandingPage.tsx",
  // The /start page, which pcc.json names as start_here.
  "packages/gateway/src/routes/start.ts",
];

/**
 * public/ files that still carry the pip command, each with its owner. The list may
 * only shrink: once a file is fixed, the ratchet test below fails until its entry
 * is removed.
 */
const PIP_ALLOWLIST: Record<string, string> = {
  "whitepaper.md": "pcc-launch owns this copy",
};

const PIP_PCC_NODE =
  /\b(?:pip3?|pipx|uv\s+pip)\s+install\s+(?:-U\s+|--upgrade\s+)?pcc-node\b|\buvx\s+pcc-node\b/;
const PYPI_PAGE = /pypi\.org\/project\/pcc-node/;
const NPM_PCC =
  /npx\s+(?:-y\s+)?@pcc\/|(?:npm\s+(?:i|install)|pnpm\s+(?:add|dlx)|yarn\s+add)\s+(?:-g\s+)?@pcc\//;
const SKILLS_INSTALL = /\/skills\s+install\b/;
const REMOTE_MCP = "claude mcp add --transport http pcc https://capability.network/mcp";
const TEXT = new Set([".md", ".html", ".json", ".txt", ".xml", ".yaml", ".yml"]);

const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

function publicTextFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return publicTextFiles(path);
    return TEXT.has(extname(name)) ? [path] : [];
  });
}

describe("agent-facing install instructions work today", () => {
  it("every listed file exists", () => {
    for (const rel of AGENT_FACING) expect(() => read(rel), rel).not.toThrow();
  });

  it.skipIf(PCC_NODE_ON_PYPI)("no agent-facing file says `pip install pcc-node` or links its PyPI page", () => {
    const hits = AGENT_FACING.filter((rel) => {
      const text = read(rel);
      return PIP_PCC_NODE.test(text) || PYPI_PAGE.test(text);
    });
    expect(hits).toEqual([]);
  });

  it("no agent-facing file outside public/ installs an @pcc package from npm", () => {
    expect(AGENT_FACING.filter((rel) => NPM_PCC.test(read(rel)))).toEqual([]);
  });

  it.skipIf(PCC_NODE_ON_PYPI)("no public/ file says `pip install pcc-node`, apart from the owned allowlist", () => {
    const hits = publicTextFiles(PUBLIC)
      .filter((file) => PIP_PCC_NODE.test(readFileSync(file, "utf8")))
      .map((file) => relative(PUBLIC, file))
      .filter((rel) => !(rel in PIP_ALLOWLIST));
    expect(hits).toEqual([]);
  });

  it("the allowlist only shrinks: every entry still carries the command", () => {
    const fixed = Object.keys(PIP_ALLOWLIST).filter(
      (rel) => !PIP_PCC_NODE.test(readFileSync(join(PUBLIC, rel), "utf8")),
    );
    expect(fixed, "these files are fixed; remove their allowlist entries").toEqual([]);
  });

  it("nothing tells Claude Code users to run `/skills install`, which does not exist", () => {
    const hits = [
      ...AGENT_FACING.filter((rel) => SKILLS_INSTALL.test(read(rel))),
      ...publicTextFiles(PUBLIC)
        .filter((file) => SKILLS_INSTALL.test(readFileSync(file, "utf8")))
        .map((file) => relative(REPO, file)),
    ];
    expect(hits).toEqual([]);
  });

  it("every `claude mcp add` we advertise uses the gateway's remote endpoint", () => {
    const files = [...AGENT_FACING, "apps/dashboard/public/llms.txt"];
    const wrong = files.flatMap((rel) =>
      [...read(rel).matchAll(/claude mcp add[^\n`"]*/g)]
        .map((m) => m[0].trim())
        .filter((cmd) => cmd !== REMOTE_MCP)
        .map((cmd) => `${rel}: ${cmd}`),
    );
    expect(wrong).toEqual([]);
  });
});
