#!/bin/sh
# source-digest.sh <tree-root>: print the pcc.source-digest/v1 digest of a PCC source tree.
#
# Board N5. The digest binds GET /api/health to the source an image was built from:
#   - the Dockerfile runs this over the build context right after `COPY . .`, before anything
#     is built, and records the result in /app/BUILD_INFO.json;
#   - CI runs it over its checkout of github.sha and refuses to push an image whose recorded
#     digest differs;
#   - scripts/verify-build-source.sh runs it over `git archive <commit>` so anyone can check a
#     running gateway against a commit.
#
# pcc.source-digest/v1:
#   scope     packages/ apps/ docs/ and the root build files package.json pnpm-lock.yaml
#             pnpm-workspace.yaml turbo.json tsconfig.base.json Dockerfile .dockerignore
#   excluded  any node_modules, dist or .git entry, and packages/contracts/{out,cache,lib}
#             (the same exclusions .dockerignore applies inside that scope)
#   files     regular files only (symlinks are not followed); content only (no modes, times)
#   digest    "sha256:" + sha256 of the `sha256sum` lines ("<hex>  <relative path>") of every
#             file, in byte order of their paths (LC_ALL=C)
set -eu
root="${1:?usage: source-digest.sh <tree-root>}"
cd "$root"
for p in packages apps docs package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json Dockerfile .dockerignore; do
  [ -e "$p" ] || { echo "source-digest: $root has no $p" >&2; exit 1; }
done
digest="$(
  find packages apps docs package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json Dockerfile .dockerignore \
    \( -name node_modules -o -name dist -o -name .git \
       -o -path packages/contracts/out -o -path packages/contracts/cache -o -path packages/contracts/lib \) -prune \
    -o -type f -print0 \
  | LC_ALL=C sort -z \
  | xargs -0 -r sha256sum \
  | sha256sum | cut -d' ' -f1
)"
case "$digest" in
  *[!0-9a-f]* | "") echo "source-digest: could not compute a digest" >&2; exit 1 ;;
esac
[ "${#digest}" -eq 64 ] || { echo "source-digest: could not compute a digest" >&2; exit 1; }
printf 'sha256:%s\n' "$digest"
