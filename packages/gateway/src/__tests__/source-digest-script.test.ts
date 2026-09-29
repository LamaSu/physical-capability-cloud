import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// N5 (astra round 2): the build commit is a build argument's claim, so /api/health also
// reports a digest of the source the image was built from. scripts/source-digest.sh defines
// it (pcc.source-digest/v1); the Dockerfile, CI and scripts/verify-build-source.sh all run
// that one script. These tests pin the spec: what it covers, what it excludes (the same
// exclusions .dockerignore applies inside its scope), that it matches an independent
// implementation, and that the verifier accepts the right commit and refuses any other.

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const DIGEST_SH = join(REPO, "scripts/source-digest.sh");
const VERIFY_SH = join(REPO, "scripts/verify-build-source.sh");
const SCOPE = ["packages", "apps", "docs", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "tsconfig.base.json"];

function tree(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pcc-src-digest-"));
  const files: Record<string, string> = {
    "package.json": '{"name":"pcc"}\n',
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "pnpm-workspace.yaml": "packages: ['packages/*']\n",
    "turbo.json": "{}\n",
    "tsconfig.base.json": "{}\n",
    "packages/gateway/src/server.ts": "export const a = 1;\n",
    "packages/gateway/package.json": '{"name":"@pcc/gateway"}\n',
    "apps/dashboard/index.html": "<html></html>\n",
    "docs/DEPLOY.md": "# deploy\n",
    ...extra,
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

const digestOf = (root: string) => execFileSync("sh", [DIGEST_SH, root], { encoding: "utf8" }).trim();

/** An independent implementation of pcc.source-digest/v1 (not the script). */
function independentDigest(root: string): string {
  const pruneNames = new Set(["node_modules", "dist", ".git"]);
  const prunePaths = new Set(["packages/contracts/out", "packages/contracts/cache", "packages/contracts/lib"]);
  const files: string[] = [];
  const walk = (rel: string) => {
    const base = rel.split("/").pop()!;
    if (pruneNames.has(base) || prunePaths.has(rel)) return;
    const st = lstatSync(join(root, rel));
    if (st.isDirectory()) for (const e of readdirSync(join(root, rel))) walk(`${rel}/${e}`);
    else if (st.isFile()) files.push(rel);
  };
  for (const s of SCOPE) walk(s);
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const listing = files.map((f) => `${createHash("sha256").update(readFileSync(join(root, f))).digest("hex")}  ${f}\n`).join("");
  return `sha256:${createHash("sha256").update(listing).digest("hex")}`;
}

describe("scripts/source-digest.sh (pcc.source-digest/v1)", () => {
  it("prints sha256:<64 hex>, is deterministic, and matches an independent implementation", () => {
    const a = tree();
    const b = tree();
    expect(digestOf(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOf(a)).toBe(digestOf(b));
    expect(digestOf(a)).toBe(independentDigest(a));
  });

  it("changes when any in-scope file's content, name or presence changes", () => {
    const base = digestOf(tree());
    expect(digestOf(tree({ "packages/gateway/src/server.ts": "export const a = 2;\n" }))).not.toBe(base);
    expect(digestOf(tree({ "packages/gateway/src/extra.ts": "" }))).not.toBe(base);
    expect(digestOf(tree({ "docs/other.md": "x" }))).not.toBe(base);
    expect(digestOf(tree({ "pnpm-lock.yaml": "lockfileVersion: 10\n" }))).not.toBe(base);
    const renamed = tree();
    renameSync(join(renamed, "packages/gateway/src/server.ts"), join(renamed, "packages/gateway/src/server2.ts"));
    expect(digestOf(renamed)).not.toBe(base);
  });

  it("NEGATIVE: build outputs, installs, git data and files outside the scope never change it", () => {
    const base = digestOf(tree());
    const noisy = tree({
      "node_modules/x/index.js": "1",
      "packages/gateway/node_modules/y/index.js": "2",
      "packages/gateway/dist/server.js": "3",
      "apps/dashboard/dist/index.html": "4",
      "packages/contracts/out/A.json": "5",
      "packages/contracts/cache/c": "6",
      "packages/contracts/lib/forge-std/.git": "gitdir: x",
      "packages/some/.git/HEAD": "ref",
      "scripts/tool.sh": "7",
      "README.md": "8",
      "vendor/lib/a.c": "9",
    });
    expect(digestOf(noisy)).toBe(base);
    expect(independentDigest(noisy)).toBe(base);
  });

  it("NEGATIVE: a tree without its scope is refused, never digested as empty", () => {
    const t = tree();
    rmSync(join(t, "docs"), { recursive: true });
    const r = spawnSync("sh", [DIGEST_SH, t], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has no docs/);
  });

  it("its exclusions are exactly the .dockerignore patterns that reach its scope (the two cannot drift)", () => {
    const patterns = readFileSync(join(REPO, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    const inScope = patterns.filter(
      (p) => p.startsWith("**/") || SCOPE.some((s) => p === s || p.startsWith(`${s}/`)),
    );
    const script = readFileSync(DIGEST_SH, "utf8");
    const names = [...script.matchAll(/-name (\S+)/g)].map((m) => m[1]);
    const paths = [...script.matchAll(/-path (\S+)/g)].map((m) => m[1]);
    for (const p of inScope) {
      const covered = p.startsWith("**/") ? names.includes(p.slice(3)) : paths.includes(p);
      expect(covered, `.dockerignore ${p} must be excluded by source-digest.sh`).toBe(true);
    }
    expect(inScope.length).toBeGreaterThan(0);
  });
});

describe("scripts/verify-build-source.sh", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

  function repoWith(t: string): string {
    git(t, "init", "-q");
    git(t, "add", "-A");
    git(t, "commit", "-q", "-m", "c1");
    return git(t, "rev-parse", "HEAD");
  }

  it("accepts the digest of the commit's source and refuses any other digest or commit", () => {
    const t = tree();
    const sha = repoWith(t);
    const good = digestOf(t);
    const ok = spawnSync("sh", [VERIFY_SH, sha, good], { cwd: t, encoding: "utf8", env: { ...process.env, TMPDIR: tmpdir() } });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/source MATCHES/);

    const bad = spawnSync("sh", [VERIFY_SH, sha, `sha256:${"0".repeat(64)}`], { cwd: t, encoding: "utf8", env: { ...process.env, TMPDIR: tmpdir() } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/source DIFFERS/);

    // A later commit changes the source: the old image's digest no longer verifies against it.
    writeFileSync(join(t, "packages/gateway/src/server.ts"), "export const a = 3;\n");
    git(t, "commit", "-q", "-am", "c2");
    const sha2 = git(t, "rev-parse", "HEAD");
    const stale = spawnSync("sh", [VERIFY_SH, sha2, good], { cwd: t, encoding: "utf8", env: { ...process.env, TMPDIR: tmpdir() } });
    expect(stale.status).toBe(1);

    const missing = spawnSync("sh", [VERIFY_SH, "f".repeat(40), good], { cwd: t, encoding: "utf8", env: { ...process.env, TMPDIR: tmpdir() } });
    expect(missing.status).toBe(2);
  });

  it("NEGATIVE: files a build context has but the commit does not (a dirty tree) make the digest differ", () => {
    const t = tree();
    const sha = repoWith(t);
    writeFileSync(join(t, "packages/gateway/src/local-only.ts"), "untracked\n");
    const dirty = digestOf(t);
    const r = spawnSync("sh", [VERIFY_SH, sha, dirty], { cwd: t, encoding: "utf8", env: { ...process.env, TMPDIR: tmpdir() } });
    expect(r.status).toBe(1);
  });
});
