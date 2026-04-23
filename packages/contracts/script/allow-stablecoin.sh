#!/bin/bash
# Allow (or refresh) a stablecoin on a deployed MilestoneEscrow.
#
# Usage:
#   export DEPLOYER_PRIVATE_KEY=0x...
#   export ESCROW_ADDRESS=0x4547ec08...
#   export TOKEN_ADDRESS=0x...
#   export ATTESTOR_ADDRESS=0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B
#   export RESERVE_REPORT_URI="https://..."
#   export MAX_DEVIATION_BPS=100
#   ./script/allow-stablecoin.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RPC_URL="${RPC_URL:-https://sepolia.base.org}"

for v in DEPLOYER_PRIVATE_KEY ESCROW_ADDRESS TOKEN_ADDRESS ATTESTOR_ADDRESS RESERVE_REPORT_URI MAX_DEVIATION_BPS; do
    if [ -z "${!v:-}" ]; then
        echo "Error: $v is required"
        exit 1
    fi
done

echo "=== Allow stablecoin on MilestoneEscrow ==="
echo "RPC:       $RPC_URL"
echo "Escrow:    $ESCROW_ADDRESS"
echo "Token:     $TOKEN_ADDRESS"
echo "Attestor:  $ATTESTOR_ADDRESS"
echo "Report:    $RESERVE_REPORT_URI"
echo "Max dev:   $MAX_DEVIATION_BPS bps"
echo ""

forge script script/AllowStablecoin.s.sol:AllowStablecoinScript \
    --rpc-url "$RPC_URL" \
    --broadcast -vvvv

echo ""
echo "=== Done ==="
