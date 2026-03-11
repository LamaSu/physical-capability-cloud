#!/bin/bash
# Deploy PCC contracts to Base Sepolia
#
# Usage: ./script/deploy.sh
#
# Required env vars:
#   DEPLOYER_PRIVATE_KEY  — private key for deploying
#
# Optional env vars:
#   RPC_URL              — RPC endpoint (default: https://sepolia.base.org)
#   ARBITER_ADDRESS      — arbiter address (default: deployer address)
#   ETHERSCAN_API_KEY    — BaseScan API key for contract verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

RPC_URL="${RPC_URL:-https://sepolia.base.org}"

# Validate required env vars
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
    echo "Error: DEPLOYER_PRIVATE_KEY is required"
    echo "  export DEPLOYER_PRIVATE_KEY=0x..."
    exit 1
fi

echo "=== PCC Contract Deployment ==="
echo "Network:  ${RPC_URL}"
echo ""

# Build verification flags
VERIFY_FLAGS=""
if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    VERIFY_FLAGS="--verify --etherscan-api-key $ETHERSCAN_API_KEY"
    echo "Verification: enabled (BaseScan)"
else
    echo "Verification: skipped (set ETHERSCAN_API_KEY to enable)"
fi

echo ""
echo "Deploying..."
echo ""

forge script script/Deploy.s.sol:DeployScript \
    --rpc-url "$RPC_URL" \
    --broadcast \
    $VERIFY_FLAGS \
    -vvvv

echo ""
echo "=== Deployment complete ==="
echo "Check broadcast/ for deployment artifacts."
