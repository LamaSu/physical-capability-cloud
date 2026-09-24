/**
 * No symlink may be committed under packages/contracts/deployments/.
 *
 * `foundry.toml` grants forge read-write on `deployments/vnext` only. That grant is NOT a containment boundary
 * against symlinks: Foundry authorizes a not-yet-existing path by lexical normalization, so a symlinked
 * directory, a dangling link, or a symlinked `deployments/vnext` itself could redirect a deploy-record write
 * outside it. The deploy script refuses symlinks BELOW the record root at run time
 * (`_assertNoSymlinksUnder`), but it cannot see the root itself. This test closes that gap for anything
 * committed (sol review of PR #339).
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
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
