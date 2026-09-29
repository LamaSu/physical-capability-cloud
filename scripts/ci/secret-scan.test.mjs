// Tests for scripts/ci/secret-scan.mjs (status board row N44).
// Run: node --test scripts/ci/secret-scan.test.mjs
//
// Every fake key here is assembled at runtime, so this file holds no literal the
// scanner would flag when CI scans the repository itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_BODY_HEX, parseCatFileBatch, redact, scanBytes, scanRepo, scanText } from "./secret-scan.mjs";

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

function runCli(dir, ...args) {
  return spawnSync(process.execPath, [SCANNER, "--root", dir, ...args], { encoding: "utf8" });
}

function commitAll(dir, message) {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function withRepo(files, tracked, fn) {
  const dir = tempRepo(files);
  try {
    track(dir, ...tracked);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a body of 20 or more hex characters is key material; short placeholders are not", () => {
  assert.equal(MIN_BODY_HEX, 20);
  assert.equal(scanText(key("live", HEX64.slice(0, 20))).length, 1);
  assert.equal(scanText(key("live", HEX64.slice(0, 31))).length, 1);
  const placeholders = [
    `"${key("live", "abc123")}"`,
    `"${key("test", "deadbeef00")}"`,
    `"${key("live", HEX64.slice(0, 19))}"`,
  ].join("\n");
  assert.deepEqual(scanText(placeholders), []);
});

test("the prefix matches in any letter case", () => {
  const upper = ["PCC", "LIVE", HEX64].join("_");
  const mixed = ["Pcc", "Oracle", HEX64.toUpperCase()].join("_");
  assert.deepEqual(
    scanText(`${upper}\n${mixed}`).map((f) => f.prefix),
    ["PCC_LIVE_", "Pcc_Oracle_"],
  );
});

test("no character before the prefix shields a key", () => {
  for (const before of ["trace_", "x-", "a", "7", "Z"]) {
    assert.equal(scanText(`${before}${key("live")}`).length, 1, before);
  }
});

test("redact removes key material of any length from printed text", () => {
  const text = `bad ${key("live")} and ${key("oracle", "abc")} and ${["PCC", "TEST", "12"].join("_")}`;
  const out = redact(text);
  assert.ok(!out.includes(HEX64));
  assert.equal(out, "bad pcc_live_<redacted> and pcc_oracle_<redacted> and PCC_TEST_<redacted>");
});

test("scanRepo reads tracked entries only, and scans binaries byte-wise", () => {
  withRepo(
    {
      "src/tracked.ts": `export const K = "${key("live")}";\n`,
      "src/untracked.ts": `export const K = "${key("live")}";\n`,
      "assets/blob.bin": Buffer.concat([Buffer.from([0, 1, 2, 255, 10]), Buffer.from(key("test"))]),
      "clean.md": "nothing to see\n",
    },
    ["src/tracked.ts", "assets/blob.bin", "clean.md"],
    (dir) => {
      const { findings, scanned } = scanRepo(dir);
      assert.deepEqual(findings, [
        { file: "assets/blob.bin", line: 2, prefix: "pcc_test_", length: 64 },
        { file: "src/tracked.ts", line: 1, prefix: "pcc_live_", length: 64 },
      ]);
      assert.equal(scanned, 3);
    },
  );
});

test("a large tracked file is scanned in full; there is no size cap", () => {
  const big = Buffer.alloc(30 * 1024 * 1024, 0x61); // 30 MiB of 'a'
  withRepo({ "big.txt": Buffer.concat([big, Buffer.from(`\n${key("live")}\n`)]) }, ["big.txt"], (dir) => {
    const { findings } = scanRepo(dir);
    assert.deepEqual(findings, [{ file: "big.txt", line: 2, prefix: "pcc_live_", length: 64 }]);
  });
});

test("what is scanned is the index, even when the working tree lost the file", () => {
  withRepo({ "gone.sh": `K="${key("oracle")}"\n` }, ["gone.sh"], (dir) => {
    unlinkSync(join(dir, "gone.sh"));
    const { findings } = scanRepo(dir);
    assert.deepEqual(findings, [{ file: "gone.sh", line: 1, prefix: "pcc_oracle_", length: 64 }]);
  });
});

test("a key in a file name is found, and the printed name is redacted", () => {
  const name = `notes-${key("live")}.txt`;
  withRepo({ [name]: "harmless\n" }, [name], (dir) => {
    const { findings } = scanRepo(dir);
    assert.deepEqual(findings, [{ file: name, line: 0, prefix: "pcc_live_", length: 64, inPath: true }]);
    const run = runCli(dir);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /notes-pcc_live_<redacted>\.txt \(in the file name\)/);
    assert.ok(!run.stdout.includes(HEX64) && !run.stderr.includes(HEX64));
  });
});

test("submodule entries are listed, not silently skipped", () => {
  withRepo({ "README.md": "clean\n" }, ["README.md"], (dir) => {
    execFileSync("git", [
      "-C", dir, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`,
    ]);
    const run = runCli(dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /1 submodule entry points into another repository and were not scanned:\n {2}vendor\/sub/);
  });
});

test("CLI exits 1 on a tracked key and never prints its value", () => {
  withRepo({ "scripts/leak.sh": `ORACLE_KEY="${key("oracle")}"\n` }, ["scripts/leak.sh"], (dir) => {
    const run = runCli(dir);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /scripts\/leak\.sh:1 {2}pcc_oracle_<64 hex chars, value not printed>/);
    assert.ok(!run.stdout.includes(HEX64) && !run.stderr.includes(HEX64));
  });
});

test("CLI exits 1 on a key inside a binary file", () => {
  withRepo(
    { "img.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), Buffer.from(key("live"))]) },
    ["img.png"],
    (dir) => {
      const run = runCli(dir);
      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, /img\.png:1 {2}pcc_live_<64 hex chars, value not printed>/);
    },
  );
});

test("CLI exits 0 on a clean repository", () => {
  withRepo({ "README.md": "Use PCC_API_KEY from the environment.\n" }, ["README.md"], (dir) => {
    const run = runCli(dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /secret-scan: OK\. 1 tracked files \(the index\): no PCC key literals\./);
  });
});

test("CLI exits 2, not 0, when the repository cannot be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-norepo-"));
  try {
    const run = runCli(dir);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /secret-scan: error:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Round 3 (astra r2 on #371) ────────────────────────────────────────────────

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const frame = (oid, type, body) => Buffer.concat([Buffer.from(`${oid} ${type} ${body.length}\n`), body, Buffer.from("\n")]);

test("cat-file framing: a well-formed reply parses, in the requested order", () => {
  const out = Buffer.concat([frame(OID_A, "blob", Buffer.from("one")), frame(OID_B, "commit", Buffer.from("two"))]);
  const objects = parseCatFileBatch(out, [OID_A, OID_B]);
  assert.equal(objects.get(OID_A).data.toString(), "one");
  assert.equal(objects.get(OID_B).type, "commit");
});

test("cat-file framing: every malformed or short reply is an error, never a shorter scan", () => {
  const good = frame(OID_A, "blob", Buffer.from("payload"));
  const cases = {
    missing: Buffer.from(`${OID_A} missing\n`),
    "different object": frame(OID_B, "blob", Buffer.from("payload")),
    "bad type": frame(OID_A, "blobby", Buffer.from("payload")),
    "negative size": Buffer.from(`${OID_A} blob -1\npayload\n`),
    "exponent size": Buffer.from(`${OID_A} blob 1e3\npayload\n`),
    "extra header field": Buffer.from(`${OID_A} blob 7 x\npayload\n`),
    "truncated payload": good.subarray(0, good.length - 4),
    "missing delimiter": Buffer.concat([good.subarray(0, good.length - 1), Buffer.from("X")]),
    "trailing bytes": Buffer.concat([good, Buffer.from("junk")]),
    "no header": Buffer.from("no newline at all"),
    empty: Buffer.alloc(0),
  };
  for (const [name, out] of Object.entries(cases)) {
    assert.throws(() => parseCatFileBatch(out, [OID_A]), Error, name);
  }
  assert.throws(() => parseCatFileBatch(good, [OID_A, OID_B]), /truncated/);
});

test("a key saved as UTF-16 or UTF-32 text is found, in either byte order", () => {
  const text = `token = "${key("live")}"\n`;
  const utf16le = Buffer.from(text, "utf16le");
  const utf16be = Buffer.from(utf16le).swap16();
  const utf32le = Buffer.alloc(text.length * 4);
  for (let i = 0; i < text.length; i += 1) utf32le.writeUInt32LE(text.charCodeAt(i), i * 4);
  const utf32be = Buffer.from(utf32le).swap32();
  for (const [name, buf] of Object.entries({ utf16le, utf16be, utf32le, utf32be })) {
    const found = scanBytes(buf);
    assert.ok(found.some((f) => f.prefix === "pcc_live_" && f.length === 64), name);
  }
  withRepo({ "notes.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]) }, ["notes.txt"], (dir) => {
    const run = runCli(dir);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /notes\.txt:1 \[utf-16\] {2}pcc_live_<64 hex chars, value not printed>/);
    assert.ok(!run.stderr.includes(HEX64));
  });
});

test("--tree scans the commit, so removing a file from the index hides nothing", () => {
  withRepo({ "leak.sh": `K="${key("oracle")}"\n`, "README.md": "ok\n" }, [], (dir) => {
    commitAll(dir, "add files");
    // The round-2 bypass: PR code rewrites the index before the scanner reads it.
    execFileSync("git", ["-C", dir, "update-index", "--force-remove", "leak.sh"]);
    assert.equal(runCli(dir).status, 0); // the index no longer lists it
    const run = runCli(dir, "--tree", "HEAD");
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /leak\.sh:1 {2}pcc_oracle_<64 hex chars, value not printed>/);
  });
});

test("--range finds a key a later commit removed, and a key in a commit message", () => {
  withRepo({ "README.md": "ok\n" }, [], (dir) => {
    const base = commitAll(dir, "base");
    writeFileSync(join(dir, "tmp.env"), `KEY=${key("test")}\n`);
    commitAll(dir, "add a key");
    unlinkSync(join(dir, "tmp.env"));
    commitAll(dir, "remove it again");
    assert.equal(runCli(dir, "--tree", "HEAD").status, 0); // the final tree is clean
    const history = runCli(dir, "--range", `${base}..HEAD`);
    assert.equal(history.status, 1, history.stdout);
    assert.match(history.stderr, /tmp\.env \(object [0-9a-f]{12}\):1 {2}pcc_test_<64 hex chars, value not printed>/);
    assert.ok(!history.stderr.includes(HEX64));

    commitAll(dir, `deploy with ${key("live")}`);
    const message = runCli(dir, "--range", `${base}..HEAD`);
    assert.match(message.stderr, /commit [0-9a-f]{12}:\d+ {2}pcc_live_<64 hex chars, value not printed>/);
  });
});

test("git's own errors are captured and redacted, never passed through", () => {
  const parent = mkdtempSync(join(tmpdir(), "secret-scan-leak-"));
  // Not created: git's own message then quotes this key-bearing path.
  const dir = join(parent, `repo-${key("live")}`);
  try {
    const run = runCli(dir);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /secret-scan: error:/);
    assert.ok(!run.stderr.includes(HEX64) && !run.stdout.includes(HEX64), "a key-bearing path leaked");
    assert.ok(run.stderr.includes("pcc_live_<redacted>"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bad revisions and missing option values are errors (exit 2)", () => {
  withRepo({ "README.md": "ok\n" }, [], (dir) => {
    commitAll(dir, "base");
    for (const args of [["--tree", "no-such-rev"], ["--tree"], ["--range", "HEAD"], ["--range", "HEAD..nope"], ["--tree", "--range"]]) {
      assert.equal(runCli(dir, ...args).status, 2, args.join(" "));
    }
  });
});
