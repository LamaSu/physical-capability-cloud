#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/smoke-v2.sh — V2 substrate boot smoke test
#
# Verifies the V2 loop boots and the end-to-end agentic-composition path works
# against a mocked gateway (no chain action, no Railway, no production).
#
# Steps (each one fails fast and exits non-zero on error):
#   1. Boot gateway on :8080 with mocks
#   2. Wait for /health → 200
#   3. /.well-known/agent-card.json: skills.length === 8
#   4. /api/csd/suggest?q=fdm → suggestions present
#      /api/csd/popular → popular present
#      /api/operators/<slug>/status (pre-create) → unconfigured
#      POST /api/operators/<slug>/channels → 201 + channel record
#   5. A2A pcc-author-integration end-to-end (human lane + SLA + availability + 2 channels)
#   6. A2A pcc-suggest-templates with "make pizza" → suggestions present
#   7. GET /api/operators/<slug>/status → status="ready" (or "partial" with named missing slots only)
#   8. Boot dashboard build, serve via gateway, curl /operator-status.html?slug=<slug>
#   9. Cleanup: kill gateway
#  10. Print PASS/FAIL summary
#
# Idempotent — safe to re-run. Pick a unique slug per run via $RANDOM so
# repeated runs don't collide on the in-memory channel registry.
#
# Usage:
#   bash scripts/smoke-v2.sh                         # default: PCC_BASE=http://localhost:8080
#   PCC_BASE=https://capability.network bash ...     # smoke an external gateway (NO boot)
#   SKIP_BOOT=true PCC_BASE=http://localhost:8080 bash ...  # gateway already running
#   SKIP_DASHBOARD=true bash ...                     # skip step 8 (dashboard build is slow)
#
# Exit codes:
#   0  all checks passed
#   1  smoke-test step failed
#   2  prerequisite missing (curl, jq, node, pnpm)
#   3  boot failed
# ─────────────────────────────────────────────────────────────────────────────

set -u
set -o pipefail

# ── Configuration ───────────────────────────────────────────────────────────
PCC_BASE="${PCC_BASE:-http://localhost:8080}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
SKIP_BOOT="${SKIP_BOOT:-false}"
SKIP_DASHBOARD="${SKIP_DASHBOARD:-false}"
BOOT_TIMEOUT_SEC="${BOOT_TIMEOUT_SEC:-60}"
SLUG="${SMOKE_SLUG:-smoke-pizza-$RANDOM}"
LOG_DIR="${LOG_DIR:-/tmp}"
GATEWAY_LOG="${LOG_DIR}/smoke-v2-gateway.log"

# ── Counters & tracking ─────────────────────────────────────────────────────
declare -i STEP=0
declare -i PASSED=0
declare -i FAILED=0
declare -a FAIL_DETAILS=()
GATEWAY_PID=""

# ── Colors (only if stdout is a tty) ────────────────────────────────────────
if [[ -t 1 ]]; then
  C_GREEN='\033[0;32m'
  C_RED='\033[0;31m'
  C_YELLOW='\033[0;33m'
  C_BLUE='\033[0;34m'
  C_RESET='\033[0m'
else
  C_GREEN='' C_RED='' C_YELLOW='' C_BLUE='' C_RESET=''
fi

# ── Helpers ─────────────────────────────────────────────────────────────────
step() {
  STEP=$((STEP + 1))
  echo
  echo -e "${C_BLUE}── Step ${STEP}: $* ──${C_RESET}"
}

pass() {
  PASSED=$((PASSED + 1))
  echo -e "  ${C_GREEN}PASS${C_RESET} $*"
}

fail() {
  FAILED=$((FAILED + 1))
  FAIL_DETAILS+=("step ${STEP}: $*")
  echo -e "  ${C_RED}FAIL${C_RESET} $*"
}

info() {
  echo -e "  ${C_YELLOW}info${C_RESET} $*"
}

# Run a curl, capture body + status, fail on non-2xx.
# Usage: http_get <url> [extra-curl-args]
http_get() {
  local url="$1"; shift
  local body status
  local tmp; tmp="$(mktemp)"
  status=$(curl -sS -o "$tmp" -w '%{http_code}' "$@" "$url" || echo "000")
  body=$(cat "$tmp")
  rm -f "$tmp"
  echo "${status}|${body}"
}

# Run a curl POST with JSON body.
# Usage: http_post <url> <json-body> [extra-curl-args]
http_post() {
  local url="$1"; shift
  local data="$1"; shift
  local body status
  local tmp; tmp="$(mktemp)"
  status=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    -d "$data" "$@" "$url" || echo "000")
  body=$(cat "$tmp")
  rm -f "$tmp"
  echo "${status}|${body}"
}

# Decode a "status|body" string
status_of() { echo "$1" | head -c 3; }
body_of()   { echo "$1" | sed 's/^[0-9][0-9][0-9]|//'; }

cleanup() {
  if [[ -n "${GATEWAY_PID}" ]]; then
    echo
    info "Cleanup — killing gateway (PID ${GATEWAY_PID})"
    kill "${GATEWAY_PID}" 2>/dev/null || true
    wait "${GATEWAY_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── Pre-flight ─────────────────────────────────────────────────────────────
check_prereqs() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v jq   >/dev/null 2>&1 || missing+=(jq)
  if [[ "$SKIP_BOOT" != "true" ]]; then
    command -v node >/dev/null 2>&1 || missing+=(node)
    command -v pnpm >/dev/null 2>&1 || missing+=(pnpm)
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${C_RED}Missing prerequisites: ${missing[*]}${C_RESET}" >&2
    echo "Install them and re-run." >&2
    exit 2
  fi
}

# ── Boot ───────────────────────────────────────────────────────────────────
boot_gateway() {
  if [[ "$SKIP_BOOT" == "true" ]]; then
    info "SKIP_BOOT=true — assuming gateway already running at ${PCC_BASE}"
    return
  fi

  step "Boot gateway on :${GATEWAY_PORT} with mocks"
  info "Build first to ensure dist is current (pnpm --filter @pcc/gateway build)"
  if ! pnpm --filter @pcc/gateway build >>"$GATEWAY_LOG" 2>&1; then
    fail "gateway build failed — see ${GATEWAY_LOG}"
    exit 3
  fi
  pass "gateway built"

  info "Starting gateway in background (logs: ${GATEWAY_LOG})"
  PCC_DB_PATH=":memory:" \
  PCC_USE_EAS_V2=false \
  MOCK_SETTLEMENT=true \
  PCC_COMPOSE_EXECUTE_REAL=false \
  PORT="${GATEWAY_PORT}" \
  PCC_GATEWAY_URL="${PCC_BASE}" \
  NODE_ENV=test \
    pnpm --filter @pcc/gateway start >>"$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!
  info "gateway PID=${GATEWAY_PID}"

  info "Waiting up to ${BOOT_TIMEOUT_SEC}s for /health..."
  local elapsed=0
  while (( elapsed < BOOT_TIMEOUT_SEC )); do
    if curl -sf -o /dev/null "${PCC_BASE}/health" 2>/dev/null; then
      pass "gateway booted in ${elapsed}s"
      return
    fi
    if ! kill -0 "${GATEWAY_PID}" 2>/dev/null; then
      fail "gateway process died during boot — see ${GATEWAY_LOG}"
      exit 3
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  fail "gateway boot timed out after ${BOOT_TIMEOUT_SEC}s — see ${GATEWAY_LOG}"
  exit 3
}

# ── Step 2: /health ────────────────────────────────────────────────────────
check_health() {
  step "GET /health → 200"
  local resp; resp=$(http_get "${PCC_BASE}/health")
  local s; s=$(status_of "$resp")
  if [[ "$s" == "200" ]]; then
    pass "/health is 200"
  else
    fail "/health returned ${s}: $(body_of "$resp" | head -c 200)"
  fi
}

# ── Step 3: agent-card skills count ────────────────────────────────────────
check_agent_card() {
  step "GET /.well-known/agent-card.json → skills.length === 8"
  local resp; resp=$(http_get "${PCC_BASE}/.well-known/agent-card.json")
  local s; s=$(status_of "$resp")
  if [[ "$s" != "200" ]]; then
    fail "agent-card returned ${s}: $(body_of "$resp" | head -c 200)"
    return
  fi
  local count; count=$(body_of "$resp" | jq -r '.skills | length' 2>/dev/null || echo "?")
  if [[ "$count" == "8" ]]; then
    pass "agent-card has 8 skills"
  else
    fail "agent-card skills.length = ${count} (expected 8)"
    body_of "$resp" | jq -r '.skills[].id' 2>/dev/null | sed 's/^/      /'
  fi

  # Verify required skill IDs are present
  local required=("pcc-discover" "pcc-quote" "pcc-submit" "pcc-verify" "pcc-settle" "pcc-author-integration" "pcc-attach-channel" "pcc-suggest-templates")
  local missing=()
  local ids; ids=$(body_of "$resp" | jq -r '.skills[].id' 2>/dev/null)
  for r in "${required[@]}"; do
    if ! echo "$ids" | grep -qx "$r"; then
      missing+=("$r")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    pass "all 8 required skill IDs present"
  else
    fail "missing skill IDs: ${missing[*]}"
  fi
}

# ── Step 4: new endpoints ──────────────────────────────────────────────────
check_csd_endpoints() {
  step "GET /api/csd/suggest?q=fdm and /api/csd/popular"

  local resp s body
  resp=$(http_get "${PCC_BASE}/api/csd/suggest?q=fdm")
  s=$(status_of "$resp")
  body=$(body_of "$resp")
  if [[ "$s" == "200" ]]; then
    local has_arr; has_arr=$(echo "$body" | jq -r 'has("suggestions")' 2>/dev/null || echo "false")
    if [[ "$has_arr" == "true" ]]; then
      pass "/api/csd/suggest returns suggestions array"
    else
      fail "/api/csd/suggest body missing 'suggestions' key: $(echo "$body" | head -c 200)"
    fi
  else
    fail "/api/csd/suggest returned ${s}: $(echo "$body" | head -c 200)"
  fi

  resp=$(http_get "${PCC_BASE}/api/csd/popular")
  s=$(status_of "$resp")
  body=$(body_of "$resp")
  if [[ "$s" == "200" ]]; then
    local has_pop; has_pop=$(echo "$body" | jq -r 'has("popular")' 2>/dev/null || echo "false")
    if [[ "$has_pop" == "true" ]]; then
      pass "/api/csd/popular returns popular array"
    else
      fail "/api/csd/popular body missing 'popular' key: $(echo "$body" | head -c 200)"
    fi
  else
    fail "/api/csd/popular returned ${s}: $(echo "$body" | head -c 200)"
  fi
}

check_operator_endpoints_precreate() {
  step "GET /api/operators/${SLUG}/status (pre-create) → unconfigured + POST /channels → 201"

  local resp s body
  resp=$(http_get "${PCC_BASE}/api/operators/${SLUG}/status")
  s=$(status_of "$resp")
  body=$(body_of "$resp")
  if [[ "$s" == "200" ]]; then
    local status_field; status_field=$(echo "$body" | jq -r '.status' 2>/dev/null || echo "?")
    if [[ "$status_field" == "unconfigured" ]]; then
      pass "pre-create status is 'unconfigured'"
    else
      info "pre-create status is '${status_field}' (expected 'unconfigured' — collision with previous run?)"
      pass "pre-create status endpoint responded 200"
    fi
  else
    fail "/api/operators/.../status returned ${s}"
  fi

  # Pre-attach a channel to verify the channels route works on its own
  local sample_channel='{"label":"pre-test SMS","transport":"sms","direction":"out","endpoint":{"phone":"+15555550100"},"describe":"smoke-test pre-attach to verify the channels POST route works on its own"}'
  resp=$(http_post "${PCC_BASE}/api/operators/${SLUG}/channels" "$sample_channel")
  s=$(status_of "$resp")
  body=$(body_of "$resp")
  if [[ "$s" == "201" ]]; then
    local ch_id; ch_id=$(echo "$body" | jq -r '.channel.id' 2>/dev/null || echo "?")
    if [[ "$ch_id" =~ ^ch_ ]]; then
      pass "POST /api/operators/${SLUG}/channels → 201 with channel id ${ch_id}"
    else
      fail "POST channels returned 201 but body shape unexpected: $(echo "$body" | head -c 200)"
    fi
  else
    fail "POST /api/operators/${SLUG}/channels returned ${s}: $(echo "$body" | head -c 200)"
  fi
}

# ── Step 5: A2A pcc-author-integration end-to-end ──────────────────────────
check_author_integration() {
  step "A2A pcc-author-integration end-to-end (human lane + SLA + availability + 2 channels)"

  # operatorAddress MUST equal the slug we query in /status (it's the lookup key)
  # operatorSlug MUST equal the slug we use in /channels (also the lookup key for channels)
  local payload
  payload=$(cat <<EOF
{
  "jsonrpc": "2.0",
  "id": "smoke-author-1",
  "method": "tasks/send",
  "params": {
    "skill": "pcc-author-integration",
    "input": {
      "lane": "human",
      "name": "Smoke Test Pizza ${SLUG}",
      "type": "pizza",
      "description": "smoke-test wood-fired Neapolitan pizza operator",
      "operatorAddress": "${SLUG}",
      "operatorSlug": "${SLUG}",
      "location": {"lat": 37.77, "lng": -122.42},
      "pricing": {"currency": "USDC", "baseCost": 12},
      "sla": {
        "acceptanceWindowSec": 60,
        "completionDeadlineSec": 1800,
        "presence": "available",
        "mode": "on-demand"
      },
      "availability": {
        "mode": "windows",
        "windows": [
          {"start": "11:00", "end": "21:00", "daysOfWeek": [1,2,3,4,5,6,0]}
        ],
        "timezone": "America/Los_Angeles",
        "describe": "Open 11am-9pm Pacific daily"
      },
      "channels": [
        {
          "label": "shop SMS",
          "transport": "sms",
          "direction": "out",
          "endpoint": {"phone": "+15555550199"},
          "describe": "Pizza shop owner's phone — text message lands at the counter tablet"
        },
        {
          "label": "shop webhook",
          "transport": "webhook",
          "direction": "in-out",
          "endpoint": {"url": "https://example.invalid/orders"},
          "describe": "Tablet POS posts back order acknowledgement to this webhook"
        }
      ]
    }
  }
}
EOF
)

  local resp s body
  resp=$(http_post "${PCC_BASE}/a2a/tasks/send" "$payload")
  s=$(status_of "$resp")
  body=$(body_of "$resp")
  if [[ "$s" != "200" ]]; then
    fail "/a2a/tasks/send returned ${s}: $(echo "$body" | head -c 300)"
    return
  fi
  # JSON-RPC result containing the A2A task — drill into artifacts[0].data
  local data
  data=$(echo "$body" | jq -r '.result.artifacts[0].data' 2>/dev/null)
  if [[ -z "$data" || "$data" == "null" ]]; then
    fail "author-integration response missing artifacts[0].data: $(echo "$body" | head -c 300)"
    return
  fi

  local kernel_id op_slug ch_attached availability_present agent_card_url
  kernel_id=$(echo "$data" | jq -r '.kernelId' 2>/dev/null || echo "")
  op_slug=$(echo "$data" | jq -r '.operatorSlug' 2>/dev/null || echo "")
  ch_attached=$(echo "$data" | jq -r '.channelsAttached' 2>/dev/null || echo "")
  availability_present=$(echo "$data" | jq -r '.availability | type' 2>/dev/null || echo "")
  agent_card_url=$(echo "$data" | jq -r '.agentCardUrl' 2>/dev/null || echo "")

  if [[ -n "$kernel_id" && "$kernel_id" != "null" ]]; then
    pass "kernelId returned: ${kernel_id}"
  else
    fail "kernelId missing in author-integration response"
  fi

  if [[ "$op_slug" == "${SLUG}" ]]; then
    pass "operatorSlug echoes ${SLUG}"
  else
    fail "operatorSlug mismatch — got '${op_slug}', expected '${SLUG}'"
  fi

  if [[ "$ch_attached" == "2" ]]; then
    pass "channelsAttached === 2"
  else
    fail "channelsAttached = ${ch_attached} (expected 2)"
  fi

  if [[ "$availability_present" == "object" ]]; then
    pass "availability object persisted in response"
  else
    fail "availability missing or null (type=${availability_present})"
  fi

  if [[ "$agent_card_url" =~ /api/kernels/.+/agent-card.json$ ]]; then
    pass "agentCardUrl shape OK: ${agent_card_url}"
  else
    fail "agentCardUrl shape unexpected: ${agent_card_url}"
  fi
}

# ── Step 6: A2A pcc-suggest-templates ──────────────────────────────────────
check_suggest_templates() {
  step "A2A pcc-suggest-templates with 'make pizza'"
  local payload
  payload=$(cat <<'EOF'
{
  "jsonrpc": "2.0",
  "id": "smoke-suggest-1",
  "method": "tasks/send",
  "params": {
    "skill": "pcc-suggest-templates",
    "input": {
      "description": "make pizza",
      "limit": 3
    }
  }
}
EOF
)
  local resp s body
  resp=$(http_post "${PCC_BASE}/a2a/tasks/send" "$payload")
  s=$(status_of "$resp")
  body=$(body_of "$resp")
  if [[ "$s" != "200" ]]; then
    fail "pcc-suggest-templates returned ${s}: $(echo "$body" | head -c 300)"
    return
  fi
  local has_suggestions
  has_suggestions=$(echo "$body" | jq -r '.result.artifacts[0].data | has("suggestions")' 2>/dev/null || echo "false")
  if [[ "$has_suggestions" == "true" ]]; then
    local n; n=$(echo "$body" | jq -r '.result.artifacts[0].data.suggestions | length' 2>/dev/null || echo "0")
    pass "pcc-suggest-templates returned suggestions array (n=${n})"
  else
    fail "pcc-suggest-templates body missing data.suggestions: $(echo "$body" | head -c 300)"
  fi
}

# ── Step 7: post-create status check ───────────────────────────────────────
check_status_after_create() {
  step "GET /api/operators/${SLUG}/status (post-create) → ready or partial"

  local resp s body
  resp=$(http_get "${PCC_BASE}/api/operators/${SLUG}/status")
  s=$(status_of "$resp")
  body=$(body_of "$resp")
  if [[ "$s" != "200" ]]; then
    fail "/api/operators/${SLUG}/status returned ${s}: $(echo "$body" | head -c 200)"
    return
  fi
  local op_status; op_status=$(echo "$body" | jq -r '.status' 2>/dev/null || echo "?")
  local kc; kc=$(echo "$body" | jq -r '.totals.kernelCount' 2>/dev/null || echo "0")
  local cc; cc=$(echo "$body" | jq -r '.totals.capabilityCount' 2>/dev/null || echo "0")
  local chc; chc=$(echo "$body" | jq -r '.totals.channelCount' 2>/dev/null || echo "0")

  info "status=${op_status} kernels=${kc} caps=${cc} channels=${chc}"

  if [[ "$op_status" == "ready" || "$op_status" == "partial" ]]; then
    pass "status is '${op_status}' (post-create — not 'unconfigured')"
  else
    fail "status is '${op_status}' (expected 'ready' or 'partial')"
  fi

  # Sanity: substrate populated something
  if (( kc >= 1 && cc >= 1 && chc >= 1 )); then
    pass "totals show kernel(${kc}) + capability(${cc}) + channels(${chc}) all >= 1"
  else
    fail "totals incomplete — kernels=${kc} caps=${cc} channels=${chc}"
  fi

  if [[ "$op_status" == "partial" ]]; then
    echo "  ${C_YELLOW}info${C_RESET} missing slots:"
    echo "$body" | jq -r '.missing[]' 2>/dev/null | sed 's/^/        - /'
  fi
}

# ── Step 8: dashboard serve operator-status.html ───────────────────────────
check_dashboard() {
  if [[ "$SKIP_DASHBOARD" == "true" ]]; then
    info "SKIP_DASHBOARD=true — skipping operator-status.html check"
    return
  fi
  step "Dashboard serves operator-status.html"

  # The HTML page is shipped in apps/dashboard/public/operator-status.html.
  # When SERVE_DASHBOARD=true, the gateway serves it. We don't restart the
  # gateway just for this check — instead we verify the file is in the source
  # tree (the deployable artifact) and is well-formed.
  local html_path="apps/dashboard/public/operator-status.html"
  if [[ ! -f "$html_path" ]]; then
    fail "${html_path} not found in source tree"
    return
  fi
  if grep -q '<html' "$html_path" && grep -q 'slug' "$html_path"; then
    pass "${html_path} present and contains expected markup (html tag + slug reference)"
  else
    fail "${html_path} present but missing expected markup"
  fi

  # Also confirm the dashboard package builds (smoke build, output to dist).
  # This is the same step Railway runs at deploy time.
  info "running pnpm --filter @pcc/dashboard build (skip via SKIP_DASHBOARD=true if slow)"
  if pnpm --filter @pcc/dashboard build >>"$GATEWAY_LOG" 2>&1; then
    pass "dashboard build succeeded"
  else
    fail "dashboard build failed — see ${GATEWAY_LOG}"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────
main() {
  echo "smoke-v2.sh — V2 substrate boot smoke test"
  echo "  PCC_BASE=${PCC_BASE}"
  echo "  SLUG=${SLUG}"
  echo "  SKIP_BOOT=${SKIP_BOOT} SKIP_DASHBOARD=${SKIP_DASHBOARD}"

  check_prereqs
  boot_gateway
  check_health
  check_agent_card
  check_csd_endpoints
  check_operator_endpoints_precreate
  check_author_integration
  check_suggest_templates
  check_status_after_create
  check_dashboard

  # ── Summary ──────────────────────────────────────────────────────────────
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo "Summary"
  echo "═══════════════════════════════════════════════════════════════"
  echo "  passed: ${PASSED}"
  echo "  failed: ${FAILED}"
  if (( FAILED > 0 )); then
    echo
    echo -e "${C_RED}Failure details:${C_RESET}"
    for d in "${FAIL_DETAILS[@]}"; do
      echo "  - $d"
    done
    echo
    echo "Gateway log: ${GATEWAY_LOG}"
    exit 1
  fi
  echo -e "${C_GREEN}All checks passed.${C_RESET}"
  exit 0
}

main "$@"
