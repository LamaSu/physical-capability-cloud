/**
 * No symlink may be committed under packages/contracts/deployments/.
 *
 * `foundry.toml` grants forge read-write on `deployments/vnext` only. That grant is NOT a containment boundary
 * against symlinks: Foundry authorizes a not-yet-existing path by lexical normalization, so a symlinked
 * directory, a dangling link, or a symlinked `deployments/vnext` itself could redirect a deploy-record write
 * outside it. The deploy script refuses all of these at run time, in the checkout it actually runs in
 * (`_assertRecordRootContained`: the root, every directory above it, and the whole tree below it; astra review of
 * PR #339). This test is the second line for anything COMMITTED: it fails the PR that adds such a link, before any
 * deploy runs (sol review of PR #339).
 */
import { lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DEPLOYMENTS = fileURLToPath(new URL("../../deployments", import.meta.url));

/** Every symlink at or below `dir`. Links are reported, never followed. */
function symlinksUnder(dir: string): string[] {
  const found: string[] = [];
  if (lstatSync(dir).isSymbolicLink()) return [dir];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) found.push(p);
    else if (st.isDirectory()) found.push(...symlinksUnder(p));
  }
  return found;
}

/**
 * The forge record tests (test/VNextDeployRecord.t.sol) need these committed fixture links to BE links. This checks
 * them with lstat, independently of forge, so a checkout that lost them fails here even if forge also stopped
 * reporting them (astra round 2 on #339). A checkout without symlink support sets PCC_NO_SYMLINK_FIXTURES=1 to skip
 * this, the same explicit opt-out the forge tests honour. CI never sets it.
 */
const FIXTURES = fileURLToPath(new URL("../../test/fixtures/fs-symlinks", import.meta.url));
const FIXTURE_LINKS: Record<string, string> = {
  "walk/dir-link/parent-link": "real",
  "walk/dangling/dangling.json": "does-not-exist.json",
  "walk/deep/a/b/c/d/deep-link": "../../../../README.md",
  "roots/link": "real",
  "roots/parent-link": "parent-real",
  "roots/dangling": "missing",
  "roots/planted-link": "planted-real",
};

describe.skipIf(process.env.PCC_NO_SYMLINK_FIXTURES === "1")("forge symlink fixtures", () => {
  it("are real symlinks with their committed targets", () => {
    const wrong = Object.entries(FIXTURE_LINKS).filter(([rel, target]) => {
      const p = join(FIXTURES, rel);
      return !lstatSync(p).isSymbolicLink() || readlinkSync(p) !== target;
    });
    expect(wrong.map(([rel]) => rel)).toEqual([]);
  });
});

describe("deployment records", () => {
  it("contain no symlinks: one would let a deploy-record write escape the forge fs grant", () => {
    expect(symlinksUnder(DEPLOYMENTS)).toEqual([]);
  });

  it("the check sees symlinked directories, dangling links and a symlinked root", () => {
    const base = mkdtempSync(join(tmpdir(), "pcc-deploy-symlinks-"));
    try {
      const root = join(base, "deployments");
      mkdirSync(join(root, "vnext", "anvil"), { recursive: true });
      writeFileSync(join(root, "vnext", "anvil", "CANONICAL.json"), "{}");
      expect(symlinksUnder(root)).toEqual([]);

      symlinkSync(join(base, "elsewhere"), join(root, "vnext", "linked-dir"));
      symlinkSync("does-not-exist.json", join(root, "vnext", "anvil", "dangling.json"));
      expect(symlinksUnder(root).sort()).toEqual(
        [join(root, "vnext", "anvil", "dangling.json"), join(root, "vnext", "linked-dir")].sort(),
      );

      symlinkSync(join(root, "vnext"), join(base, "linked-root"));
      expect(symlinksUnder(join(base, "linked-root"))).toEqual([join(base, "linked-root")]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
