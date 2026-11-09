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
#   --key=<PCC_API_KEY>  your PCC API key (default: prompt; this installer creates none)
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
prompt_flag() {
  case "$1" in
    VENDOR)     printf '%s' '--vendor=<TYPE>' ;;
    INSTR_URL)  printf '%s' '--url=<URL>' ;;
    INSTR_USER) printf '%s' '--user=<USERNAME>' ;;
    INSTR_PASS) printf '%s' '--pass=<PASSWORD>' ;;
    PCC_KEY)    printf '%s' '--key=<PCC_API_KEY>' ;;
  esac
}

prompt() {
  local var_name="$1"; local prompt_text="$2"; local default="${3:-}"; local value
  if [ -n "${!var_name}" ]; then return; fi
  if [ "$NO_PROMPT" = "1" ]; then
    red "missing $var_name and --no-prompt set; aborting"; exit 2
  fi
  if ! (exec </dev/tty) 2>/dev/null; then
    red "No terminal to ask: $prompt_text. Pass $(prompt_flag "$var_name") and run again. Nothing was installed."
    exit 2
  fi
  if [ -n "$default" ]; then
    IFS= read -r -p "$prompt_text [$default]: " value </dev/tty
    printf -v "$var_name" '%s' "${value:-$default}"
  else
    IFS= read -r -p "$prompt_text: " value </dev/tty
    printf -v "$var_name" '%s' "$value"
  fi
}

prompt_password() {
  local var_name="$1"; local prompt_text="$2"; local value
  if [ -n "${!var_name}" ]; then return; fi
  if [ "$NO_PROMPT" = "1" ]; then
    red "missing $var_name and --no-prompt set; aborting"; exit 2
  fi
  if ! (exec </dev/tty) 2>/dev/null; then
    red "No terminal to ask: $prompt_text. Run it in a terminal to type it hidden, or pass $(prompt_flag "$var_name") (a flag shows in the process list and your shell history). Nothing was installed."
    exit 2
  fi
  IFS= read -r -s -p "$prompt_text: " value </dev/tty; echo
  printf -v "$var_name" '%s' "$value"
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
    prompt_password INSTR_USER "OctoPrint API key (X-Api-Key)"
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
  echo "  This installer doesn't create PCC API keys. How to get one: https://capability.network/auth.md"
  prompt_password PCC_KEY "Paste a PCC API key (pcc_live_*)"
fi
if [ -z "$PCC_KEY" ]; then
  red "No PCC API key given. Nothing was installed."
  exit 2
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
    DEVICE_TYPE="machine"; ADAPTER_TYPE="hamilton"; CAPS='["liquid-handler","liquid-handling-prep"]'
    ;;
  opentrons)
    DEVICE_TYPE="machine"; ADAPTER_TYPE="opentrons"; CAPS='["liquid-handler"]'
    ;;
  octoprint)
    DEVICE_TYPE="machine"; ADAPTER_TYPE="octoprint"; CAPS='["fdm"]'
    ;;
  sila)
    DEVICE_TYPE="sensor"; ADAPTER_TYPE="sila"; CAPS='["assay"]'
    ;;
  mock)
    DEVICE_TYPE="machine"; ADAPTER_TYPE="mock"; CAPS='["fdm"]'
    ;;
esac

KERNEL_CONFIG=$(VENDOR="$VENDOR" INSTR_URL="$INSTR_URL" INSTR_USER="$INSTR_USER" \
  INSTR_PASS="$INSTR_PASS" KERNEL_ID="$KERNEL_ID" DEVICE_TYPE="$DEVICE_TYPE" \
  ADAPTER_TYPE="$ADAPTER_TYPE" python3 -c '
import json
import os

vendor = os.environ["VENDOR"]
kernel_id = os.environ["KERNEL_ID"]
config = {"kernelId": kernel_id}
if vendor != "mock":
    config["url"] = os.environ["INSTR_URL"]
if vendor == "hamilton":
    config.update(username=os.environ["INSTR_USER"], password=os.environ["INSTR_PASS"],
                  mockMode=False, pollIntervalMs=3000)
elif vendor == "opentrons":
    config.update(apiVersion="2.18", mockMode=False)
elif vendor == "octoprint":
    config.update(apiKey=os.environ["INSTR_USER"], mockMode=False)
elif vendor == "mock":
    config["mockMode"] = True

print(json.dumps({
  "kernelId": kernel_id,
  "devices": [{
    "id": "dev_" + vendor + "_01",
    "type": os.environ["DEVICE_TYPE"],
    "adapterType": os.environ["ADAPTER_TYPE"],
    "config": config,
  }],
}))
')
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

if [ "$NO_START" = "1" ]; then
  yellow "--no-start specified; environment exported but daemon NOT started."
  yellow "to start later, run: pcc-node start"
  exit 0
fi

cyan "running: pcc-node start  (Ctrl-C to stop)"
if [ -x "$HOME/.local/bin/pcc-node" ]; then
  NODE_BIN="$HOME/.local/bin/pcc-node"
elif NODE_BIN=$(command -v pcc-node); then
  :
else
  red "pcc-node is installed but not on your PATH. Add pip's user scripts directory to PATH, then run: pcc-node start"
  exit 1
fi
NODE_STDIN=/dev/null
if (exec </dev/tty) 2>/dev/null; then
  NODE_STDIN=/dev/tty
fi
exec "$NODE_BIN" start <"$NODE_STDIN"
