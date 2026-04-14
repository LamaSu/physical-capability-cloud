#!/usr/bin/env bash
# Smoke test for the accounting-reconcile onboarding harness.
#
# Runs the CLI in --dry-run mode against the Quickbooks sample and verifies:
#   1. Exit code is 0.
#   2. REPORT_JSON line is emitted.
#   3. assuranceScore >= 0.8.
#   4. verificationResult == "valid".
#
# Exits 0 on success, non-zero otherwise.

set -euo pipefail

# Resolve the repo root (two levels up from this script).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

SAMPLE="$SCRIPT_DIR/samples/quickbooks-sample.csv"
OUT="$(mktemp -t pcc-smoke-XXXXXX.log)"

echo "[smoke] REPO_ROOT=$REPO_ROOT"
echo "[smoke] Running onboard.ts --dry-run (30s budget)..."
START_TS=$(date +%s)

set +e
npx tsx "$SCRIPT_DIR/onboard.ts" --dry-run --csv "$SAMPLE" > "$OUT" 2>&1
EXIT_CODE=$?
set -e

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo "[smoke] Exit code: $EXIT_CODE (elapsed ${ELAPSED}s)"
echo "[smoke] --- last 40 lines of output ---"
tail -40 "$OUT" || true
echo "[smoke] --- end output ---"

if [ $EXIT_CODE -ne 0 ]; then
  echo "[smoke] FAIL: non-zero exit code"
  exit $EXIT_CODE
fi

# Extract REPORT_JSON line and verify assuranceScore/verificationResult.
REPORT_LINE="$(grep '^REPORT_JSON:' "$OUT" | tail -1 || true)"
if [ -z "$REPORT_LINE" ]; then
  echo "[smoke] FAIL: no REPORT_JSON line in output"
  exit 2
fi

JSON="${REPORT_LINE#REPORT_JSON:}"
echo "[smoke] REPORT_JSON: $JSON"

# Grep-based checks (jq is not guaranteed to be installed).
if ! echo "$JSON" | grep -E '"verificationResult":"valid"' > /dev/null; then
  echo "[smoke] FAIL: verificationResult != valid"
  exit 3
fi

# Pull assuranceScore via grep + awk (portable)
ASSURANCE="$(echo "$JSON" | sed -E 's/.*"assuranceScore":([0-9.]+).*/\1/' || echo 0)"
echo "[smoke] assuranceScore = $ASSURANCE"

# Portable float comparison via awk
OK="$(awk -v a="$ASSURANCE" 'BEGIN { print (a+0 >= 0.8) ? "yes" : "no" }')"
if [ "$OK" != "yes" ]; then
  echo "[smoke] FAIL: assuranceScore ($ASSURANCE) < 0.8"
  exit 4
fi

# Must complete in < 30s per the task's success criteria.
if [ $ELAPSED -gt 30 ]; then
  echo "[smoke] WARN: took ${ELAPSED}s (budget: 30s)"
fi

echo "[smoke] OK -- assuranceScore=$ASSURANCE, verificationResult=valid, elapsed=${ELAPSED}s"
exit 0
