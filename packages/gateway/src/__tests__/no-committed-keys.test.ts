/**
 * WP-A fold F8 (refvertical #2586 B): no PCC key literal is committed to the
 * public repository's scripts or docs.
 *
 * A live `pcc_live_` API key and a `pcc_oracle_` key sat in plaintext in
 * scripts/hp-full-chain-e2e.ts, scripts/real-e2e.ts, scripts/real-e2e-verbose.ts
 * and scripts/smoke-digital-verifier.sh. The scripts now read PCC_API_KEY /
 * PCC_ORACLE_KEY from the environment. This guard fails if a real-looking key
 * (`pcc_live_|pcc_test_|pcc_oracle_` + at least 32 key characters) appears
 * again under scripts/, docs/ or the repository root.
 *
 * On failure it reports file:line and the SHA-256 prefix only — NEVER the value.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// Real keys are prefix + 64 characters; test fixtures in this repo are far
// shorter (e.g. "pcc_live_abc123..."), so 32 separates them cleanly.
const KEY_RE = /pcc_(?:live|test|oracle)_[0-9A-Za-z]{32,}/g;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo", "coverage"]);
const MAX_BYTES = 2_000_000;

function filesUnder(dir: string, recursive: boolean): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKIP_DIRS.has(entry.name)) out = out.concat(filesUnder(p, true));
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function findings(files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (statSync(f).size > MAX_BYTES) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(KEY_RE)) {
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      const prefix = createHash("sha256").update(m[0]).digest("hex").slice(0, 12);
      hits.push(`${f.slice(REPO_ROOT.length)}:${line} sha256:${prefix}`);
    }
  }
  return hits;
}

describe("F8 — no PCC key literals in the public repo", () => {
  it("scripts/ holds no key literal (they read PCC_API_KEY / PCC_ORACLE_KEY from env)", () => {
    expect(findings(filesUnder(join(REPO_ROOT, "scripts"), true))).toEqual([]);
  });

  it("docs/ and the repository root hold no key literal", () => {
    const files = [...filesUnder(join(REPO_ROOT, "docs"), true), ...filesUnder(REPO_ROOT, false)];
    expect(findings(files)).toEqual([]);
  });

  it("the detector itself flags a real-looking key and spares short fixtures", () => {
    const fake = "pcc_live_" + "0123456789abcdef".repeat(4);
    expect(fake.match(KEY_RE)).toHaveLength(1);
    expect("pcc_live_abc123def456".match(KEY_RE)).toBeNull();
  });
});
