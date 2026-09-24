// Tests for scripts/ci/secret-scan.mjs (status board row N44).
// Run: node --test scripts/ci/secret-scan.test.mjs
//
// Every fake key here is assembled at runtime, so this file holds no literal the
// scanner would flag when CI scans the repository itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES, scanRepo, scanText } from "./secret-scan.mjs";

const SCANNER = join(dirname(fileURLToPath(import.meta.url)), "secret-scan.mjs");
const HEX64 = "0123456789abcdef".repeat(4);
const key = (kind, body = HEX64) => ["pcc", kind, body].join("_");

function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function track(dir, ...rels) {
  execFileSync("git", ["-C", dir, "add", "--", ...rels]);
}

test("finds live, test and oracle keys with their line numbers", () => {
  const text = [
    "const a = 1;",
    `const k = "${key("live")}";`,
    `ORACLE_KEY="${key("oracle")}"`,
    `headers: { Authorization: "Bearer ${key("test")}" }`,
  ].join("\n");
  assert.deepEqual(scanText(text), [
    { line: 2, prefix: "pcc_live_", length: 64 },
    { line: 3, prefix: "pcc_oracle_", length: 64 },
    { line: 4, prefix: "pcc_test_", length: 64 },
  ]);
});

test("a findings list never carries the key value", () => {
  const found = scanText(`x = "${key("live")}"`);
  assert.equal(found.length, 1);
  assert.ok(!JSON.stringify(found).includes(HEX64));
});

test("short fixture placeholders are not keys", () => {
  const text = [
    `"${key("live", "abc123")}"`,
    `"${key("test", "deadbeef00")}"`,
    `"${key("live", "0123456789abcdef0123456789abcde")}"`, // 31 hex chars
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("an underscore or dash before the prefix does not shield a key", () => {
  assert.equal(scanText(`trace_${key("live")}`).length, 1);
  assert.equal(scanText(`x-${key("oracle")}`).length, 1);
});

test("a letter or digit before the prefix makes it part of another word", () => {
  assert.deepEqual(scanText(`a${key("live")}`), []);
  assert.deepEqual(scanText(`7${key("oracle")}`), []);
});

test("scanRepo reports tracked files only, and skips binaries", () => {
  const dir = tempRepo({
    "src/tracked.ts": `export const K = "${key("live")}";\n`,
    "src/untracked.ts": `export const K = "${key("live")}";\n`,
    "assets/blob.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key("live"))]),
    "clean.md": "nothing to see\n",
  });
  try {
    track(dir, "src/tracked.ts", "assets/blob.bin", "clean.md");
    const { findings, scanned } = scanRepo(dir);
    assert.deepEqual(findings, [{ file: "src/tracked.ts", line: 1, prefix: "pcc_live_", length: 64 }]);
    assert.equal(scanned, 2); // tracked.ts and clean.md; the binary is skipped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exits 1 on a tracked key and never prints its value", () => {
  const dir = tempRepo({ "scripts/leak.sh": `ORACLE_KEY="${key("oracle")}"\n` });
  try {
    track(dir, "scripts/leak.sh");
    const run = spawnSync(process.execPath, [SCANNER, "--root", dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /scripts\/leak\.sh:1 {2}pcc_oracle_<64 hex chars, value not printed>/);
    assert.ok(!run.stdout.includes(HEX64) && !run.stderr.includes(HEX64));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exits 0 on a clean repository", () => {
  const dir = tempRepo({ "README.md": "Use PCC_API_KEY from the environment.\n" });
  try {
    track(dir, "README.md");
    const run = spawnSync(process.execPath, [SCANNER, "--root", dir], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /secret-scan: OK\. 1 tracked text files, no PCC key literals\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized tracked files are reported, not silently skipped", () => {
  assert.equal(MAX_FILE_BYTES, 25 * 1024 * 1024);
  const dir = tempRepo({ "big.txt": `${"a".repeat(2048)}\n${key("live")}\n` });
  try {
    track(dir, "big.txt");
    const { oversized, scanned } = scanRepo(dir, { maxFileBytes: 1024 });
    assert.deepEqual(oversized, ["big.txt"]);
    assert.equal(scanned, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
