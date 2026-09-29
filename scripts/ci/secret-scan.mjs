#!/usr/bin/env node
// Secret scan for PCC key literals (status board row N44).
//
// A PCC API key is `pcc_live_` or `pcc_test_` followed by 64 hex characters
// (packages/gateway/src/auth/api-key-auth.ts, generateApiKey:
// randomBytes(32).toString("hex")). Oracle keys use `pcc_oracle_` with the same
// body. Any body of 20 or more hex characters counts as key material: that
// covers a whole key and most of a truncated one, and test fixtures use shorter
// placeholders. Shorter fragments of a real key pass, by design. The prefix
// matches in any letter case and after any character.
//
// What is scanned is exactly what git records, read from the object store:
//   - by default, every entry in the index (for a local check);
//   - with --tree <rev>, every entry of that commit's tree: an immutable
//     candidate, which is what CI scans, because a process can rewrite the
//     index but not a commit;
//   - with --range <base>..<head>, every object reachable from <head> and not
//     from <base>: each commit (message included), tree (file names) and blob
//     the range introduces. A key added in one commit and removed in a later
//     one is still found.
// Every blob is scanned byte for byte, binaries included, with no size cap.
// A blob that holds NUL bytes is also scanned as UTF-16 and UTF-32 text, so a
// key saved in those encodings is found. File paths are scanned too. Submodule
// entries (gitlinks) point into other repositories; they are listed, not
// scanned. A literal scanner cannot see a key that is split, compressed,
// base64-encoded or otherwise transformed.
//
// Nothing that is printed carries key material. Findings name the file (with
// any key in the path redacted), the line, the prefix and the body length.
// Error messages are redacted the same way, and git's own stderr is captured,
// never passed through.
//
// Usage: node scripts/ci/secret-scan.mjs [--root <dir>] [--tree <rev>] [--range <base>..<head>]
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
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const OBJECT_TYPES = new Set(["blob", "tree", "commit", "tag"]);

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

/** Every stride-th byte from offset, as its own buffer. */
function strided(buf, stride, offset) {
  const view = Buffer.alloc(Math.max(0, Math.ceil((buf.length - offset) / stride)));
  for (let i = offset, j = 0; i < buf.length; i += stride, j += 1) view[j] = buf[i];
  return view;
}

/**
 * Find key literals in raw bytes. latin1 maps every byte to one character, so
 * any byte content is scanned. Text in UTF-16 or UTF-32 puts NUL bytes beside
 * every ASCII character; such content is also read one code unit at a time,
 * at every alignment, in both byte orders.
 * @param {Buffer} buf
 */
export function scanBytes(buf) {
  const findings = scanText(buf.toString("latin1"));
  if (!buf.includes(0)) return findings;
  for (const [stride, encoding] of [[2, "utf-16"], [4, "utf-32"]]) {
    for (let offset = 0; offset < stride; offset += 1) {
      for (const f of scanText(strided(buf, stride, offset).toString("latin1"))) {
        findings.push({ ...f, encoding });
      }
    }
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

/** Run git in `root`. Every stream is captured: git's stderr never reaches ours. */
function git(root, args, input, maxBuffer = 256 * 1024 * 1024) {
  return execFileSync("git", ["-C", root, ...args], {
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer,
  });
}

/** The full object id of a revision, or an error if it names no commit. */
function resolveCommit(root, rev) {
  if (typeof rev !== "string" || rev === "" || rev.startsWith("-")) throw new Error("a revision is required");
  const oid = git(root, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]).toString("utf8").trim();
  if (!OBJECT_ID.test(oid)) throw new Error("git rev-parse gave no object id");
  return oid;
}

/**
 * Parse `git cat-file --batch` output for exactly the requested ids, in order.
 * Every header, size, payload and delimiter is checked: a missing object, a
 * different object, a bad type or size, a truncated payload, a missing
 * delimiter or trailing bytes are errors, never a shorter scan.
 * @param {Buffer} out
 * @param {string[]} requested
 * @returns {Map<string, { type: string, data: Buffer }>}
 */
export function parseCatFileBatch(out, requested) {
  const objects = new Map();
  let pos = 0;
  for (const oid of requested) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) throw new Error("truncated git cat-file output");
    const parts = out.subarray(pos, eol).toString("utf8").split(" ");
    if (parts.length === 2 && parts[1] === "missing") throw new Error(`object ${parts[0]} is missing`);
    if (parts.length !== 3) throw new Error("malformed git cat-file header");
    const [got, type, sizeText] = parts;
    if (got !== oid) throw new Error("git cat-file answered for a different object");
    if (!OBJECT_TYPES.has(type)) throw new Error("unexpected object type in git cat-file output");
    if (!/^\d{1,15}$/.test(sizeText)) throw new Error("malformed object size in git cat-file output");
    const start = eol + 1;
    const end = start + Number(sizeText);
    if (end >= out.length) throw new Error("truncated object in git cat-file output");
    if (out[end] !== 0x0a) throw new Error("missing delimiter after an object in git cat-file output");
    objects.set(oid, { type, data: out.subarray(start, end) });
    pos = end + 1;
  }
  if (pos !== out.length) throw new Error("unexpected trailing bytes in git cat-file output");
  return objects;
}

/** Read objects from the object store in one process: id -> { type, data }. */
function readObjects(root, oids) {
  const requested = [...new Set(oids)];
  if (requested.length === 0) return new Map();
  for (const oid of requested) if (!OBJECT_ID.test(oid)) throw new Error("malformed object id");
  const out = git(root, ["cat-file", "--batch"], `${requested.join("\n")}\n`, 1024 * 1024 * 1024);
  return parseCatFileBatch(out, requested);
}

/** Scan a list of { mode, oid, path } entries (an index or a tree). */
function scanEntries(root, entries) {
  const files = entries.filter((e) => e.mode !== GITLINK_MODE);
  const objects = readObjects(root, files.map((e) => e.oid));
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
    const object = objects.get(entry.oid);
    if (!object || object.type !== "blob") throw new Error(`could not read ${redact(entry.path)} as a blob`);
    scanned += 1;
    for (const f of scanBytes(object.data)) findings.push({ file: entry.path, ...f });
  }
  return { findings, scanned, gitlinks };
}

/** Split NUL-separated `<meta>\t<path>` records. */
function records(buf) {
  return buf
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      if (tab < 0) throw new Error("malformed git listing");
      return { meta: entry.slice(0, tab).split(" "), path: entry.slice(tab + 1) };
    });
}

/**
 * Scan every entry tracked in the git index under `root` (a local check).
 * @param {string} root
 */
export function scanRepo(root) {
  const entries = records(git(root, ["ls-files", "-z", "--stage"])).map(({ meta, path }) => ({
    mode: meta[0],
    oid: meta[1],
    path,
  }));
  return scanEntries(root, entries);
}

/**
 * Scan every entry of a commit's tree, read from the object store.
 * @param {string} root
 * @param {string} rev
 */
export function scanTree(root, rev) {
  const commit = resolveCommit(root, rev);
  const entries = records(git(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).map(({ meta, path }) => ({
    mode: meta[0],
    oid: meta[2],
    path,
  }));
  return scanEntries(root, entries);
}

/**
 * Scan every object that `head` reaches and `base` does not: commits (their
 * messages), trees (file names), blobs and tags.
 * @param {string} root
 * @param {string} range "<base>..<head>"
 */
export function scanRange(root, range) {
  const m = /^([^.\s][^\s]*)\.\.([^.\s][^\s]*)$/.exec(range ?? "");
  if (!m) throw new Error("--range takes <base>..<head>");
  const base = resolveCommit(root, m[1]);
  const head = resolveCommit(root, m[2]);
  const listed = git(root, ["rev-list", "--objects", head, `^${base}`]).toString("utf8").split("\n").filter(Boolean);
  const paths = new Map();
  for (const line of listed) {
    const oid = line.slice(0, line.indexOf(" ") < 0 ? line.length : line.indexOf(" "));
    if (!OBJECT_ID.test(oid)) throw new Error("malformed git rev-list output");
    const path = line.length > oid.length ? line.slice(oid.length + 1) : "";
    if (!paths.has(oid) || (!paths.get(oid) && path)) paths.set(oid, path);
  }
  const objects = readObjects(root, [...paths.keys()]);
  const findings = [];
  for (const [oid, path] of paths) {
    const object = objects.get(oid);
    const where = path ? `${path} (object ${oid.slice(0, 12)})` : `${object.type} ${oid.slice(0, 12)}`;
    for (const f of scanBytes(object.data)) findings.push({ file: where, ...f, inHistory: true });
  }
  return { findings, scanned: paths.size, gitlinks: [] };
}

function option(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function main(argv) {
  const rootArg = option(argv, "--root");
  const root = rootArg ? resolve(rootArg) : git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const tree = option(argv, "--tree");
  const range = option(argv, "--range");
  const results = [];
  if (tree === undefined && range === undefined) results.push(["tracked files (the index)", scanRepo(root)]);
  if (tree !== undefined) results.push([`files in the tree of ${redact(tree)}`, scanTree(root, tree)]);
  if (range !== undefined) results.push([`objects introduced by ${redact(range)}`, scanRange(root, range)]);

  const findings = results.flatMap(([, r]) => r.findings);
  const gitlinks = [...new Set(results.flatMap(([, r]) => r.gitlinks))];
  if (gitlinks.length > 0) {
    console.log(
      `secret-scan: ${gitlinks.length} submodule entr${gitlinks.length === 1 ? "y points" : "ies point"} ` +
        "into another repository and were not scanned:",
    );
    for (const rel of gitlinks) console.log(`  ${redact(rel)}`);
  }
  const what = results.map(([label, r]) => `${r.scanned} ${label}`).join("; ");
  if (findings.length === 0) {
    console.log(`secret-scan: OK. ${what}: no PCC key literals.`);
    return 0;
  }
  console.error(`secret-scan: ${findings.length} PCC key literal(s) in ${what}:`);
  for (const f of findings) {
    const where = f.inPath ? `${redact(f.file)} (in the file name)` : `${redact(f.file)}:${f.line}`;
    const how = f.encoding ? ` [${f.encoding}]` : "";
    console.error(`  ${where}${how}  ${f.prefix}<${f.length} hex chars, value not printed>`);
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
