// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PCC_NAME, PCC_POSITIONING_LINE } from "../positioning.js";

const REPO_ROOT = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
const PACKAGE_PATH = "apps/dashboard/public/agent-package.json";
const PACKAGE_GENERATOR = "scripts/polish-agent-package-claude-max.mjs";

// Published surfaces that say what PCC is: to a visitor, an answer engine or a
// discovery client. Each must state the positioning line verbatim. The
// agent-package description is checked on its own below, because the rest of
// that file is agent instructions rather than positioning copy.
const SURFACES = [
  "apps/dashboard/public/landing.html", // /  (hero label)
  "apps/dashboard/index.html", // /dashboard and every SPA route: <title>, OG, JSON-LD
  "apps/dashboard/public/about.html",
  "apps/dashboard/public/about.md",
  "apps/dashboard/public/index.md",
  "apps/dashboard/public/llms.txt",
  "apps/dashboard/public/docs/index.html",
  "apps/dashboard/public/.well-known/ai-agent.json",
  "apps/dashboard/public/unbrowse-skills.json",
  "apps/dashboard/src/pages/AgentChatPage.tsx",
  "packages/gateway/src/routes/start.ts", // /start
  "packages/gateway/src/routes/docs.ts", // /docs subline
  "packages/gateway/src/routes/context-pack.ts", // /agent-context-pack
  "packages/gateway/src/server.ts", // /?mode=agent description
  "docs/quickstart/README.md", // /quickstart redirects here
];

// Retired by copy.md §1 (the first two), plus a hybrid of the brand handle and a
// tagline that index.md used. None may come back on any published surface.
const RETIRED_TAGLINES = [
  /cloud instance for the physical world/i,
  /decentralized control plane/i,
  /capability network for the physical world/i,
];

// Definitions the positioning line replaced on SURFACES. They still appear, on
// purpose, inside agent instructions (the agent-package system_prompt,
// skills/pcc.md), which steer agent behaviour and are not positioning copy.
const REPLACED_DEFINITIONS = [
  /open infrastructure for agents to/i,
  /verifiable on-chain skill wrapper/i,
];

// Where published copy lives: files served as-is, the SPA source and shell, the
// gateway's rendered routes, and the quickstarts /quickstart redirects to.
const PUBLISHED_ROOTS = [
  "apps/dashboard/public",
  "apps/dashboard/index.html",
  "apps/dashboard/src",
  "packages/gateway/src",
  "docs/quickstart",
];
const TEXT_EXTENSIONS = new Set([
  ".html",
  ".md",
  ".txt",
  ".json",
  ".xml",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
]);

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function taglineHits(
  label: string,
  source: string,
  patterns: readonly RegExp[],
): string[] {
  return patterns.flatMap((pattern) =>
    [...source.matchAll(new RegExp(pattern.source, "gi"))].map(
      (match) => `${label}:${lineAt(source, match.index!)}  "${match[0]}"`,
    ),
  );
}

function publishedFiles(): string[] {
  const files: string[] = [];

  const walk = (relativePath: string): void => {
    if (!statSync(resolve(REPO_ROOT, relativePath)).isDirectory()) {
      files.push(relativePath);
      return;
    }

    for (const entry of readdirSync(resolve(REPO_ROOT, relativePath), {
      withFileTypes: true,
    })) {
      const child = join(relativePath, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__tests__") {
          walk(child);
        }
      } else if (
        TEXT_EXTENSIONS.has(extname(entry.name)) &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      ) {
        files.push(child);
      }
    }
  };

  PUBLISHED_ROOTS.forEach(walk);
  return files;
}

function packageDescription(): string {
  const pkg = JSON.parse(readRepoFile(PACKAGE_PATH));

  expect(
    typeof pkg.description,
    `${PACKAGE_PATH}: description must be a string`,
  ).toBe("string");
  return pkg.description;
}

// The generator assigns the description as concatenated string literals.
function generatorDescription(): string {
  const source = readRepoFile(PACKAGE_GENERATOR);
  const assignment =
    /pkg\.description\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*(?:\+\s*)?)+);/.exec(source);

  expect(
    assignment,
    `${PACKAGE_GENERATOR}: expected pkg.description = "…" + "…";`,
  ).not.toBeNull();

  return [...assignment![1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((literal) => JSON.parse(`"${literal[1]}"`) as string)
    .join("");
}

describe("PCC positioning line — one line on every published surface", () => {
  describe("published surfaces state the line", () => {
    for (const file of SURFACES) {
      it(`${file} states "${PCC_POSITIONING_LINE}" and no replaced tagline`, () => {
        const source = readRepoFile(file);

        expect(
          source,
          `${file}: state the positioning line from src/lib/positioning.ts`,
        ).toContain(PCC_POSITIONING_LINE);
        expect(
          taglineHits(file, source, [
            ...RETIRED_TAGLINES,
            ...REPLACED_DEFINITIONS,
          ]),
          `${file}: replace these with "${PCC_POSITIONING_LINE}"`,
        ).toEqual([]);
      });
    }
  });

  it("puts the line in the landing hero label, directly above the H1", () => {
    const label = /<p class="label[^"]*">([^<]*)<\/p>\s*<h1\b/.exec(
      readRepoFile("apps/dashboard/public/landing.html"),
    );

    expect(
      label,
      "landing.html: expected a label paragraph directly above the hero <h1>",
    ).not.toBeNull();
    expect(label![1]).toBe(PCC_POSITIONING_LINE);
  });

  it("titles the dashboard with the expanded name plus the line", () => {
    expect(readRepoFile("apps/dashboard/index.html")).toContain(
      `<title>${PCC_NAME} — ${PCC_POSITIONING_LINE}</title>`,
    );
  });

  it.each([
    "apps/dashboard/public/about.html",
    "apps/dashboard/public/about.md",
  ])("%s keeps the expansion in its definition", (file) => {
    expect(readRepoFile(file)).toContain(
      `${PCC_NAME} (PCC) is ${PCC_POSITIONING_LINE}.`,
    );
  });

  it("AgentLandingHero renders the line from positioning.ts", () => {
    const file = "apps/dashboard/src/components/AgentLandingHero.tsx";
    const source = readRepoFile(file);

    expect(
      source,
      `${file}: import PCC_POSITIONING_LINE from lib/positioning`,
    ).toMatch(
      /\bimport\s*\{[^}]*\bPCC_POSITIONING_LINE\b[^}]*\}\s*from\s*["'][^"']*\/positioning(?:\.js|\.ts)?["']/,
    );
    expect(source).toContain(
      '<div className="alh-eyebrow">{PCC_POSITIONING_LINE}</div>',
    );
  });

  it("leads the agent-package description with the line", () => {
    const description = packageDescription();

    expect(description.startsWith(`${PCC_POSITIONING_LINE}:`)).toBe(true);
    expect(
      taglineHits(`${PACKAGE_PATH} description`, description, [
        ...RETIRED_TAGLINES,
        ...REPLACED_DEFINITIONS,
      ]),
    ).toEqual([]);
  });

  it("keeps the agent-package description equal to what its generator writes", () => {
    // The polish script rewrites description on every run, so an edit to the JSON
    // alone would be undone by the next regeneration.
    expect(
      generatorDescription(),
      `${PACKAGE_GENERATOR} and ${PACKAGE_PATH} disagree on description`,
    ).toBe(packageDescription());
  });

  it("brings back no retired tagline anywhere in published copy", () => {
    const files = publishedFiles();

    expect(files).toContain(join("apps/dashboard/public", "landing.html"));
    expect(files).toContain(join("packages/gateway/src", "server.ts"));

    const hits = files.flatMap((file) =>
      taglineHits(file, readRepoFile(file), RETIRED_TAGLINES),
    );

    expect(
      hits,
      `Use "${PCC_POSITIONING_LINE}" (src/lib/positioning.ts):\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
