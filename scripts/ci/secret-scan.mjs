#!/usr/bin/env node
// Secret scan for PCC key literals (status board row N44).
//
// A PCC API key is `pcc_live_` or `pcc_test_` followed by 64 hex characters
// (packages/gateway/src/auth/api-key-auth.ts, generateApiKey:
// randomBytes(32).toString("hex")). Oracle keys use `pcc_oracle_` with the same
// body. Test fixtures use short placeholders, far under 32 characters, so a body
// of 32 or more hex characters is treated as a real key.
//
// The scan reads every file git tracks, skips binaries, and never prints a
// matched value: only the file, the line, the prefix and the body length.
//
// Usage: node scripts/ci/secret-scan.mjs [--root <dir>]
// Exit codes: 0 clean, 1 key literal found, 2 scan error.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Same boundary rule as packages/gateway/src/redaction.ts: a letter or digit
// before the prefix means it is part of a longer word, but `_`, `-`, quotes and
// whitespace do not shield a key (`trace_pcc_live_…` is still a key).
const KEY_SOURCE = "(?<![A-Za-z0-9])(pcc_(?:live|test|oracle)_)([0-9a-fA-F]{32,})";

// Files over this size are not read. They are reported, never skipped silently.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Find key literals in one text. Returns positions and shapes only, never values.
 * @param {string} text
 * @returns {{ line: number, prefix: string, length: number }[]}
 */
export function scanText(text) {
  const re = new RegExp(KEY_SOURCE, "g");
  const findings = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const line = text.slice(0, match.index).split("\n").length;
    findings.push({ line, prefix: match[1], length: match[2].length });
  }
  return findings;
}

/**
 * Scan every file tracked in the git index under `root`.
 * @param {string} root
 * @param {{ maxFileBytes?: number }} [options]
 */
export function scanRepo(root, { maxFileBytes = MAX_FILE_BYTES } = {}) {
  const listing = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  const files = listing.toString("utf8").split("\0").filter(Boolean);
  const findings = [];
  const oversized = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = join(root, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue; // tracked in the index but deleted from the working tree
    }
    if (!stat.isFile()) continue;
    if (stat.size > maxFileBytes) {
      oversized.push(rel);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    scanned += 1;
    for (const f of scanText(buf.toString("utf8"))) findings.push({ file: rel, ...f });
  }
  return { findings, scanned, oversized };
}

function main(argv) {
  const i = argv.indexOf("--root");
  const root =
    i >= 0 && argv[i + 1]
      ? resolve(argv[i + 1])
      : execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const { findings, scanned, oversized } = scanRepo(root);
  if (oversized.length > 0) {
    console.log(`secret-scan: ${oversized.length} tracked file(s) over ${MAX_FILE_BYTES} bytes were not read:`);
    for (const rel of oversized) console.log(`  ${rel}`);
  }
  if (findings.length === 0) {
    console.log(`secret-scan: OK. ${scanned} tracked text files, no PCC key literals.`);
    return 0;
  }
  console.error(`secret-scan: ${findings.length} PCC key literal(s) in tracked files:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.prefix}<${f.length} hex chars, value not printed>`);
  }
  console.error(
    "secret-scan: read keys from the environment instead. A key that was ever committed " +
      "is public: the operator must revoke and rotate it.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`secret-scan: error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
