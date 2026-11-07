import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { scanEnvReadText, COMPUTED_READS } from "./services/env-reads.js";

const names = new Set(COMPUTED_READS.names);
const prefixes = [...new Set(COMPUTED_READS.prefixes)].sort();
let files = 0;
let found = 0;
function walk(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (["node_modules", "__tests__"].includes(basename(path))) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ["node_modules", "__tests__"].includes(entry.name)) continue;
      walk(join(path, entry.name));
    }
  } else if (/\.(?:js|mjs|cjs)$/.test(path) && !/\.(?:test|spec)\./.test(basename(path))) {
    const text = readFileSync(path, "utf8");
    files++;
    const reads = scanEnvReadText(text);
    found += reads.size;
    for (const name of reads) names.add(name);
  }
}

try {
  for (const root of process.argv.slice(2)) walk(root);
  if (files === 0 || found === 0) throw new Error();
  process.stdout.write(`${JSON.stringify({ spec: "pcc.env-reads/v1", names: [...names].sort(), prefixes })}\n`);
} catch {
  process.stderr.write("[env-reads] scan failed\n");
  process.exitCode = 1;
}
