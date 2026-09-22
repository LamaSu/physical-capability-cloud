// Published tool counts span the dashboard, root CLAUDE.md, and docs/.
// tools.length is now the only source of truth. Anyone changing the catalog
// must run: node scripts/sync-tool-count.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = "apps/dashboard/public/agent-package.json";
const GENERATED_PATH = "apps/dashboard/src/lib/agent-package-meta.ts";

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

// Duplicated verbatim in tool-count-consistency.test.ts.
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

function readFile(relativePath) {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function readOptionalFile(relativePath) {
  try {
    return readFile(relativePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function displayValue(value) {
  return value === undefined ? "<missing>" : JSON.stringify(value);
}

// Locate a property in the original JSON, ignoring identically named nested
// properties. For a missing property, report its nearest existing parent.
function jsonFieldOffset(source, propertyPath) {
  let objectStart = source.search(/\S/);
  let nearestOffset = 0;

  for (const key of propertyPath) {
    if (source[objectStart] !== "{") return nearestOffset;

    const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
    tokens.lastIndex = objectStart;
    let depth = 0;
    let found = false;
    let token;

    while ((token = tokens.exec(source)) !== null) {
      const value = token[0];

      if (value === "{" || value === "[") {
        depth += 1;
      } else if (value === "}" || value === "]") {
        depth -= 1;
        if (depth === 0) break;
      } else if (depth === 1 && JSON.parse(value) === key) {
        const separator = /^\s*:\s*/.exec(source.slice(tokens.lastIndex));
        if (!separator) continue;

        nearestOffset = token.index;
        objectStart = tokens.lastIndex + separator[0].length;
        found = true;
        break;
      }
    }

    if (!found) return nearestOffset;
  }

  return nearestOffset;
}

function generatedModule(count) {
  return `// GENERATED FILE — do not edit by hand.
// Source of truth: apps/dashboard/public/agent-package.json -> tools.length
// Regenerate: node scripts/sync-tool-count.mjs
//
// Why this exists: six different hand-typed tool counts once shipped simultaneously
// across the landing pages, llms.txt, the docs and the package's own metadata. Every
// user-facing surface now reads this constant instead of a literal.

export const AGENT_PACKAGE_TOOL_COUNT = ${count};
`;
}

function rewriteText(source, count) {
  const replacement = String(count);
  const sites = [];

  for (const { name, re } of RULES) {
    const group = name === "R1" || name === "R2" ? 1 : 2;

    for (const match of source.matchAll(new RegExp(re.source, re.flags))) {
      const previous = match[group];
      if (previous === replacement) continue;

      const offset = match.index + (group === 1 ? 0 : match[1].length);
      sites.push({
        previous,
        offset,
        line: lineAt(source, offset),
      });
    }
  }

  sites.sort((a, b) => a.offset - b.offset);

  // Work backwards so every offset still refers to the original source.
  // Replacing only the numeric capture preserves every other group verbatim.
  let updated = source;
  for (let index = sites.length - 1; index >= 0; index -= 1) {
    const site = sites[index];
    updated =
      updated.slice(0, site.offset) +
      replacement +
      updated.slice(site.offset + site.previous.length);
  }

  return { updated, sites };
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check" && arg !== "--help");

  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(", ")}. Use --help.`);
  }

  if (args.includes("--help")) {
    console.log(`Usage: node scripts/sync-tool-count.mjs [--check | --help]

Synchronize published agent-package tool counts with ${CATALOG_PATH} tools[].

Without flags: apply changes, writing only files whose contents differ.
--check:       write nothing; exit 1 if any count or generated content drifts.
--help:        show this help.`);
    return;
  }

  const check = args.includes("--check");
  const catalogSource = readFile(CATALOG_PATH);
  let pkg;

  try {
    pkg = JSON.parse(catalogSource);
  } catch (error) {
    throw new Error(`${CATALOG_PATH}: invalid JSON: ${error.message}`);
  }

  if (pkg === null || typeof pkg !== "object" || !Array.isArray(pkg.tools)) {
    throw new Error(`${CATALOG_PATH}: tools must be an array.`);
  }

  const count = pkg.tools.length;
  const changes = [];

  function queueChange(file, before, after, diagnostics) {
    if (before !== after) {
      changes.push({ file, after, diagnostics });
    }
  }

  const metadataIsObject =
    pkg.metadata !== null &&
    typeof pkg.metadata === "object" &&
    !Array.isArray(pkg.metadata);

  const catalogDiagnostics = [];
  const fields = [
    { path: ["toolCount"], previous: pkg.toolCount },
    {
      path: ["metadata", "tool_count"],
      previous: metadataIsObject ? pkg.metadata.tool_count : undefined,
    },
  ];

  for (const field of fields) {
    if (field.previous !== count) {
      const line = lineAt(
        catalogSource,
        jsonFieldOffset(catalogSource, field.path),
      );
      catalogDiagnostics.push(
        `${CATALOG_PATH}:${line}  ${displayValue(field.previous)} → ${count} (${field.path.join(".")})`,
      );
    }
  }

  pkg.toolCount = count;
  if (!metadataIsObject) pkg.metadata = {};
  pkg.metadata.tool_count = count;

  const normalizedCatalog = JSON.stringify(pkg, null, 2) + "\n";
  if (
    catalogSource !== normalizedCatalog &&
    catalogDiagnostics.length === 0
  ) {
    catalogDiagnostics.push(
      `${CATALOG_PATH}:1  JSON formatting differs from canonical serialization`,
    );
  }

  queueChange(
    CATALOG_PATH,
    catalogSource,
    normalizedCatalog,
    catalogDiagnostics,
  );

  const generatedSource = readOptionalFile(GENERATED_PATH);
  const expectedGenerated = generatedModule(count);
  const generatedDiagnostics = [];

  if (generatedSource !== expectedGenerated) {
    const match = generatedSource?.match(
      /export const AGENT_PACKAGE_TOOL_COUNT = (\d+);/,
    );

    if (generatedSource === null) {
      generatedDiagnostics.push(
        `${GENERATED_PATH}:1  <missing> → ${count}`,
      );
    } else if (match && match[1] !== String(count)) {
      generatedDiagnostics.push(
        `${GENERATED_PATH}:${lineAt(generatedSource, match.index)}  ${match[1]} → ${count}`,
      );
    } else {
      generatedDiagnostics.push(
        `${GENERATED_PATH}:1  generated module differs from the expected template for tool count ${count}`,
      );
    }
  }

  queueChange(
    GENERATED_PATH,
    generatedSource,
    expectedGenerated,
    generatedDiagnostics,
  );

  // Read and prepare every file before performing any writes.
  for (const file of TEXT_FILES) {
    const source = readFile(file);
    const { updated, sites } = rewriteText(source, count);

    queueChange(
      file,
      source,
      updated,
      sites.map(
        (site) => `${file}:${site.line}  ${site.previous} → ${count}`,
      ),
    );
  }

  for (const change of changes) {
    if (!check) {
      const absolutePath = resolve(REPO_ROOT, change.file);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, change.after, "utf8");
      console.log(`updated ${change.file}`);
    }

    for (const diagnostic of change.diagnostics) {
      console.log(diagnostic);
    }
  }

  console.log(`tool count: ${count} (source: ${CATALOG_PATH} tools[])`);
  process.exitCode = check && changes.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(
    `sync-tool-count: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
