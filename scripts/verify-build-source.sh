#!/bin/sh
# verify-build-source.sh <commit> <gateway-url | sha256:digest>
#
# Board N5: checks that a running gateway (or a recorded digest) serves the source of <commit>.
# Run it from a clone of this repository that has <commit>. It rebuilds the digested tree of
# that commit with `git archive` and compares its pcc.source-digest/v1 digest with the one the
# gateway reports on /api/health (or the digest given). With a URL it also checks that the
# gateway's recorded build commit is <commit>.
#
# What a match proves: the image was built from exactly that commit's source files in the
# digest's scope (see scripts/source-digest.sh). What it cannot prove: anything against whoever
# controls the deployment, who can change the image's files or mounts (docs/DEPLOY.md).
set -eu
commit="${1:?usage: verify-build-source.sh <commit> <gateway-url | sha256:digest>}"
target="${2:?usage: verify-build-source.sh <commit> <gateway-url | sha256:digest>}"
here="$(cd "$(dirname "$0")" && pwd)"

full="$(git rev-parse --verify --quiet "${commit}^{commit}")" || { echo "verify: $commit is not a commit in this clone" >&2; exit 2; }
tmp="${TMPDIR:-/tmp}/pcc-verify-source.$$"
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp"
git archive "$full" -- packages apps docs package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json Dockerfile .dockerignore \
  | tar -x -C "$tmp"
expected="$(sh "$here/source-digest.sh" "$tmp")"

case "$target" in
  sha256:*)
    served="$target"
    check_commit=0
    ;;
  http://* | https://*)
    body="$(curl -fsS "${target%/}/api/health")"
    served="$(printf '%s' "$body" | sed -n 's/.*"sourceDigest":"\(sha256:[0-9a-f]\{64\}\)".*/\1/p')"
    served_commit="$(printf '%s' "$body" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')"
    check_commit=1
    [ -n "$served" ] || { echo "verify: $target reports no sourceDigest" >&2; exit 1; }
    ;;
  *)
    echo "verify: the second argument must be a gateway URL or a sha256: digest" >&2
    exit 2
    ;;
esac

status=0
if [ "$served" = "$expected" ]; then
  echo "source MATCHES $full ($expected)"
else
  echo "source DIFFERS: $full is $expected, served is $served" >&2
  status=1
fi
if [ "$check_commit" -eq 1 ]; then
  if [ "$served_commit" = "$full" ]; then
    echo "recorded commit MATCHES $full"
  else
    echo "recorded commit DIFFERS: served ${served_commit:-none}, expected $full" >&2
    status=1
  fi
fi
exit "$status"
