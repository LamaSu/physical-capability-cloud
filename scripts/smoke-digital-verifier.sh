#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# smoke-digital-verifier.sh — 6-check smoke test for digital-verifier/foundation
#
# UNSUPPORTED: direct invocation. FC-8 round 5 (astra pack 61d, finding 4's
# closure): the supported entry point is `node scripts/smoke-digital-verifier.mjs`,
# which execs this script with an EXPLICIT environment allowlist — never the
# caller's PS4, SHELLOPTS, BASHOPTS, BASH_ENV, ENV, BASH_XTRACEFD, or
# PCC_ORACLE_KEY. Running this file directly inherits whatever tracing state
# and environment the calling shell already has, which this script cannot
# see or clear before its own first statement executes (see the threat-model
# comment below) — that residual is exactly what the launcher closes. This
# script's own `set +x` and the PCC_ORACLE_KEY_FILE convention stay as
# defense in depth; they are not, on their own, the supported boundary.
#
# Usage:
#   cd /path/to/physical-capability-cloud
#   node scripts/smoke-digital-verifier.mjs
#
# Requirements: git, curl, jq, gh (GitHub CLI)
# ─────────────────────────────────────────────────────────────────────────────

# FC-8 round 4 (astra pack 61c, finding 4 — the steward's ruling, bus #6482):
# `set +x` is the ABSOLUTE FIRST statement in this script — before even
# `set -euo pipefail` — and the oracle key is read from a FILE, never an
# env var. Both are necessary together; neither alone closes the finding.
#
# THREAT MODEL. Astra's reproduction:
#   env PCC_ORACLE_KEY='SECRET' PS4='$PCC_ORACLE_KEY ' bash -x script.sh
# Bash expands PS4 to build the trace line for EVERY traced command when
# xtrace is on — including the trace of this script's own first statement,
# which is emitted using whatever PS4/xtrace state the CALLER already had
# active, before this script has executed anything at all. So no command
# this script runs, however early, can retroactively un-trace its own first
# statement: round 2's `set +x` (previously the first REAL command, after
# `set -euo pipefail`) still left that one earlier statement — and `set +x`
# itself — traced under a hostile inherited PS4. Moving `set +x` earlier
# shrinks that window to a single, irreducible trace event (this line);
# nothing placed before it inside this script could shrink it further.
#
# What reading the key from a FILE narrows: this script itself never reads
# PCC_ORACLE_KEY (the secret value) into its own logic — only
# PCC_ORACLE_KEY_FILE, a file PATH, which is not a secret. Astra's exact
# recipe (`PS4='$PCC_ORACLE_KEY '`, a bare variable reference, no command
# substitution) expands to nothing IF PCC_ORACLE_KEY is not present in the
# environment this script is invoked from.
#
# FC-8 round 5: the residual below is now CLOSED by the launcher
# (scripts/smoke-digital-verifier.mjs), which execs this script with a
# process-boundary environment it builds itself — not by anything this
# script could do to itself. Direct invocation (bypassing the launcher)
# reopens exactly this residual, which is why direct invocation is
# unsupported (see the header above). Kept verbatim as the accurate
# description of what direct invocation still exposes:
#   1. If something ELSE upstream of this script (a sibling script, a
#      Makefile, a CI job, a lingering shell export from before this fix
#      rolled out) still sets PCC_ORACLE_KEY in the environment for its own
#      reasons, astra's exact bare-variable PS4 recipe leaks it on that one
#      irreducible trace event (this script's own first statement, traced
#      under whatever PS4/xtrace state the CALLER already had active,
#      before this script has executed anything at all — no command this
#      script runs, however early, can retroactively un-trace its own first
#      statement). This script can verify its OWN code never reads the
#      variable; it cannot verify, or control, what else in the environment
#      sets it.
#   2. A PS4 that already knows the exact value of $PCC_ORACLE_KEY_FILE and
#      runs `$(cat "$PCC_ORACLE_KEY_FILE" 2>/dev/null)` can read the key on
#      that same one trace event, since the file's contents exist on disk
#      before this script starts, independent of anything this script does.
# Both residuals are the same shape: one irreducible trace event, closed
# only by a process boundary this script cannot construct for itself. The
# launcher IS that process boundary: it clears PCC_ORACLE_KEY, PS4, and
# every other tracing control from the environment it builds BEFORE
# executing this script, so there is nothing hostile left to expand.
set +x
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
REPO="global-mysterysnailrevolution/physical-capability-cloud"
BRANCH="digital-verifier/foundation"
GW="https://capability.network"
ORACLE_TUNNEL="https://refer-proxy-joint-cleaning.trycloudflare.com"
ORACLE_DIRECT="${ORACLE_DIRECT:-http://localhost:4100}"
# FC-8 round 5: the rule for every PUBLIC chain/git identifier this script
# prints (a commit SHA) — the bash-side equivalent of redact-log.ts's
# PUBLIC_ID_RULE / publicIdForLog. Same default, same one-line flip later.
PUBLIC_ID_RULE="fingerprint"
# FC-8 round 4: read from a FILE, never an env var — see the threat-model
# comment above. Keys are NEVER committed to this repository (WP-A fold F8:
# the literal that used to sit here was exposed and is listed for
# revocation in docs/security/WILDCARD_KEY_ROTATION.md). This REPLACES
# N44's direct-value env-var read of the oracle key (a bare "${VAR:-}" on
# the same name, minus the _FILE suffix): the N44 merge adopts FC-8's
# key-FILE contract instead, per the steward's ruling.
if [ -z "${PCC_ORACLE_KEY_FILE:-}" ]; then
  echo "PCC_ORACLE_KEY_FILE is not set: export the path to a file containing the oracle's x-oracle-key before running this script (FC-8 round 4: the key itself is never read from an environment variable). Keys are never committed to this repository." >&2
  exit 1
fi
# FC-8 round 5: env-derived PATHS are never printed, not even in an error
# diagnostic — presence/outcome only (the three messages below used to
# interpolate "$PCC_ORACLE_KEY_FILE" directly).
if [ ! -r "$PCC_ORACLE_KEY_FILE" ]; then
  echo "PCC_ORACLE_KEY_FILE is set but the file does not exist or is not readable (path withheld)." >&2
  exit 1
fi
ORACLE_KEY="$(cat "$PCC_ORACLE_KEY_FILE")"
if [ -z "$ORACLE_KEY" ]; then
  echo "PCC_ORACLE_KEY_FILE is set and readable but empty (path withheld)." >&2
  exit 1
fi
REPORT_FILE="ai/supervisor/smoke-test-report.json"

# ── State ───────────────────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
CHECKS_JSON="[]"
START_TIME=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")
COMMIT_SHA=""

# ── Helpers ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# N44: every line the script prints about a response goes through say(), which
# prints sanitize()'s text with %s. Only the colour constants are interpreted.
say() {
  printf '  %b%s%b %s\n' "$1" "$2" "$NC" "$(sanitize "$3")"
}

# N44 (round 5): what say() prints. It strips control characters: escape
# sequences, carriage returns, every other byte below 0x20 except tab and
# newline, and DEL. Stripping can JOIN what was split ("pcc_" "live_" + CR +
# hex is no key until the CR is gone), so the text is redacted AFTER the strip.
# It is also redacted before it, so nothing key-shaped passes either step.
sanitize() {
  redact "$(redact "$1" | LC_ALL=C tr -d '\000-\010\013-\037\177')"
}

# N44 (round 5): every response body is read through this pipe. NUL bytes become
# SOH (0x01) before bash sees them, so bash never drops one silently (or prints
# its "ignored null byte" warning, which would bypass say()), and a body that
# held one is not valid JSON, which json_object_where refuses outright.
nul_safe() {
  LC_ALL=C tr '\000' '\001'
}

pass() {
  say "$GREEN" PASS "$1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  say "$RED" FAIL "$1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

skip() {
  say "$YELLOW" SKIP "$1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

info() {
  say "$CYAN" INFO "$1"
}

# N44: strip PCC key material from anything printed or written to the report.
redact() {
  printf '%s' "$1" | sed -E 's/([Pp][Cc][Cc]_([Ll][Ii][Vv][Ee]|[Tt][Ee][Ss][Tt]|[Oo][Rr][Aa][Cc][Ll][Ee])_)[0-9A-Fa-f]+/\1<redacted>/g'
}

# N44: one HTTP request, judged by what came back. Sets HTTP_STATUS to the
# status code, or to "transport-error" when curl failed at any point (even
# after part of a body arrived), and HTTP_BODY to the body (a NUL byte in it
# arrives as SOH, see nul_safe). curl's own messages are discarded, never
# printed, and no temporary file is written. pipefail (set above) makes a curl
# failure the pipeline's failure.
http_request() {
  local out rc=0
  out=$(curl -sS "$@" -w '\n%{http_code}' 2>/dev/null | nul_safe) || rc=$?
  if [ "$rc" -ne 0 ]; then
    HTTP_STATUS="transport-error"
    HTTP_BODY=""
  else
    HTTP_STATUS="${out##*$'\n'}"
    HTTP_BODY="${out%$'\n'*}"
  fi
}

# N44: succeeds only when HTTP_BODY is exactly one JSON object (not empty, not
# two documents, no trailing bytes, no NUL byte anywhere) for which the jq
# condition $1 holds. A body that held a NUL holds SOH here (nul_safe), and no
# valid JSON holds a raw SOH, so it is refused before jq sees it.
json_object_where() {
  case "$HTTP_BODY" in *$'\001'*) return 1 ;; esac
  printf '%s' "$HTTP_BODY" | jq -e -s "length == 1 and (.[0] | type) == \"object\" and (.[0] | $1)" >/dev/null 2>&1
}

# The value of jq path $1 in HTTP_BODY's single object (after json_object_where).
json_field() {
  printf '%s' "$HTTP_BODY" | jq -r -s ".[0] | $1" 2>/dev/null || true
}

# FC-8 round 3 (astra pack 61b census closure): a gateway/oracle-derived
# string must be VALIDATED before it is printed or written to the report —
# an allow-listed enum, or a literal boolean — never the raw response.
# (Computed counts, e.g. `jq '.x | length'`, are not wrapped here: a jq
# `length` is structurally always a non-negative integer or the `|| echo`
# fallback, so there is no dynamic path for it to carry anything else.)
safe_enum() {
  # $1=value, $2..=allowed literals
  local v="$1"; shift
  for allowed in "$@"; do
    if [ "$v" = "$allowed" ]; then echo "$v"; return; fi
  done
  echo "(unknown)"
}

safe_bool() {
  case "$1" in
    true|false) echo "$1" ;;
    *) echo "(unknown)" ;;
  esac
}

# FC-8 round 5: a small, bounded, non-negative integer (a PR number) safe
# to log as-is; anything non-numeric or implausibly long → fallback. The
# bash-side equivalent of redact-log.ts's safeLogInt.
safe_int() {
  case "$1" in
    ''|*[!0-9]*) echo "(none)" ;;
    *) if [ "${#1}" -le 10 ]; then echo "$1"; else echo "(none)"; fi ;;
  esac
}

# FC-8 round 5: the bash-side equivalent of redact-log.ts's
# publicIdForLog(value, kind) — the ONE function for every PUBLIC chain/git
# identifier this script handles (a commit SHA). Shape-validates first (a
# full git SHA-1 is exactly 40 hex characters); anything that fails that
# check prints "(invalid)", a missing value prints "(none)". A value that
# passes is then logged per PUBLIC_ID_RULE above: fingerprinted (default,
# via sha256sum) or, once the lane flips that one variable, verbatim.
public_id_for_log() {
  # $1=value, $2=kind ("commit_sha")
  local v="$1" kind="$2"
  if [ -z "$v" ]; then echo "(none)"; return; fi
  case "$kind" in
    commit_sha)
      if ! [[ "$v" =~ ^[0-9a-f]{40}$ ]]; then echo "(invalid)"; return; fi
      ;;
    *)
      echo "(invalid)"; return
      ;;
  esac
  if [ "$PUBLIC_ID_RULE" = "verbatim" ]; then
    echo "$v"
  else
    echo "id:$(printf '%s' "$v" | sha256sum | cut -c1-12)"
  fi
}

# FC-8 round 5b (steward ruling #6712, DECISIONS 00:53): the bash-side
# equivalent of redact-log.ts's publicChainRef(value, kind) — a PUBLIC
# CHAIN value (a tx hash, an address, an event topic) prints VERBATIM once
# its shape is validated. Unlike public_id_for_log above (git/GitHub ids),
# there is no PUBLIC_ID_RULE-style gate and no fingerprint mode: a
# shape-valid chain value is ALWAYS verbatim here, per the ruling. This
# script has no live tx-hash/address call site today (it is a CI/deploy
# smoke test, not an on-chain script — see the three TS e2e scripts for
# that) but gets the same primitive for parity with redact-log.ts and for
# whenever one is added; kept to the same shape-first, never-exits-nonzero
# contract as every other helper in this file. A git/GitHub identifier
# (a commit SHA, a run id) is NOT a chain value under the ruling's own
# wording and must stay on public_id_for_log, never this function — it has
# no "0x" prefix, so routing one here always prints "(invalid)" rather
# than leaking it, but the real risk the ruling is guarding against is
# copy-paste drift routing the WRONG field through the wrong function.
public_chain_ref() {
  # $1=value, $2=kind ("tx"|"topic"|"address")
  local v="$1" kind="$2"
  if [ -z "$v" ]; then echo "(invalid)"; return; fi
  case "$kind" in
    tx|topic)
      if ! [[ "$v" =~ ^0x[0-9a-fA-F]{64}$ ]]; then echo "(invalid)"; return; fi
      ;;
    address)
      if ! [[ "$v" =~ ^0x[0-9a-fA-F]{40}$ ]]; then echo "(invalid)"; return; fi
      ;;
    *)
      echo "(invalid)"; return
      ;;
  esac
  echo "$v"
}

add_check() {
  # $1=name, $2=status, $3=details, $4=durationMs
  CHECKS_JSON=$(echo "$CHECKS_JSON" | jq \
    --arg name "$1" \
    --arg status "$2" \
    --arg details "$(redact "$3")" \
    --argjson duration "$4" \
    '. + [{"name": $name, "status": $status, "details": $details, "durationMs": $duration}]')
}

millis() {
  date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))"
}

echo ""
echo "======================================================================="
echo " PCC Digital Verifier -- Smoke Test"
echo " Branch: $BRANCH"
echo " Gateway: $GW"
echo " Started: $(date -Iseconds 2>/dev/null || date)"
echo "======================================================================="
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 1: Git push succeeded
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Check 1: Git Push -------------------------------------------------"
T0=$(millis)

LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
COMMIT_SHA="$LOCAL_SHA"
# FC-8 round 5: a commit SHA is a PUBLIC GIT IDENTIFIER — through
# public_id_for_log, never printed raw (round 4 printed $LOCAL_SHA/
# $REMOTE_SHA/$COMMIT_SHA directly in several lines below and in the
# summary/report at the bottom of this script).
LOCAL_SHA_LOG=$(public_id_for_log "$LOCAL_SHA" commit_sha)
if [ -z "$LOCAL_SHA" ]; then
  fail "Not in a git repo or HEAD unresolvable"
  add_check "git-push" "FAIL" "Not in a git repo" 0
else
  REMOTE_SHA=$(git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1 || echo "")
  REMOTE_SHA_LOG=$(public_id_for_log "$REMOTE_SHA" commit_sha)
  T1=$(millis)
  DURATION=$((T1 - T0))

  if [ -z "$REMOTE_SHA" ]; then
    fail "Branch $BRANCH not found on remote 'origin'"
    add_check "git-push" "FAIL" "Branch not found on remote" "$DURATION"
  elif [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    pass "Local HEAD $LOCAL_SHA_LOG matches remote"
    add_check "git-push" "PASS" "SHA match: $LOCAL_SHA_LOG" "$DURATION"
  else
    fail "Local ($LOCAL_SHA_LOG) != Remote ($REMOTE_SHA_LOG)"
    add_check "git-push" "FAIL" "Local $LOCAL_SHA_LOG != Remote $REMOTE_SHA_LOG" "$DURATION"
  fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 2: CI Green
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Check 2: CI Status ------------------------------------------------"
T0=$(millis)

# Try to find a PR for this branch first
PR_NUM=$(gh pr list --repo "$REPO" --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")

if [ -n "$PR_NUM" ] && [ "$PR_NUM" != "null" ]; then
  info "Found PR #$(safe_int "$PR_NUM") for branch $BRANCH"

  # Get check results
  CI_RESULT=$(gh pr checks "$PR_NUM" --repo "$REPO" 2>/dev/null || echo "ERROR")
  T1=$(millis)
  DURATION=$((T1 - T0))

  if echo "$CI_RESULT" | grep -q "ERROR"; then
    skip "Could not fetch PR checks (gh auth or network issue)"
    add_check "ci-green" "SKIP" "gh pr checks failed" "$DURATION"
  elif echo "$CI_RESULT" | grep -qi "pending\|in_progress\|queued"; then
    info "CI still running -- checks in progress"
    skip "CI in progress (check again in a few minutes)"
    add_check "ci-green" "PENDING" "CI still running" "$DURATION"
  elif echo "$CI_RESULT" | grep -qi "fail"; then
    # FC-8 round 5: never print the raw `gh pr checks` output (check names,
    # URLs) — a bounded COUNT of failing lines only.
    FAILED_COUNT=$(echo "$CI_RESULT" | grep -ci "fail" || true)
    fail "CI has $(safe_int "$FAILED_COUNT") failing check(s) (raw gh output withheld)"
    add_check "ci-green" "FAIL" "Failing checks detected" "$DURATION"
  else
    pass "All CI checks passing"
    add_check "ci-green" "PASS" "All checks green on PR #$(safe_int "$PR_NUM")" "$DURATION"
  fi
else
  # No PR -- check workflow runs directly
  info "No PR found for $BRANCH. Checking workflow runs..."
  RUN_DATA=$(gh api "repos/$REPO/actions/runs?branch=$BRANCH&per_page=1" \
    --jq '.workflow_runs[0] | {status, conclusion, id, name}' 2>/dev/null || echo "")
  T1=$(millis)
  DURATION=$((T1 - T0))

  if [ -z "$RUN_DATA" ] || [ "$RUN_DATA" = "null" ]; then
    skip "No workflow runs found for branch $BRANCH"
    add_check "ci-green" "SKIP" "No workflow runs found" "$DURATION"
  else
    # FC-8 round 5: status/conclusion are RESPONSE STATUS-LIKE fields — a
    # closed enum through safe_enum, never the raw jq output (round 4
    # printed $RUN_STATUS/$RUN_CONCLUSION straight from `jq -r`, unvalidated).
    RUN_STATUS=$(safe_enum "$(echo "$RUN_DATA" | jq -r .status 2>/dev/null || echo "")" queued in_progress completed)
    RUN_CONCLUSION=$(safe_enum "$(echo "$RUN_DATA" | jq -r .conclusion 2>/dev/null || echo "")" success failure cancelled skipped timed_out action_required neutral stale null)

    if [ "$RUN_STATUS" = "completed" ] && [ "$RUN_CONCLUSION" = "success" ]; then
      pass "Latest workflow run succeeded"
      add_check "ci-green" "PASS" "Workflow run completed successfully" "$DURATION"
    elif [ "$RUN_STATUS" = "in_progress" ] || [ "$RUN_STATUS" = "queued" ]; then
      skip "CI in progress ($RUN_STATUS)"
      add_check "ci-green" "PENDING" "Workflow $RUN_STATUS" "$DURATION"
    else
      fail "Latest run: status=$RUN_STATUS, conclusion=$RUN_CONCLUSION"
      add_check "ci-green" "FAIL" "Run $RUN_STATUS/$RUN_CONCLUSION" "$DURATION"
    fi
  fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 3: Gateway Health
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Check 3: Gateway Health -------------------------------------------"
T0=$(millis)

HEALTH_RESP=$(curl -sS --max-time 15 "$GW/api/health" 2>/dev/null | nul_safe || echo "CURL_ERROR")
T1=$(millis)
DURATION=$((T1 - T0))

if [ "$HEALTH_RESP" = "CURL_ERROR" ]; then
  fail "Gateway unreachable at $GW"
  add_check "gateway-health" "FAIL" "Connection failed" "$DURATION"
else
  # FC-8 round 4 (finding 2): validate BEFORE any compare/print/add_check —
  # round 3 printed this field after only swapping it for the extracted
  # (but still unvalidated) value, not after actually validating it.
  HEALTH_STATUS=$(safe_enum "$(echo "$HEALTH_RESP" | jq -r .status 2>/dev/null || echo "")" ok)
  if [ "$HEALTH_STATUS" = "ok" ]; then
    pass "Gateway healthy: status=$HEALTH_STATUS"
    add_check "gateway-health" "PASS" "status=$HEALTH_STATUS" "$DURATION"
  else
    fail "Gateway unhealthy: status=$HEALTH_STATUS"
    add_check "gateway-health" "FAIL" "status=$HEALTH_STATUS" "$DURATION"
  fi

  # Also check setup status
  SETUP_RESP=$(curl -sS --max-time 15 "$GW/api/setup/status" 2>/dev/null | nul_safe || echo "")
  if [ -n "$SETUP_RESP" ]; then
    OVERALL=$(safe_enum "$(echo "$SETUP_RESP" | jq -r .overall 2>/dev/null || echo "unknown")" ok incomplete error unknown)
    info "Setup status: overall=$OVERALL"
  fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 4: New Code Deployed (or compile-verified)
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Check 4: New Code Verified ----------------------------------------"
T0=$(millis)

# Since the branch is not yet merged to master, we verify the code compiles
# and the key new files exist in the commit
NEW_FILES_EXPECTED=(
  "packages/verifier/src/poa/types.ts"
  "packages/verifier/src/poa/poa-bridge.ts"
)

ALL_PRESENT=true
# FC-8 round 5: EXPECTED_FILE walks a fixed, author-written literal array
# (NEW_FILES_EXPECTED above) — never external/env/response data — so it is
# safe to print as-is; named (not "$f") so it reads clearly in the
# explicit validated-variable list alongside the other allowed names.
for EXPECTED_FILE in "${NEW_FILES_EXPECTED[@]}"; do
  if [ -f "$EXPECTED_FILE" ]; then
    info "Found: $EXPECTED_FILE"
  else
    info "Missing: $EXPECTED_FILE"
    ALL_PRESENT=false
  fi
done

T1=$(millis)
DURATION=$((T1 - T0))

if $ALL_PRESENT; then
  pass "All expected new files present in working tree"
  add_check "new-code-deployed" "PASS" "Key files present, branch not yet in production" "$DURATION"
else
  fail "Some expected files missing"
  add_check "new-code-deployed" "FAIL" "Expected files missing from working tree" "$DURATION"
fi

info "NOTE: Branch not merged to master yet -- production deploy pending"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 5: Oracle Responds
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Check 5: Oracle Health --------------------------------------------"
T0=$(millis)

# Try tunnel first, fall back to direct. FC-8 round 5: ORACLE_SOURCE is a
# fixed two-value LABEL ("tunnel"/"direct") — never the actual URL used for
# the request, since ORACLE_DIRECT is env-derived (ORACLE_REAL_URL, which
# holds the real target for the actual curl calls below, is never printed).
ORACLE_HEALTH=""
ORACLE_SOURCE=""
ORACLE_REAL_URL=""

ORACLE_HEALTH=$(curl -sS --max-time 10 "$ORACLE_TUNNEL/health" 2>/dev/null | nul_safe || echo "")
if [ -n "$ORACLE_HEALTH" ]; then
  ORACLE_SOURCE="tunnel"
  ORACLE_REAL_URL="$ORACLE_TUNNEL"
else
  info "Tunnel unreachable, trying direct Spark access..."
  ORACLE_HEALTH=$(curl -sS --max-time 10 "$ORACLE_DIRECT/health" 2>/dev/null | nul_safe || echo "")
  if [ -n "$ORACLE_HEALTH" ]; then
    ORACLE_SOURCE="direct"
    ORACLE_REAL_URL="$ORACLE_DIRECT"
  fi
fi

T1=$(millis)
DURATION=$((T1 - T0))

if [ -z "$ORACLE_HEALTH" ]; then
  fail "Oracle unreachable (tunnel + direct both failed)"
  add_check "oracle-responds" "FAIL" "Oracle unreachable via tunnel and direct" "$DURATION"
else
  # FC-8 round 4 (finding 2): same fix as HEALTH_STATUS above.
  ORACLE_STATUS=$(safe_enum "$(echo "$ORACLE_HEALTH" | jq -r .status 2>/dev/null || echo "")" ok)
  ORACLE_SOURCE_SAFE=$(safe_enum "$ORACLE_SOURCE" tunnel direct)
  if [ "$ORACLE_STATUS" = "ok" ]; then
    # FC-8: via the safe tunnel/direct LABEL, never the real URL (below).
    # N44's equivalent printed the actual $ORACLE_URL_USED verbatim; that
    # variable no longer exists once FC-8's ORACLE_SOURCE/ORACLE_REAL_URL
    # split (above, unconflicted) replaces it — ORACLE_REAL_URL is the one
    # that must never be printed.
    pass "Oracle healthy via $ORACLE_SOURCE_SAFE: status=$ORACLE_STATUS"
    add_check "oracle-responds" "PASS" "Oracle ok via $ORACLE_SOURCE_SAFE" "$DURATION"

    # Smoke verify request. It needs PCC_ORACLE_KEY (now read from
    # PCC_ORACLE_KEY_FILE at startup — FC-8 round 4, see the top of this
    # script), and a missing key is a failure: an authenticated check that
    # never ran is not a pass (N44). ORACLE_KEY cannot actually be empty
    # here any more — the startup file-read above exits the whole script
    # first if it would be — so this is defense in depth, not a live path;
    # kept verbatim as N44's own stated contract for this check.
    if [ -z "$ORACLE_KEY" ]; then
      fail "PCC_ORACLE_KEY not set: the authenticated verify request did not run"
      add_check "oracle-verify" "FAIL" "PCC_ORACLE_KEY not set; authenticated verify not run" "0"
      VERIFY_RESP=""
    else
      info "Sending smoke verify request..."
      # The check passes only when the oracle PROCESSED an authenticated request:
      # transport ok, HTTP 200, and a body that is exactly one JSON object whose
      # result.verified is a boolean. true and false both pass, since the smoke
      # evidence is not expected to verify. A rejected key, a transport failure,
      # an empty body, several JSON documents or trailing bytes FAIL. (N44;
      # uses ORACLE_REAL_URL, FC-8's un-printed real target, not the old
      # ORACLE_URL_USED.)
      http_request --max-time 15 -X POST "$ORACLE_REAL_URL/verify" \
        -H "Content-Type: application/json" \
        -H "x-oracle-key: $ORACLE_KEY" \
        -d '{
          "escrowAddress": "0x0000000000000000000000000000000000000000",
          "jobId": "smoke-test-'"$(date +%s)"'",
          "kernelId": "kernel-hp-printer",
          "evidenceHash": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          "assuranceTier": 0,
          "chainId": 84532
        }'
      VERIFY_HTTP="$HTTP_STATUS"
      VERIFIED="invalid"
      if json_object_where '(.result | type) == "object" and (.result.verified | type) == "boolean"'; then
        VERIFIED=$(json_field '.result.verified | tostring')
      fi
      case "$VERIFY_HTTP" in
        200)
          case "$VERIFIED" in
            true|false)
              # FC-8 round 2: .result.reason is the oracle's free text and may
              # reflect a secret (e.g. a header value echoed into an error
              # message); only the validated boolean `verified` field
              # (type-checked above by json_object_where) is safe to log —
              # N44's own pass message here also interpolated
              # `json_field '.result.reason // "" | tostring'`, which this
              # drops per that FC-8 finding.
              pass "Oracle processed the authenticated verify request (verified=$VERIFIED)"
              add_check "oracle-verify" "PASS" "authenticated verify processed; verified=$VERIFIED" "0"
              ;;
            *)
              fail "Oracle verify answered 200 without exactly one JSON object holding a boolean result.verified"
              add_check "oracle-verify" "FAIL" "200 without one JSON object holding a boolean result.verified" "0"
              ;;
          esac
          ;;
        401|403)
          fail "Oracle rejected PCC_ORACLE_KEY (HTTP $VERIFY_HTTP)"
          add_check "oracle-verify" "FAIL" "authentication rejected (HTTP $VERIFY_HTTP)" "0"
          ;;
        transport-error|000)
          fail "Oracle verify request failed in transport (timeout or connection)"
          add_check "oracle-verify" "FAIL" "transport failure" "0"
          ;;
        *)
          fail "Oracle verify answered HTTP $VERIFY_HTTP"
          add_check "oracle-verify" "FAIL" "HTTP $VERIFY_HTTP" "0"
          ;;
      esac
    fi
  else
    fail "Oracle returned unexpected status: $ORACLE_STATUS"
    add_check "oracle-responds" "FAIL" "Unexpected oracle status: $ORACLE_STATUS" "$DURATION"
  fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 6: End-to-End Flow
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Check 6: End-to-End Flow ------------------------------------------"
T0=$(millis)
# N44: every step counted below must answer as its route does when it works:
# transport ok, the route's success status, and exactly one JSON object of the
# expected shape. Anything else fails the flow.
E2E_OK=true
API_KEY=""
TYPE_COUNT=0
KERNEL_COUNT=0

# Step 1: Provision API key
info "Step 1: Provisioning API key..."
http_request --max-time 15 -X POST "$GW/api/auth/provision" \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke-dv-'"$(date +%s)"'@pcc.local","name":"Smoke DV Agent"}'
if [ "$HTTP_STATUS" = "201" ] && json_object_where '(.api_key | type) == "string" and (.api_key | length) > 0'; then
  API_KEY=$(json_field '.api_key')
  info "Got an API key (value not shown)"
else
  # N44 (http_request/json_object_where, above) already never prints the
  # response or the key — only the HTTP status — so it already satisfies
  # FC-8's "withhold the api_key-bearing response" rule. FC-8's own fallback
  # here read $PROVISION_RESP, a pre-http_request()-helper variable that no
  # longer exists in this merged script; N44's version is kept as-is.
  fail "API key provision failed (HTTP $HTTP_STATUS, or not one JSON object with an api_key)"
  E2E_OK=false
fi

if $E2E_OK; then
  # Step 2: List capability types
  info "Step 2: Listing capability types..."
  http_request --max-time 10 -H "Authorization: Bearer $API_KEY" "$GW/api/capabilities/types"
  if [ "$HTTP_STATUS" = "200" ] && json_object_where '(.types | type) == "array"'; then
    TYPE_COUNT=$(json_field '.types | length')
    info "Found $TYPE_COUNT capability types"
  else
    fail "Listing capability types failed (HTTP $HTTP_STATUS, or no types array)"
    E2E_OK=false
  fi

  # Step 3: List kernels
  info "Step 3: Listing kernels..."
  http_request --max-time 10 -H "Authorization: Bearer $API_KEY" "$GW/api/kernels"
  if [ "$HTTP_STATUS" = "200" ] && json_object_where '(.kernels | type) == "array"'; then
    KERNEL_COUNT=$(json_field '.kernels | length')
    info "Found $KERNEL_COUNT kernel(s)"
  else
    fail "Listing kernels failed (HTTP $HTTP_STATUS, or no kernels array)"
    E2E_OK=false
  fi

  # Step 4: Check setup status (authenticated)
  info "Step 4: Setup status..."
  # N44's http_request/fail/E2E_OK=false (this step genuinely fails the e2e
  # flow on a bad response, per the "every step... fails the flow" rule at
  # the top of Check 6) combined with FC-8's safe_enum at extraction (the
  # same ok/incomplete/error/unknown allowlist Check 3's unconflicted
  # "Also check setup status" already uses for this exact field) — N44's
  # own `json_field '.overall'` printed the gateway-derived string with only
  # a type check, not a closed-enum validation.
  http_request --max-time 10 -H "Authorization: Bearer $API_KEY" "$GW/api/setup/status"
  if [ "$HTTP_STATUS" = "200" ] && json_object_where '(.overall | type) == "string"'; then
    OVERALL=$(safe_enum "$(json_field '.overall')" ok incomplete error unknown)
    info "Overall setup status: $OVERALL"
  else
    fail "Setup status failed (HTTP $HTTP_STATUS, or no overall status)"
    E2E_OK=false
  fi

  # Step 5: Check integrations (informational; not a pass condition)
  info "Step 5: Integration status..."
  INT_RESP=$(curl -sS --max-time 10 "$GW/api/status/integrations" 2>/dev/null | nul_safe || echo "")
  if [ -n "$INT_RESP" ]; then
    LIT_LIVE=$(safe_bool "$(echo "$INT_RESP" | jq -r '.litProtocol.configured' 2>/dev/null || echo "false")")
    STARKNET_LIVE=$(safe_bool "$(echo "$INT_RESP" | jq -r '.starknet.configured' 2>/dev/null || echo "false")")
    info "Lit=$LIT_LIVE Starknet=$STARKNET_LIVE"
  fi

  # Step 6: Validate API key. Only HTTP 200 with the boolean valid: true counts.
  info "Step 6: Validating API key..."
  # N44's `.valid == true` jq comparison is already a structural boolean
  # check (true only if the field is literally the JSON boolean true, same
  # safety property FC-8's safe_bool gives), and it never prints the raw
  # response or a derived value either way — so it already satisfies FC-8's
  # "validate before print" sink rule as-is. FC-8's own version here was
  # informational-only (no fail/E2E_OK=false on an invalid key); N44's
  # "a provisioned key that does not validate is a failed flow, not a note"
  # is the behavior that survives.
  http_request --max-time 10 -H "Authorization: Bearer $API_KEY" "$GW/api/auth/validate"
  if [ "$HTTP_STATUS" = "200" ] && json_object_where '.valid == true'; then
    info "API key validated successfully"
  else
    fail "API key validation failed (HTTP $HTTP_STATUS, or valid is not the boolean true)"
    E2E_OK=false
  fi
fi

T1=$(millis)
DURATION=$((T1 - T0))

if $E2E_OK; then
  pass "E2E flow completed: provisioning, capability types, kernels, setup status and key validation each answered as required"
  add_check "e2e-flow" "PASS" "Provision 201; types, kernels, setup status and validate 200 with the expected JSON. Types=$TYPE_COUNT Kernels=$KERNEL_COUNT" "$DURATION"
else
  fail "E2E flow failed"
  add_check "e2e-flow" "FAIL" "E2E flow failed (see the step that failed above)" "$DURATION"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
END_TIME=$(millis)
WALL_TIME=$((END_TIME - START_TIME))
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))

echo "======================================================================="
echo " SMOKE TEST SUMMARY"
echo "======================================================================="
echo ""
echo -e "  ${GREEN}PASS${NC}: $PASS_COUNT / $TOTAL"
echo -e "  ${RED}FAIL${NC}: $FAIL_COUNT / $TOTAL"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP_COUNT / $TOTAL"
echo ""
echo "  Wall time: ${WALL_TIME}ms"
# FC-8 round 5: the commit SHA, fingerprinted — round 4 printed
# ${COMMIT_SHA:0:12} (a raw prefix of the real SHA) directly.
echo "  Commit: $(public_id_for_log "$COMMIT_SHA" commit_sha)"
echo "  Branch: $BRANCH"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
  OVERALL_STATUS="PASS"
  echo -e "  ${GREEN}Overall: PASS${NC}"
else
  OVERALL_STATUS="FAIL"
  echo -e "  ${RED}Overall: FAIL -- $FAIL_COUNT check(s) failed${NC}"
fi
echo ""
echo "======================================================================="

# ── Write telemetry report ──────────────────────────────────────────────────
mkdir -p "$(dirname "$REPORT_FILE")"
# FC-8 round 5: the report file is a SINK too (same rule as stdout/stderr) —
# the commit field is fingerprinted, never the raw SHA round 4 wrote here.
COMMIT_SHA_LOG="$(public_id_for_log "$COMMIT_SHA" commit_sha)"
cat > "$REPORT_FILE" <<REPORT_EOF
{
  "timestamp": "$(date -Iseconds 2>/dev/null || date)",
  "branch": "$BRANCH",
  "commit": "$COMMIT_SHA_LOG",
  "checks": $CHECKS_JSON,
  "overall": "$OVERALL_STATUS",
  "healAttempts": 0,
  "wallTimeMs": $WALL_TIME,
  "passCount": $PASS_COUNT,
  "failCount": $FAIL_COUNT,
  "skipCount": $SKIP_COUNT
}
REPORT_EOF

info "Report written to $REPORT_FILE"

# Exit with non-zero if any checks failed
if [ $FAIL_COUNT -gt 0 ]; then
  exit 1
fi
exit 0
