#!/usr/bin/env bash
# demo-pizza.sh — open the vibecodenights pizza demo URLs.
#
# Usage:
#   PCC_BASE=https://capability.network ./scripts/demo-pizza.sh
#   PCC_BASE=http://localhost:8080 PCC_API_KEY=pcc_live_... ./scripts/demo-pizza.sh seed
set -euo pipefail
BASE="${PCC_BASE:-https://capability.network}"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/sse/demo/firehose") || true
if [[ "$code" == "404" ]]; then
  echo "The pizza demo is off on $BASE."
  exit 1
fi

if [[ "${1:-}" == "seed" ]]; then
  echo "▣ seeding providers..."
  pnpm tsx scripts/seed-pizza-demo.ts
  exit
fi

if [[ "${1:-}" == "reset" ]]; then
  echo "▣ resetting demo state..."
  auth=()
  if [[ -n "${PCC_API_KEY:-}" ]]; then
    auth=(-H "Authorization: Bearer $PCC_API_KEY")
  fi
  response=$(curl -s -X POST "${auth[@]}" -w '\n%{http_code}' "$BASE/api/demo/_reset") || true
  code="${response##*$'\n'}"
  if [[ "$code" == 2[0-9][0-9] ]]; then
    printf '%s' "${response%$'\n'*}" | head -c 200 || true
    echo ""
    exit 0
  fi
  echo "reset failed: HTTP $code"
  exit 1
fi

echo "▣ vibecodenights pizza demo URLs"
echo ""
echo "user (orderer):"
echo "  $BASE/order.html"
echo ""
echo "shops (open one per shop operator on separate device):"
echo "  $BASE/operator.html?shop=shop-roma"
echo "  $BASE/operator.html?shop=shop-slice-heaven"
echo "  $BASE/operator.html?shop=shop-mamas-kitchen"
echo ""
echo "drivers (open one per driver on separate device):"
echo "  $BASE/driver.html?driver=driver-alex"
echo "  $BASE/driver.html?driver=driver-beth"
echo "  $BASE/driver.html?driver=driver-carlos"
echo "  $BASE/driver.html?driver=driver-dana"
echo ""
echo "first-time setup:"
echo "  $0 seed       # register all 3 shops + 4 drivers + 12 graph edges"
echo "  $0 reset      # wipe in-memory order/job state"
echo ""
echo "demo flow:"
echo "  1. open user URL on phone, pick a pizza, set budget"
echo "  2. compose engine picks cheapest shop × driver"
echo "  3. user confirms → make-pizza job dispatched"
echo "  4. shop's URL gets the job (SSE pushes it live)"
echo "  5. shop accepts, makes pizza, marks done"
echo "  6. driver's URL gets the delivery job"
echo "  7. driver accepts, picks up, delivers"
echo "  8. user's URL shows delivered + settlement + reputation"
