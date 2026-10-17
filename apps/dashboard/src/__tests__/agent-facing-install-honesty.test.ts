import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * An install command that an agent or a person copies from us must install the
 * right thing.
 *
 * pcc-node: 0.1.0 is yanked (it ships the shell executor, N66), and 0.1.1 is the
 * first release to install. Every `pip install` of pcc-node names 0.1.1 or later
 * with the `crypto` extra it needs to sign: the rule adk's
 * agent-pack-truth.test.ts (#452) applies to the agent pack and the skill.
 *
 * @pcc packages: none is published to npm. public-install-honesty.test.ts (N26)
 * covers the npm case for public/; this file covers the agent-facing files
 * outside public/.
 *
 * Claude Code has no `/skills install <url>`: `/skills` only lists skills (checked
 * against Claude Code 2.1.285). The install that works is downloading the skill
 * file into ~/.claude/skills/pcc/.
 */
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const PUBLIC = resolve(here, "../../public");

/**
 * Agent-facing files outside public/: agents and operators copy commands from these.
 * CLAUDE.md and the skill copies are adk's to edit (#452, whose test checks the
 * skills); add them here once #452 merges.
 */
const AGENT_FACING = [
  "pcc.json",
  "PCC-NETWORK.md",
  "README.md",
  "AGENTS.md",
  "docs/AGENT_INTEGRATION.md",
  "docs/MCP_INSTALL.md",
  "docs/quickstart/claude-code.md",
  "apps/dashboard/src/pages/LandingPage.tsx",
  // The /start page, which pcc.json names as start_here.
  "packages/gateway/src/routes/start.ts",
];

/**
 * public/ files that still install pcc-node without the floor, each with its owner.
 * The list may only shrink: once a file is fixed, the ratchet test below fails
 * until its entry is removed.
 */
const PIP_ALLOWLIST: Record<string, string> = {
  "whitepaper.md": "pcc-launch owns this copy",
};

const PIP_PCC_NODE = /\b(?:(?:pip3?|pipx|uv\s+pip)\s+install|uvx)\b[^\n`]*pcc-node[^\n`]*/g;
const FLOORED = /pcc-node\[(?:[^\]]*,\s*)?(?:crypto|all)(?:\s*,[^\]]*)?\]>=0\.1\.1/;
const NPM_PCC =
  /npx\s+(?:-y\s+)?@pcc\/|(?:npm\s+(?:i|install)|pnpm\s+(?:add|dlx)|yarn\s+add)\s+(?:-g\s+)?@pcc\//;
const SKILLS_INSTALL = /\/skills\s+install\b/;
const REMOTE_MCP = "claude mcp add --transport http pcc https://capability.network/mcp";
const TEXT = new Set([".md", ".html", ".json", ".txt", ".xml", ".yaml", ".yml"]);

const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/**
 * pcc-node installs that don't name 0.1.1+ with crypto. Shell line continuations are joined first,
 * and JSON strings carry `\n` escapes, so those split lines too.
 */
const unflooredInstalls = (text: string) =>
  [...text.replace(/\\\r?\n\s*/g, " ").replace(/\\n/g, "\n").matchAll(PIP_PCC_NODE)]
    .map((m) => m[0].trim())
    .filter((cmd) => !FLOORED.test(cmd));

function publicTextFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return publicTextFiles(path);
    return TEXT.has(extname(name)) ? [path] : [];
  });
}

describe("agent-facing install instructions install the right thing", () => {
  it("the install check flags every unfloored form a doc might use, and passes the floored ones", () => {
    const unfloored = [
      "pip install pcc-node",
      "pip3 install pcc-node && pcc-node start",
      "python -m pip install --user pcc-node",
      "pip install pcc-node==0.1.0",
      'pip install "pcc-node>=0.1.1"',
      "pip install \\\n  pcc-node",
      "uvx pcc-node start",
    ];
    const floored = [
      'pip install "pcc-node[crypto]>=0.1.1"',
      "pip install 'pcc-node[crypto]>=0.1.1' && pcc-node start",
      'pip install "pcc-node[all]>=0.1.1"',
      'uvx --from "pcc-node[crypto]>=0.1.1" pcc-node start',
      "pcc-node is a pip-installable Python CLI",
    ];
    expect(unfloored.filter((cmd) => unflooredInstalls(cmd).length === 0), "missed").toEqual([]);
    expect(floored.filter((cmd) => unflooredInstalls(cmd).length > 0), "wrongly flagged").toEqual([]);
  });

  it("every listed file exists", () => {
    for (const rel of AGENT_FACING) expect(() => read(rel), rel).not.toThrow();
  });

  it('every agent-facing pcc-node install names 0.1.1 or later with the crypto extra: pip install "pcc-node[crypto]>=0.1.1"', () => {
    const hits = AGENT_FACING.flatMap((rel) => unflooredInstalls(read(rel)).map((cmd) => `${rel}: ${cmd}`));
    expect(hits).toEqual([]);
  });

  it("no agent-facing file outside public/ installs an @pcc package from npm", () => {
    expect(AGENT_FACING.filter((rel) => NPM_PCC.test(read(rel)))).toEqual([]);
  });

  it("every pcc-node install in public/ names 0.1.1 or later with the crypto extra, apart from the owned allowlist", () => {
    const hits = publicTextFiles(PUBLIC)
      .map((file) => relative(PUBLIC, file))
      .filter((rel) => !(rel in PIP_ALLOWLIST))
      .flatMap((rel) => unflooredInstalls(readFileSync(join(PUBLIC, rel), "utf8")).map((cmd) => `${rel}: ${cmd}`));
    expect(hits).toEqual([]);
  });

  it("the allowlist only shrinks: every entry still has an unfloored install", () => {
    const fixed = Object.keys(PIP_ALLOWLIST).filter(
      (rel) => unflooredInstalls(readFileSync(join(PUBLIC, rel), "utf8")).length === 0,
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

  it("every `claude mcp add` we advertise connects to the gateway's remote endpoint", () => {
    const files = [...AGENT_FACING, "apps/dashboard/public/llms.txt"];
    const wrong = files.flatMap((rel) =>
      [...read(rel).matchAll(/claude mcp add[^\n`"]*/g)]
        .map((m) => m[0].replace(/\\\s*$/, "").trim())
        .filter((cmd) => !cmd.startsWith(REMOTE_MCP))
        .map((cmd) => `${rel}: ${cmd}`),
    );
    expect(wrong).toEqual([]);
  });
});
