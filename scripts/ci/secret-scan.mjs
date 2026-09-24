#!/usr/bin/env node
// Secret scan for PCC key literals (status board row N44).
//
// A PCC API key is `pcc_live_` or `pcc_test_` followed by 64 hex characters
// (packages/gateway/src/auth/api-key-auth.ts, generateApiKey:
// randomBytes(32).toString("hex")). Oracle keys use `pcc_oracle_` with the same
// body. Any body of 20 or more hex characters counts as key material: that
// covers a whole key and most of a truncated one, and test fixtures use shorter
// placeholders. The prefix matches in any letter case and after any character.
//
// What is scanned is exactly what git records. Every entry in the index is read
// from the object store (one `git cat-file --batch`), whatever the working tree
// holds. Every blob is scanned byte for byte, binaries included, with no size cap.
// File paths are scanned too. Submodule entries (gitlinks) carry no content in
// this repository; they are listed, not scanned. A blob that cannot be read
// fails the scan.
//
// Nothing that is printed carries key material. Findings name the file (with
// any key in the path redacted), the line, the prefix and the body length.
// Error messages are redacted the same way.
//
// Usage: node scripts/ci/secret-scan.mjs [--root <dir>]
// Exit codes: 0 clean, 1 key literal found, 2 scan error.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Bodies this long or longer are key material. Real keys have 64. */
export const MIN_BODY_HEX = 20;

const KEY_SOURCE = `(pcc_(?:live|test|oracle)_)([0-9a-f]{${MIN_BODY_HEX},})`;
// For output only: redact any hex run after a prefix, however short.
const REDACT_SOURCE = "(pcc_(?:live|test|oracle)_)[0-9a-f]+";

const GITLINK_MODE = "160000";

/**
 * Find key literals in one text. Returns positions and shapes only, never values.
 * @param {string} text
 * @returns {{ line: number, prefix: string, length: number }[]}
 */
export function scanText(text) {
  const re = new RegExp(KEY_SOURCE, "gi");
  const findings = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const line = text.slice(0, match.index).split("\n").length;
    findings.push({ line, prefix: match[1], length: match[2].length });
  }
  return findings;
}

/**
 * Remove key material from a string before it is printed.
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  return String(value).replace(new RegExp(REDACT_SOURCE, "gi"), "$1<redacted>");
}

/** Every index entry: mode, blob id and path. */
function listIndex(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--stage"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, sha] = entry.slice(0, tab).split(" ");
      return { mode, sha, path: entry.slice(tab + 1) };
    });
}

/** Read blobs from the object store in one process: sha -> Buffer. */
function readBlobs(root, shas) {
  const blobs = new Map();
  if (shas.length === 0) return blobs;
  const out = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
    input: `${[...new Set(shas)].join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  let pos = 0;
  while (pos < out.length) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) throw new Error("truncated git cat-file output");
    const [sha, type, size] = out.subarray(pos, eol).toString("utf8").split(" ");
    if (type === "missing" || size === undefined) throw new Error(`object ${sha} is missing`);
    const length = Number(size);
    blobs.set(sha, out.subarray(eol + 1, eol + 1 + length));
    pos = eol + 1 + length + 1; // content, then a newline
  }
  return blobs;
}

/**
 * Scan every entry tracked in the git index under `root`.
 * @param {string} root
 */
export function scanRepo(root) {
  const entries = listIndex(root);
  const files = entries.filter((e) => e.mode !== GITLINK_MODE);
  const blobs = readBlobs(root, files.map((e) => e.sha));
  const findings = [];
  const gitlinks = [];
  let scanned = 0;
  for (const entry of entries) {
    for (const f of scanText(entry.path)) {
      findings.push({ file: entry.path, line: 0, prefix: f.prefix, length: f.length, inPath: true });
    }
    if (entry.mode === GITLINK_MODE) {
      gitlinks.push(entry.path);
      continue;
    }
    const blob = blobs.get(entry.sha);
    if (!blob) throw new Error(`could not read ${redact(entry.path)}`);
    scanned += 1;
    // latin1 maps every byte to one character, so binaries are scanned byte-wise.
    for (const f of scanText(blob.toString("latin1"))) findings.push({ file: entry.path, ...f });
  }
  return { findings, scanned, gitlinks };
}

function main(argv) {
  const i = argv.indexOf("--root");
  const root =
    i >= 0 && argv[i + 1]
      ? resolve(argv[i + 1])
      : execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const { findings, scanned, gitlinks } = scanRepo(root);
  if (gitlinks.length > 0) {
    console.log(
      `secret-scan: ${gitlinks.length} submodule entr${gitlinks.length === 1 ? "y has" : "ies have"} ` +
        "no content in this repository and were not scanned:",
    );
    for (const rel of gitlinks) console.log(`  ${redact(rel)}`);
  }
  if (findings.length === 0) {
    console.log(`secret-scan: OK. ${scanned} tracked files (binaries included), no PCC key literals.`);
    return 0;
  }
  console.error(`secret-scan: ${findings.length} PCC key literal(s) in tracked files:`);
  for (const f of findings) {
    const where = f.inPath ? `${redact(f.file)} (in the file name)` : `${redact(f.file)}:${f.line}`;
    console.error(`  ${where}  ${f.prefix}<${f.length} hex chars, value not printed>`);
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
    console.error(`secret-scan: error: ${redact(err instanceof Error ? err.message : err)}`);
    process.exitCode = 2;
  }
}
