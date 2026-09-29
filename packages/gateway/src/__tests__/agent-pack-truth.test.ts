/**
 * The agent pack tells agents only true things (ADK track item 2; board N75, N76).
 *
 * The pack is apps/dashboard/public/agent-package.json plus the pcc skill in its
 * three copies. Every check here failed on master ac86a404:
 *   - the onboarding route `POST /api/onboard/session/start` does not exist
 *     (template-session serves `POST /api/onboard/start`);
 *   - three advertised packages do not exist anywhere
 *     (@pcc/operator-agent-runtime, @pcc/decompose-skill, @pcc/evidence-judge);
 *   - the dashboard skill said 249 tools, and metadata.tool_count said 254,
 *     while the package holds 253;
 *   - kernel_announce_capabilities claimed to register capabilities, but the
 *     route acknowledges and stores nothing;
 *   - `pip install pcc-node` resolves to nothing while 0.1.0 is yanked, and
 *     without the crypto extra a node cannot sign evidence at all.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PKG_PATH = join(REPO, "apps/dashboard/public/agent-package.json");
const SKILLS = ["apps/dashboard/public/skills/pcc.md", "skills/pcc/SKILL.md", ".claude/skills/pcc/SKILL.md"];

const pkgText = readFileSync(PKG_PATH, "utf8");
const pkg = JSON.parse(pkgText) as {
  toolCount: number;
  tools: Array<{ name: string; description: string; endpoint: { method: string; path: string } }>;
};
const PACK: Array<[string, string]> = [
  ["agent-package.json", pkgText],
  ...SKILLS.map((p): [string, string] => [p, readFileSync(join(REPO, p), "utf8")]),
];

/** Every package name defined in this repo, private or not. */
function repoPackages(): Set<string> {
  const names = new Set<string>();
  for (const root of ["packages", "apps"]) {
    for (const entry of readdirSync(join(REPO, root), { withFileTypes: true })) {
      const pj = join(REPO, root, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(pj)) continue;
      const name = JSON.parse(readFileSync(pj, "utf8")).name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

describe("the agent pack tells agents only true things", () => {
  it("names the onboarding route that exists (N76)", () => {
    for (const [file, text] of PACK) {
      expect(text.includes("/api/onboard/session/start"), file).toBe(false);
    }
    const start = pkg.tools.find((t) => t.name === "pcc_onboard_session_start");
    expect(start?.endpoint).toEqual({ method: "POST", path: "/api/onboard/start" });
  });

  it("names only packages that exist in this repo", () => {
    const known = repoPackages();
    for (const [file, text] of PACK) {
      const named = new Set(text.match(/@pcc\/[a-z0-9-]+/g) ?? []);
      const missing = [...named].filter((n) => !known.has(n));
      expect(missing, file).toEqual([]);
    }
  });

  it("states tool counts the package can back", () => {
    expect(pkg.toolCount).toBe(pkg.tools.length);
    // metadata.tool_count said 254 on master while the package held 253 tools.
    const meta = (pkg as { metadata?: { tool_count?: number } }).metadata;
    if (meta?.tool_count !== undefined) expect(meta.tool_count).toBe(pkg.tools.length);
    for (const [file, text] of PACK) {
      for (const m of text.matchAll(/\b(\d{2,4})(\+?) tools\b/g)) {
        const n = Number(m[1]);
        if (m[2] === "+") expect(n, `${file}: "${m[0]}"`).toBeLessThanOrEqual(pkg.tools.length);
        else expect(n, `${file}: "${m[0]}"`).toBe(pkg.tools.length);
      }
    }
  });

  it("does not sell kernel_announce_capabilities as registration (N75)", () => {
    const announce = pkg.tools.find((t) => t.name === "kernel_announce_capabilities");
    expect(announce).toBeDefined();
    expect(announce!.description).not.toMatch(/register/i);
    expect(announce!.description).toMatch(/stores nothing/i);
    expect(announce!.description).toContain("create_capability");
  });

  // 0.1.0 is yanked, so >=0.1.1. And without pynacl (the crypto extra) the node
  // cannot sign evidence or register a signing key: log_capture.py and
  // register.py fail closed, so a plain install can never reach a verified run.
  it("installs a pcc-node that exists and can sign: pcc-node[crypto]>=0.1.1", () => {
    for (const [file, text] of PACK) {
      for (const m of text.matchAll(/pip3? install [^\n`]*pcc-node[^\n`]*/g)) {
        expect(m[0], file).toMatch(/pcc-node\[(?:[^\]]*,\s*)?(?:crypto|all)(?:\s*,[^\]]*)?\]>=0\.1\.1/);
      }
    }
  });
});
