/**
 * N26: the public static files must not tell anyone to install a @pcc package
 * from npm or Smithery (none is published, so every such command fails), and
 * must not leak a developer's local file paths. MCP_INSTALL.md used to do both.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "../../public");
const TEXT = new Set([".md", ".html", ".json", ".txt", ".xml", ".yaml", ".yml"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return TEXT.has(extname(name)) ? [path] : [];
  });
}

const UNPUBLISHED_INSTALL =
  /npx\s+(?:-y\s+)?@pcc\/|"-y",\s*"@pcc\/|smithery\s+install\s+@pcc\/|(?:npm\s+(?:i|install)|pnpm\s+add|yarn\s+add)\s+(?:-g\s+)?@pcc\//;
const NPM_PAGE = /npmjs\.com\/package\/@pcc\//;
const LOCAL_PATH = /[A-Za-z]:[\\/]+Users[\\/]|\/Users\/[a-z0-9_-]+\/|pcc-onboard-ui/;

describe("public static files", () => {
  const all = files(PUBLIC);

  it("exist", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it("advertise no install command for an unpublished @pcc package", () => {
    const hits = all.filter((f) => UNPUBLISHED_INSTALL.test(readFileSync(f, "utf8"))).map((f) => relative(PUBLIC, f));
    expect(hits).toEqual([]);
  });

  it("leak no developer's local file paths", () => {
    const hits = all.filter((f) => LOCAL_PATH.test(readFileSync(f, "utf8"))).map((f) => relative(PUBLIC, f));
    expect(hits).toEqual([]);
  });

  it("link no npm page for an unpublished @pcc package", () => {
    const hits = all.filter((f) => NPM_PAGE.test(readFileSync(f, "utf8"))).map((f) => relative(PUBLIC, f));
    expect(hits).toEqual([]);
  });

  it("MCP_INSTALL.md points at the gateway's remote MCP endpoint", () => {
    const doc = readFileSync(join(PUBLIC, "MCP_INSTALL.md"), "utf8");
    expect(doc).toContain("https://capability.network/mcp");
  });
});

// The pages users read in the dashboard are install instructions too:
// OnboardKitPage said "pnpm add @pcc/..." and OnboardLandingPage said
// "npx @pcc/onboard" with a "View on npm" link, all of which answer 404.
describe("dashboard page sources", () => {
  const PAGES = resolve(here, "../pages");
  const pages = readdirSync(PAGES)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(PAGES, name));

  it("exist", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it("advertise no install command for an unpublished @pcc package", () => {
    const hits = pages.filter((f) => UNPUBLISHED_INSTALL.test(readFileSync(f, "utf8"))).map((f) => relative(PAGES, f));
    expect(hits).toEqual([]);
  });

  it("link no npm page for an unpublished @pcc package", () => {
    const hits = pages.filter((f) => NPM_PAGE.test(readFileSync(f, "utf8"))).map((f) => relative(PAGES, f));
    expect(hits).toEqual([]);
  });

  it("link no GitHub-style tree path on the product domain", () => {
    const hits = pages
      .filter((f) => /capability\.network\/tree\//.test(readFileSync(f, "utf8")))
      .map((f) => relative(PAGES, f));
    expect(hits).toEqual([]);
  });
});
