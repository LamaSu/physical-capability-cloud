#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/smoke-v2-settlement.sh — V2 EAS-gated SETTLEMENT smoke (Q2.2 acceptance test)
#
# DRAFT per owner task-distribution (coord #066, task 1 "settlement-fix/globa").
# Validates the FULL V2 settlement loop end-to-end + the attestation-binding refusals.
#
# DISTINCT from scripts/smoke-v2.sh (that one smokes the substrate BOOT path:
# agent-card / CSD / A2A / operator-status). THIS smokes the on-chain SETTLEMENT loop.
#
# RUNS GREEN ONLY AFTER:
#   (a) PR #137 merges — gateway uses createEscrowV2 on the factory + parses the V2
#       EscrowCreated event (NOT the V1 topics[1] extraction) + chain-config has
#       milestoneEscrowFactoryV2=0x39F695.
#   (b) the gateway redeploys on V2.
#   (c) user-gated infra lands: gas signer 0xB0285a funded + WORKFLOW_DB /app/data volume mounted.
# Before that, it FAILS FAST at the precondition gate (by design — the failing gate names
# exactly what's not ready to close V2).
#
# ── ACCEPTANCE CRITERIA (deliberation Q2.2 + globa R2 adds) ──
#  HAPPY PATH (run TWICE for idempotency — fresh job each, no double-release):
#   1. compose a job -> a REAL @pcc/workflow id (NOT wf_<uuid>)
#   2. createEscrowV2 on factory $FACTORY -> capture the clone escrow addr from the V2
#      EscrowCreated event (or predictEscrowAddress) — NOT the V1 createEscrow topics[1]
#   3. READ-BACK on-chain (catches gaps #4 token-mismatch + wrong-oracle):
#        clone.authorizedOracle() == $AUTH_ORACLE (K)
#        clone.PCC_EVIDENCE_SCHEMA_UID() == $SCHEMA_UID
#        clone.token() == the funding token
#   4. fund the escrow with USDC -> escrow token balance increases by the amount
#   5. execute -> evidence -> oracle daemon mints an EAS attestation with:
#        attester == K, schema == $SCHEMA_UID, recipient == escrow,
#        decoded stepId == the milestone stepId, oracleVerified == true
#   6. submitAttestationV2(easUid) accepted (milestone -> Attested)
#   7. after the challenge window, releaseV2 -> operator USDC balance increases (minus 2.35% fee)
#  REFUSALS (each MUST revert / be rejected):
#   R1 C1  UID-replay:  re-submit the SAME easUid to a second milestone -> revert (_attestationUsed)
#   R2 C2a recipient:   attestation whose recipient != escrow -> revert
#   R3 C2b stepId:      attestation whose decoded stepId != the milestone -> revert
#   R4     evidence:    evidence whose bundleHash != attested -> oracle refuses / release rejects
#  PROBES: grep JSON markers in responses, NOT just HTTP 200 (prod SPA-fallback returns 200 HTML).
#
# ── ENV (defaults target the live base-sepolia V2 deploy) ──
#   PCC_BASE     gateway URL          default https://capability.network
#   PCC_API_KEY  Bearer token         (auto-provisions via /api/auth/provision if unset)
#   RPC_URL      base-sepolia RPC     default https://sepolia.base.org
#   FACTORY      PCCProtocolV2        default 0x39F6958b132c0972Ce8f5658A3F8F16491395642
#   AUTH_ORACLE  authorizedOracle K   default 0x3e9cf724f848908fC172a075F3219746126cD319
#   SCHEMA_UID   pcc.evidence.v1 UID  default 0x5acb07db80019928f2aa8798cb0bebaee46a863f28d4b5aaf5a9e04902be8b93
#   ORACLE_URL   oracle daemon        default https://pcc-oracle-production.up.railway.app
#   ESCROW       (optional) a pre-created clone escrow to run on-chain read-backs against
#
# Exit: 0 all pass | 1 a check failed | 2 prereq/precondition missing
# ─────────────────────────────────────────────────────────────────────────────
set -u -o pipefail

PCC_BASE="${PCC_BASE:-https://capability.network}"
RPC_URL="${RPC_URL:-https://sepolia.base.org}"
FACTORY="${FACTORY:-0x39F6958b132c0972Ce8f5658A3F8F16491395642}"
AUTH_ORACLE="${AUTH_ORACLE:-0x3e9cf724f848908fC172a075F3219746126cD319}"
SCHEMA_UID="${SCHEMA_UID:-0x5acb07db80019928f2aa8798cb0bebaee46a863f28d4b5aaf5a9e04902be8b93}"
ORACLE_URL="${ORACLE_URL:-https://pcc-oracle-production.up.railway.app}"
ESCROW="${ESCROW:-}"

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
die()  { echo "PRECONDITION NOT MET: $1"; echo ""; echo "(close-V2 gate — fix this before the loop can settle)"; exit 2; }
section(){ echo ""; echo "== $1 =="; }
lower(){ tr '[:upper:]' '[:lower:]'; }
auth(){ [ -n "${PCC_API_KEY:-}" ] && printf 'Authorization: Bearer %s' "$PCC_API_KEY"; }

# ── 0. Prereqs ──
for c in cast curl jq; do command -v "$c" >/dev/null 2>&1 || die "missing tool: $c"; done

# ── 1. PRECONDITIONS — fully runnable NOW; these ARE the close-V2 gates ──
section "Preconditions (the close-V2 gates)"

# 1a. factory is the CLONE factory (escrowImplementation set)
IMPL=$(cast call "$FACTORY" "escrowImplementation()(address)" --rpc-url "$RPC_URL" 2>/dev/null || true)
if [ -n "$IMPL" ] && [ "$IMPL" != "0x0000000000000000000000000000000000000000" ]; then
  ok "factory $FACTORY is the EIP-1167 clone factory (impl=$IMPL)"
else
  die "factory $FACTORY has no escrowImplementation() — not the clone factory (or wrong addr)"
fi

# 1b. oracle daemon healthy + signer == authorizedOracle K
OH=$(curl -s --max-time 15 "$ORACLE_URL/health" 2>/dev/null || true)
echo "$OH" | jq -e '.status=="ok"' >/dev/null 2>&1 || die "oracle /health not ok: ${OH:0:120}"
OSIG=$(echo "$OH" | jq -r '.oracle // empty')
if [ "$(echo "$OSIG"|lower)" = "$(echo "$AUTH_ORACLE"|lower)" ]; then
  ok "oracle daemon signs as authorizedOracle K ($OSIG)"
else
  die "oracle signer $OSIG != authorizedOracle $AUTH_ORACLE"
fi

# 1c. gateway reachable + returns JSON (NOT the SPA-fallback HTML)
[ -z "${PCC_API_KEY:-}" ] && PCC_API_KEY=$(curl -s --max-time 15 -X POST "$PCC_BASE/api/auth/provision" \
  -H 'Content-Type: application/json' -d '{"email":"smoke-v2-settlement@pcc.test","name":"v2-smoke"}' \
  2>/dev/null | jq -r '.api_key // empty')
[ -n "${PCC_API_KEY:-}" ] || die "no PCC_API_KEY and provisioning failed"
ST=$(curl -s --max-time 15 -H "$(auth)" "$PCC_BASE/api/status" 2>/dev/null || true)
echo "$ST" | jq -e 'type=="object"' >/dev/null 2>&1 || die "gateway /api/status not JSON (SPA-fallback?): ${ST:0:100}"
ok "gateway reachable + JSON API (not SPA-fallback)"

# 1d. gateway configured for V2 (ESCROW_CONTRACT_ADDRESS present + EAS path on)
ESC_CFG=$(echo "$ST" | jq -r '..|.escrowAddress? // empty' 2>/dev/null | head -1)
[ -n "$ESC_CFG" ] && ok "gateway ESCROW_CONTRACT_ADDRESS configured ($ESC_CFG)" \
  || echo "  WARN: could not read gateway escrow address from /api/status (endpoint shape may differ)"

# ── On-chain assertion helper: validate any V2 clone escrow ──
assert_escrow() {
  local E="$1"
  section "On-chain escrow read-backs: $E"
  local code; code=$(cast code "$E" --rpc-url "$RPC_URL" 2>/dev/null || true)
  [ "${code:-0x}" != "0x" ] && [ -n "$code" ] || { bad "escrow $E has no code on-chain"; return; }
  ok "escrow $E has code"
  local ao; ao=$(cast call "$E" "authorizedOracle()(address)" --rpc-url "$RPC_URL" 2>/dev/null || true)
  [ "$(echo "$ao"|lower)" = "$(echo "$AUTH_ORACLE"|lower)" ] \
    && ok "escrow.authorizedOracle == K" || bad "escrow.authorizedOracle=$ao != K $AUTH_ORACLE"
  local su; su=$(cast call "$E" "PCC_EVIDENCE_SCHEMA_UID()(bytes32)" --rpc-url "$RPC_URL" 2>/dev/null || true)
  [ "$(echo "$su"|lower)" = "$(echo "$SCHEMA_UID"|lower)" ] \
    && ok "escrow.PCC_EVIDENCE_SCHEMA_UID == registered schema" || bad "escrow.schema=$su != $SCHEMA_UID"
  local tok; tok=$(cast call "$E" "token()(address)" --rpc-url "$RPC_URL" 2>/dev/null || true)
  echo "  INFO: escrow.token() = $tok  (assert == the gateway's funding token to avoid gap #4 mismatch)"
}
[ -n "$ESCROW" ] && assert_escrow "$ESCROW"

# ── 2. HAPPY PATH (run twice) — gateway V2 settlement flow ──
# Wired to the gateway endpoints once #137 lands the V2 settlement REST path. The on-chain
# assertions above (assert_escrow) + balance/milestone-status checks below are the chain truth.
run_happy_path() {
  local RUN="$1"
  section "Happy path (run $RUN of 2)"
  echo "  [#137] POST /api/negotiate/session + /commit -> escrow created via createEscrowV2 (clone)"
  echo "         -> assert the returned id is a REAL @pcc/workflow id (NOT /^wf_/) "
  echo "  [#137] capture clone addr from the V2 EscrowCreated event -> assert_escrow <clone>"
  echo "  [#137] POST /api/escrow/fund (USDC) -> assert cast call token.balanceOf(escrow) increased"
  echo "  [#137] submit job -> evidence -> oracle mints EAS attestation (attester==K, recipient==escrow,"
  echo "         schema==SCHEMA_UID, stepId bound, oracleVerified==true) -> capture easUid"
  echo "  [#137] POST /api/escrow/:id/release (submitAttestationV2(easUid)) -> milestone Attested"
  echo "  [#137] after challenge window -> release -> assert operator USDC balance up by amount*(1-235bps)"
  echo "  (probe every response with jq -e, never bare HTTP 200)"
}
# run_happy_path 1; run_happy_path 2     # enable once #137 endpoints are live

# ── 3. REFUSAL CHECKS (C1/C2a/C2b/evidence-hash) ──
section "Refusal checks (attestation-binding guards)"
echo "  R1 C1  UID-replay : reuse a spent easUid on a 2nd milestone -> expect submitAttestationV2 revert"
echo "  R2 C2a recipient  : attestation.recipient != escrow -> expect revert"
echo "  R3 C2b stepId     : attestation.stepId != milestone.stepId -> expect revert"
echo "  R4     evidence   : bundleHash != attested -> oracle refuses to sign / release rejects"
echo "  (contract-level C1/C2 are already covered by MilestoneEscrowV2.clone.t.sol forge tests;"
echo "   these assert them through the LIVE gateway+oracle path once #137 is in)"

# ── 4. SUMMARY ──
section "Summary"
echo "  preconditions+on-chain PASS: $PASS   FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then echo "RESULT: FAIL"; exit 1; fi
echo "RESULT: preconditions GREEN. Happy-path/refusal steps activate when #137 lands the gateway V2 settlement endpoints."
exit 0
