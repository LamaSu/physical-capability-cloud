#!/usr/bin/env bash
# Physical Capability Cloud — operator installer
#
# Usage:
#   curl -fsSL https://capability.network/install.sh | bash
#   curl -fsSL https://capability.network/install.sh | bash -s -- --vendor=hamilton
#   curl -fsSL https://capability.network/install.sh | bash -s -- --vendor=hamilton --url=http://192.168.1.50 --user=alice
#
# Flags:
#   --vendor=<TYPE>      hamilton | opentrons | octoprint | sila | mock (default: prompt)
#   --url=<URL>          instrument URL on the LAN (default: prompt)
#   --user=<USERNAME>    instrument username/api-key (default: prompt; type-dependent)
#   --pass=<PASSWORD>    instrument password (default: prompt; only Hamilton needs this)
#   --key=<PCC_API_KEY>  pre-issued PCC API key (default: auto-provision)
#   --kernel-id=<ID>     custom kernel ID (default: kernel_<hostname>_<timestamp>)
#   --no-start           generate config + register but don't start the daemon
#   --no-prompt          fail rather than prompt — for fully-automated runs
#   --gateway=<URL>      override gateway URL (default: https://capability.network)
#   --help, -h           print this help

set -euo pipefail

GATEWAY="${PCC_BASE:-https://capability.network}"
VENDOR=""
INSTR_URL=""
INSTR_USER=""
INSTR_PASS=""
PCC_KEY=""
KERNEL_ID=""
NO_START=0
NO_PROMPT=0

# ── argv parse ─────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --vendor=*)     VENDOR="${arg#*=}" ;;
    --url=*)        INSTR_URL="${arg#*=}" ;;
    --user=*)       INSTR_USER="${arg#*=}" ;;
    --pass=*)       INSTR_PASS="${arg#*=}" ;;
    --key=*)        PCC_KEY="${arg#*=}" ;;
    --kernel-id=*)  KERNEL_ID="${arg#*=}" ;;
    --no-start)     NO_START=1 ;;
    --no-prompt)    NO_PROMPT=1 ;;
    --gateway=*)    GATEWAY="${arg#*=}" ;;
    --help|-h)      grep '^# ' "$0" | sed 's/^# //'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

cyan()   { printf "\033[36m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }

cyan "
╔═══════════════════════════════════════════════════════════╗
║  Physical Capability Cloud — operator install             ║
║  https://capability.network                               ║
╚═══════════════════════════════════════════════════════════╝
"

# ── prompt helpers ─────────────────────────────────────────────────────────
prompt() {
  local var_name="$1"; local prompt_text="$2"; local default="${3:-}"
  if [ -n "${!var_name}" ]; then return; fi
  if [ "$NO_PROMPT" = "1" ]; then
    red "missing $var_name and --no-prompt set; aborting"; exit 2
  fi
  if [ -n "$default" ]; then
    read -r -p "$prompt_text [$default]: " value
    eval "$var_name=\"\${value:-\$default}\""
  else
    read -r -p "$prompt_text: " value
    eval "$var_name=\"\$value\""
  fi
}

prompt_password() {
  local var_name="$1"; local prompt_text="$2"
  if [ -n "${!var_name}" ]; then return; fi
  if [ "$NO_PROMPT" = "1" ]; then
    red "missing $var_name and --no-prompt set; aborting"; exit 2
  fi
  read -r -s -p "$prompt_text: " value; echo
  eval "$var_name=\"\$value\""
}

# ── 1. dependencies ────────────────────────────────────────────────────────
cyan "[1/6] checking dependencies"
need() { command -v "$1" >/dev/null 2>&1 || { red "missing: $1 — please install and re-run"; exit 1; }; }
need python3
need pip3
need git
need curl
green "  ✓ python3, pip3, git, curl"

# ── 2. vendor + creds ──────────────────────────────────────────────────────
cyan "[2/6] gathering instrument details"
prompt VENDOR "Vendor (hamilton | opentrons | octoprint | sila | mock)"
case "$VENDOR" in
  hamilton)
    prompt INSTR_URL    "Hamilton instrument URL (e.g. http://192.168.1.50)"
    prompt INSTR_USER   "Hamilton username"
    prompt_password INSTR_PASS "Hamilton password"
    ;;
  opentrons)
    prompt INSTR_URL  "Opentrons URL (e.g. http://192.168.1.51:31950)"
    ;;
  octoprint)
    prompt INSTR_URL  "OctoPrint URL (e.g. http://192.168.1.52:5000)"
    prompt INSTR_USER "OctoPrint API key (X-Api-Key)"
    ;;
  sila)
    prompt INSTR_URL  "SiLA server URL (e.g. https://192.168.1.53:50051)"
    ;;
  mock)
    INSTR_URL="http://192.0.2.1"; INSTR_USER="demo"; INSTR_PASS="demo"
    ;;
  *) red "unknown vendor: $VENDOR"; exit 2 ;;
esac
green "  ✓ vendor=$VENDOR url=$INSTR_URL"

# ── 3. PCC API key ─────────────────────────────────────────────────────────
cyan "[3/6] PCC API key"
if [ -z "$PCC_KEY" ]; then
  HOST=$(hostname 2>/dev/null || echo "operator")
  RESP=$(curl -fsS -X POST "$GATEWAY/api/auth/provision" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$HOST-installer\"}" || true)
  PCC_KEY=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('api_key',''))" 2>/dev/null || true)
  if [ -z "$PCC_KEY" ]; then
    yellow "  could not auto-provision (rate-limited or network)."
    yellow "  response: $RESP"
    prompt PCC_KEY "Paste a PCC API key (pcc_live_*)"
  fi
fi
green "  ✓ PCC_API_KEY ready"

# ── 4. install pcc-node ────────────────────────────────────────────────────
cyan "[4/6] installing pcc-node (git+source for newest adapters)"
pip3 install --user --quiet --upgrade \
  "git+https://github.com/LamaSu/physical-capability-cloud.git#subdirectory=packages/pcc-node" \
  || { red "pcc-node install failed"; exit 1; }
green "  ✓ pcc-node installed"

# ── 5. KERNEL_CONFIG ───────────────────────────────────────────────────────
cyan "[5/6] generating KERNEL_CONFIG"
KERNEL_ID="${KERNEL_ID:-kernel_$(hostname 2>/dev/null || echo op)_$(date +%s)}"
case "$VENDOR" in
  hamilton)
    DEVICE_CONFIG=$(python3 -c "import json;print(json.dumps({'url':'$INSTR_URL','username':'$INSTR_USER','password':'$INSTR_PASS','kernelId':'$KERNEL_ID','mockMode':False,'pollIntervalMs':3000}))")
    DEVICE_TYPE="machine"; ADAPTER_TYPE="hamilton"; CAPS='["liquid-handler","liquid-handling-prep"]'
    ;;
  opentrons)
    DEVICE_CONFIG=$(python3 -c "import json;print(json.dumps({'url':'$INSTR_URL','apiVersion':'2.18','kernelId':'$KERNEL_ID','mockMode':False}))")
    DEVICE_TYPE="machine"; ADAPTER_TYPE="opentrons"; CAPS='["liquid-handler"]'
    ;;
  octoprint)
    DEVICE_CONFIG=$(python3 -c "import json;print(json.dumps({'url':'$INSTR_URL','apiKey':'$INSTR_USER','kernelId':'$KERNEL_ID','mockMode':False}))")
    DEVICE_TYPE="machine"; ADAPTER_TYPE="octoprint"; CAPS='["fdm"]'
    ;;
  sila)
    DEVICE_CONFIG=$(python3 -c "import json;print(json.dumps({'url':'$INSTR_URL','kernelId':'$KERNEL_ID'}))")
    DEVICE_TYPE="sensor"; ADAPTER_TYPE="sila"; CAPS='["assay"]'
    ;;
  mock)
    DEVICE_CONFIG=$(python3 -c "import json;print(json.dumps({'kernelId':'$KERNEL_ID','mockMode':True}))")
    DEVICE_TYPE="machine"; ADAPTER_TYPE="mock"; CAPS='["fdm"]'
    ;;
esac

KERNEL_CONFIG=$(python3 -c "
import json
print(json.dumps({
  'kernelId': '$KERNEL_ID',
  'devices': [{
    'id': 'dev_${VENDOR}_01',
    'type': '$DEVICE_TYPE',
    'adapterType': '$ADAPTER_TYPE',
    'config': $DEVICE_CONFIG,
  }],
}))
")
green "  ✓ kernelId=$KERNEL_ID adapterType=$ADAPTER_TYPE"

# ── 6. start daemon ────────────────────────────────────────────────────────
export PCC_BASE="$GATEWAY"
export PCC_API_KEY="$PCC_KEY"
export KERNEL_ID
export KERNEL_CONFIG

cyan "[6/6] starting pcc-node daemon"
echo "  gateway:    $GATEWAY"
echo "  kernelId:   $KERNEL_ID"
echo "  api-key:    ${PCC_KEY:0:14}…"
echo "  capability: $CAPS"
echo
green "Operator dashboard will appear at:"
echo "  $GATEWAY/operator/$KERNEL_ID"
echo

if [ "$NO_START" = "1" ]; then
  yellow "--no-start specified; environment exported but daemon NOT started."
  yellow "to start later, run: pcc-node start"
  exit 0
fi

cyan "running: pcc-node start  (Ctrl-C to stop)"
exec "$HOME/.local/bin/pcc-node" start || exec pcc-node start
