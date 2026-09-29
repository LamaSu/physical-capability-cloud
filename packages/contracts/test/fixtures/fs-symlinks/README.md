# Symlink fixtures for the V-next deploy record checks

`VNextDeployRecordTest` points `DeployVNextSettlement`'s record-root checks at these committed trees, so the
checks are tested without any test creating a link. `foundry.toml` grants READ on each fixture root separately
and on nothing wider. A grant on a directory above `roots/link` would authorize the probe path under it by its
lexical form, and the symlinked-root case would pass unseen.

| Path | What it holds | Expected |
|---|---|---|
| `walk/clean` | real files only, three levels deep | the walk passes |
| `walk/dir-link` | `parent-link -> real`, a symlinked directory | refused, naming `parent-link` |
| `walk/dangling` | `dangling.json -> does-not-exist.json`, a dangling link | refused, naming `dangling.json` |
| `walk/deep` | `a/b/c/d/deep-link -> ../../../../README.md`, five levels down | refused; a depth-3 walk missed it |
| `walk/no-such-dir` | nothing (granted through `walk`) | refused: an entry forge could not inspect |
| `roots/real` | a real directory | passes |
| `roots/link` | `link -> real`: the root itself is a symlink | refused |
| `roots/parent-link/root` | `parent-link -> parent-real`: a directory ABOVE the root is a symlink | refused |
| `roots/dangling` | `dangling -> missing` | refused: not a directory |
| `roots/absent` | nothing (granted, never created) | refused: not a directory |
| `roots/planted-link` | `planted-link -> planted-real`, whose target holds a file at the probe path | refused: the probe exists |

A checkout without symlink support (git `core.symlinks=false`) turns each link into a small text file. The
tests then skip, because the property is untestable there, not false. CI runs on Linux, which has real links.
