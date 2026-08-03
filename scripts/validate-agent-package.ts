import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PACKAGE_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");
const ROUTES_DIR = join(ROOT, "packages", "gateway", "src", "routes");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tool {
  name: string;
  endpoint: {
    method: string;
    path: string;
  };
}

interface AgentPackage {
  tools: Tool[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert OpenAPI-style path params to Fastify colon params.
 * e.g.  /api/kernels/{kernelId}  →  /api/kernels/:kernelId
 */
function toFastifyPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Extract all registered route paths from a TypeScript route file using regex.
 * Matches patterns like:
 *   app.get("/api/foo", ...)
 *   app.post<...>("/api/foo/:id", ...)
 *   app.put( "/api/foo", ...)           ← with optional whitespace
 */
function extractRoutePaths(source: string): string[] {
  const pattern =
    /app\s*\.\s*(?:get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*["'](\/?api\/[^"']+)["']/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// 1. Read agent-package.json
// ---------------------------------------------------------------------------

let agentPackage: AgentPackage;
try {
  agentPackage = JSON.parse(readFileSync(AGENT_PACKAGE_PATH, "utf-8")) as AgentPackage;
} catch (err) {
  console.error(`ERROR: Could not read agent-package.json at ${AGENT_PACKAGE_PATH}`);
  console.error(String(err));
  process.exit(1);
}

const tools: Tool[] = agentPackage.tools ?? [];

// ---------------------------------------------------------------------------
// 2. Read all route files and collect registered paths
// ---------------------------------------------------------------------------

let routeFiles: string[];
try {
  routeFiles = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => join(ROUTES_DIR, f));
} catch (err) {
  console.error(`ERROR: Could not read routes directory at ${ROUTES_DIR}`);
  console.error(String(err));
  process.exit(1);
}

// Map from Fastify-style path → source file (for diagnostics)
const registeredRoutes = new Map<string, string>();

for (const filePath of routeFiles) {
  const source = readFileSync(filePath, "utf-8");
  const paths = extractRoutePaths(source);
  const fileName = filePath.split(/[\\/]/).pop()!;
  for (const p of paths) {
    registeredRoutes.set(p, fileName);
  }
}

// ---------------------------------------------------------------------------
// 3. Compare tools against routes
// ---------------------------------------------------------------------------

const missingRoutes: Array<{ tool: string; method: string; path: string }> = [];
const coveredToolPaths = new Set<string>();

for (const tool of tools) {
  const { method, path: rawPath } = tool.endpoint;
  const fastifyPath = toFastifyPath(rawPath);

  if (registeredRoutes.has(fastifyPath)) {
    coveredToolPaths.add(fastifyPath);
  } else {
    missingRoutes.push({ tool: tool.name, method, path: rawPath });
  }
}

// Routes with no corresponding tool
const uncoveredRoutes: Array<{ path: string; file: string }> = [];
for (const [path, file] of registeredRoutes) {
  if (!coveredToolPaths.has(path)) {
    uncoveredRoutes.push({ path, file });
  }
}

// ---------------------------------------------------------------------------
// 4. Print report
// ---------------------------------------------------------------------------

console.log("\n=== agent-package.json validation ===\n");

if (missingRoutes.length > 0) {
  console.log(`MISSING ROUTES  (tools with no matching gateway route):`);
  for (const { tool, method, path } of missingRoutes) {
    console.log(`  [${method.padEnd(6)}] ${path}  →  tool: ${tool}`);
  }
  console.log();
} else {
  console.log("All tools have matching gateway routes.\n");
}

if (uncoveredRoutes.length > 0) {
  console.log(`UNCOVERED ROUTES  (gateway routes with no tool in agent-package.json):`);
  // Group by file for readability
  const byFile = new Map<string, string[]>();
  for (const { path, file } of uncoveredRoutes) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(path);
  }
  for (const [file, paths] of [...byFile.entries()].sort()) {
    console.log(`  ${file}:`);
    for (const p of paths) {
      console.log(`    ${p}`);
    }
  }
  console.log();
} else {
  console.log("All gateway routes are covered by agent-package.json tools.\n");
}

// ---------------------------------------------------------------------------
// 5. Summary
// ---------------------------------------------------------------------------

const toolCount = tools.length;
const validatedCount = toolCount - missingRoutes.length;
const routeCount = registeredRoutes.size;

console.log(
  `Summary: ${validatedCount}/${toolCount} tools validated, ` +
    `${missingRoutes.length} missing routes, ` +
    `${uncoveredRoutes.length} uncovered routes ` +
    `(${routeCount} total gateway routes across ${routeFiles.length} files)`,
);

// ---------------------------------------------------------------------------
// 6. C-03 regression: the public token-approval step was REMOVED (audit C-03 —
// the gateway no longer approves caller-supplied spenders/tokens; allowances
// are issued internally to protocol-created escrows). The pack must not
// reintroduce `approve_token`, any public escrow `/approve` tool, or a
// `fund_escrow` instruction to "approve first".
// ---------------------------------------------------------------------------
const c03Violations: string[] = [];
for (const tool of tools as Array<{ name: string; description?: string; endpoint?: { path?: string } }>) {
  if (tool.name === "approve_token") {
    c03Violations.push(`tool "approve_token" (public token approval removed by audit C-03)`);
  }
  const p = tool.endpoint?.path ?? "";
  if (/\/escrow\/chain\/[^/]+\/approve$/.test(p)) {
    c03Violations.push(`tool "${tool.name}" -> POST ${p} (public escrow approve removed by C-03)`);
  }
  if (tool.name === "fund_escrow" && /approve_token|approve first|already approved/i.test(tool.description ?? "")) {
    c03Violations.push(`fund_escrow description still instructs an approve-first step (audit C-03)`);
  }
}
if (c03Violations.length > 0) {
  console.log("\nC-03 REGRESSION — the public token-approval flow was removed; the pack must not reintroduce it:");
  for (const v of c03Violations) console.log(`  x ${v}`);
  process.exit(1);
}

// Exit non-zero if there are missing routes (useful for CI)
if (missingRoutes.length > 0) {
  process.exit(1);
}
