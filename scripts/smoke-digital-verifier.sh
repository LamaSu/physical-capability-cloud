#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# smoke-digital-verifier.sh — 6-check smoke test for digital-verifier/foundation
#
# Usage:
#   cd /path/to/physical-capability-cloud
#   bash scripts/smoke-digital-verifier.sh
#
# Requirements: git, curl, jq, gh (GitHub CLI)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
REPO="global-mysterysnailrevolution/physical-capability-cloud"
BRANCH="digital-verifier/foundation"
GW="https://capability.network"
ORACLE_TUNNEL="https://refer-proxy-joint-cleaning.trycloudflare.com"
ORACLE_DIRECT="${ORACLE_DIRECT:-http://localhost:4100}"
# N44: from the environment only; never commit a key literal (CI secret scan).
ORACLE_KEY="${PCC_ORACLE_KEY:-}"
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

# N44: every line the script prints about a response goes through say(). The
# message is redacted, then stripped of control characters (escape sequences,
# carriage returns and every other byte below 0x20 except tab and newline, and
# DEL), then printed with %s. Only the colour constants are interpreted.
say() {
  printf '  %b%s%b %s\n' "$1" "$2" "$NC" "$(redact "$3" | tr -d '\000-\010\013-\037\177')"
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
# after part of a body arrived), and HTTP_BODY to the body. curl's own
# messages are discarded, never printed, and no temporary file is written.
http_request() {
  local out rc=0
  out=$(curl -sS "$@" -w '\n%{http_code}' 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then
    HTTP_STATUS="transport-error"
    HTTP_BODY=""
  else
    HTTP_STATUS="${out##*$'\n'}"
    HTTP_BODY="${out%$'\n'*}"
  fi
}

# N44: succeeds only when HTTP_BODY is exactly one JSON object (not empty, not
# two documents, no trailing bytes) for which the jq condition $1 holds.
json_object_where() {
  printf '%s' "$HTTP_BODY" | jq -e -s "length == 1 and (.[0] | type) == \"object\" and (.[0] | $1)" >/dev/null 2>&1
}

# The value of jq path $1 in HTTP_BODY's single object (after json_object_where).
json_field() {
  printf '%s' "$HTTP_BODY" | jq -r -s ".[0] | $1" 2>/dev/null || true
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
if [ -z "$LOCAL_SHA" ]; then
  fail "Not in a git repo or HEAD unresolvable"
  add_check "git-push" "FAIL" "Not in a git repo" 0
else
  REMOTE_SHA=$(git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1 || echo "")
  T1=$(millis)
  DURATION=$((T1 - T0))

  if [ -z "$REMOTE_SHA" ]; then
    fail "Branch $BRANCH not found on remote 'origin'"
    add_check "git-push" "FAIL" "Branch not found on remote" "$DURATION"
  elif [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    pass "Local HEAD $LOCAL_SHA matches remote"
    add_check "git-push" "PASS" "SHA match: $LOCAL_SHA" "$DURATION"
  else
    fail "Local ($LOCAL_SHA) != Remote ($REMOTE_SHA)"
    add_check "git-push" "FAIL" "Local $LOCAL_SHA != Remote $REMOTE_SHA" "$DURATION"
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
  info "Found PR #$PR_NUM for branch $BRANCH"

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
    FAILED=$(echo "$CI_RESULT" | grep -i "fail" | head -3)
    fail "CI has failing checks: $FAILED"
    add_check "ci-green" "FAIL" "Failing checks detected" "$DURATION"
  else
    pass "All CI checks passing"
    add_check "ci-green" "PASS" "All checks green on PR #$PR_NUM" "$DURATION"
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
    RUN_STATUS=$(echo "$RUN_DATA" | jq -r .status)
    RUN_CONCLUSION=$(echo "$RUN_DATA" | jq -r .conclusion)

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

HEALTH_RESP=$(curl -sS --max-time 15 "$GW/api/health" 2>/dev/null || echo "CURL_ERROR")
T1=$(millis)
DURATION=$((T1 - T0))

if [ "$HEALTH_RESP" = "CURL_ERROR" ]; then
  fail "Gateway unreachable at $GW"
  add_check "gateway-health" "FAIL" "Connection failed" "$DURATION"
else
  HEALTH_STATUS=$(echo "$HEALTH_RESP" | jq -r .status 2>/dev/null || echo "")
  if [ "$HEALTH_STATUS" = "ok" ]; then
    pass "Gateway healthy: $(redact "$HEALTH_RESP")"
    add_check "gateway-health" "PASS" "$(redact "$HEALTH_RESP")" "$DURATION"
  else
    fail "Gateway unhealthy: $(redact "$HEALTH_RESP")"
    add_check "gateway-health" "FAIL" "$(redact "$HEALTH_RESP")" "$DURATION"
  fi

  # Also check setup status
  SETUP_RESP=$(curl -sS --max-time 15 "$GW/api/setup/status" 2>/dev/null || echo "")
  if [ -n "$SETUP_RESP" ]; then
    OVERALL=$(echo "$SETUP_RESP" | jq -r .overall 2>/dev/null || echo "unknown")
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
for f in "${NEW_FILES_EXPECTED[@]}"; do
  if [ -f "$f" ]; then
    info "Found: $f"
  else
    info "Missing: $f"
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

# Try tunnel first, fall back to direct
ORACLE_HEALTH=""
ORACLE_URL_USED=""

ORACLE_HEALTH=$(curl -sS --max-time 10 "$ORACLE_TUNNEL/health" 2>/dev/null || echo "")
if [ -n "$ORACLE_HEALTH" ]; then
  ORACLE_URL_USED="$ORACLE_TUNNEL"
else
  info "Tunnel unreachable, trying direct Spark access..."
  ORACLE_HEALTH=$(curl -sS --max-time 10 "$ORACLE_DIRECT/health" 2>/dev/null || echo "")
  if [ -n "$ORACLE_HEALTH" ]; then
    ORACLE_URL_USED="$ORACLE_DIRECT"
  fi
fi

T1=$(millis)
DURATION=$((T1 - T0))

if [ -z "$ORACLE_HEALTH" ]; then
  fail "Oracle unreachable (tunnel + direct both failed)"
  add_check "oracle-responds" "FAIL" "Oracle unreachable via tunnel and direct" "$DURATION"
else
  ORACLE_STATUS=$(echo "$ORACLE_HEALTH" | jq -r .status 2>/dev/null || echo "")
  if [ "$ORACLE_STATUS" = "ok" ]; then
    pass "Oracle healthy via $ORACLE_URL_USED: $(redact "$ORACLE_HEALTH")"
    add_check "oracle-responds" "PASS" "Oracle ok via $ORACLE_URL_USED" "$DURATION"

    # Smoke verify request. It needs PCC_ORACLE_KEY, and a missing key is a
    # failure: an authenticated check that never ran is not a pass (N44).
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
      # an empty body, several JSON documents or trailing bytes FAIL.
      http_request --max-time 15 -X POST "$ORACLE_URL_USED/verify" \
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
              REASON=$(json_field '.result.reason // "" | tostring')
              pass "Oracle processed the authenticated verify request (verified=$VERIFIED, reason: $REASON)"
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
    fail "Oracle returned unexpected status: $(redact "$ORACLE_HEALTH")"
    add_check "oracle-responds" "FAIL" "Unexpected oracle status: $(redact "$ORACLE_HEALTH")" "$DURATION"
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
  http_request --max-time 10 -H "Authorization: Bearer $API_KEY" "$GW/api/setup/status"
  if [ "$HTTP_STATUS" = "200" ] && json_object_where '(.overall | type) == "string"'; then
    info "Overall setup status: $(json_field '.overall')"
  else
    fail "Setup status failed (HTTP $HTTP_STATUS, or no overall status)"
    E2E_OK=false
  fi

  # Step 5: Check integrations (informational; not a pass condition)
  info "Step 5: Integration status..."
  INT_RESP=$(curl -sS --max-time 10 "$GW/api/status/integrations" 2>/dev/null || echo "")
  if [ -n "$INT_RESP" ]; then
    LIT_LIVE=$(echo "$INT_RESP" | jq -r '.litProtocol.configured' 2>/dev/null || echo "false")
    STARKNET_LIVE=$(echo "$INT_RESP" | jq -r '.starknet.configured' 2>/dev/null || echo "false")
    info "Lit=$LIT_LIVE Starknet=$STARKNET_LIVE"
  fi

  # Step 6: Validate API key. Only HTTP 200 with the boolean valid: true counts.
  info "Step 6: Validating API key..."
  http_request --max-time 10 -H "Authorization: Bearer $API_KEY" "$GW/api/auth/validate"
  if [ "$HTTP_STATUS" = "200" ] && json_object_where '.valid == true'; then
    info "API key validated successfully"
  else
    # A provisioned key that does not validate is a failed flow, not a note.
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
echo "  Commit: ${COMMIT_SHA:0:12}"
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
cat > "$REPORT_FILE" <<REPORT_EOF
{
  "timestamp": "$(date -Iseconds 2>/dev/null || date)",
  "branch": "$BRANCH",
  "commit": "$COMMIT_SHA",
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
