#!/usr/bin/env bash
# Physical Capability Cloud — operator installer
#
# Usage:
#   curl -fsSL https://capability.network/install.sh | bash
#   curl -fsSL https://capability.network/install.sh | bash -s -- --vendor=hamilton
#
# Flags:
#   --vendor=<TYPE>      hamilton | opentrons | octoprint | sila | mock (optional; pcc-node finds the devices it can detect)
#   --key=<PCC_API_KEY>  your PCC API key (default: prompt; this installer creates none)
#   --kernel-id=<ID>     custom kernel ID (default: kernel_<hostname>_<timestamp>)
#   --no-start           install pcc-node and save its config, but don't start it (nothing registers until it starts)
#   --no-prompt          fail rather than prompt — for fully-automated runs
#   --gateway=<URL>      override gateway URL (default: https://capability.network)
#   --help, -h           print this help

set -euo pipefail

GATEWAY="${PCC_BASE:-https://capability.network}"
VENDOR=""
VENDOR_GIVEN=0
RETIRED_FLAGS=0
PCC_KEY=""
KERNEL_ID=""
NO_START=0
NO_PROMPT=0

# ── argv parse ─────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --vendor=*)     VENDOR="${arg#*=}"; VENDOR_GIVEN=1 ;;
    --url=*|--user=*|--pass=*) RETIRED_FLAGS=1 ;;
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

if [ "$VENDOR_GIVEN" = "1" ]; then
  case "$VENDOR" in
    hamilton|opentrons|octoprint|sila|mock) ;;
    *) red "unknown vendor: $VENDOR"; exit 2 ;;
  esac
fi
if [ "$RETIRED_FLAGS" = "1" ]; then
  yellow "--url, --user and --pass are not used: pcc-node finds the devices it can detect when it starts."
fi

# ── prompt helpers ─────────────────────────────────────────────────────────
prompt_flag() {
  case "$1" in
    PCC_KEY)    printf '%s' '--key=<PCC_API_KEY>' ;;
  esac
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
cyan "[1/4] checking dependencies"
need() { command -v "$1" >/dev/null 2>&1 || { red "missing: $1 — please install and re-run"; exit 1; }; }
need python3
need pip3
need git
need curl
green "  ✓ python3, pip3, git, curl"

# ── 2. PCC API key ─────────────────────────────────────────────────────────
cyan "[2/4] PCC API key"
if [ -z "$PCC_KEY" ]; then
  echo "  This installer doesn't create PCC API keys. How to get one: https://capability.network/auth.md"
  prompt_password PCC_KEY "Paste a PCC API key (pcc_live_*)"
fi
PCC_KEY="${PCC_KEY#"${PCC_KEY%%[![:space:]]*}"}"
PCC_KEY="${PCC_KEY%"${PCC_KEY##*[![:space:]]}"}"
if [ -z "$PCC_KEY" ]; then
  red "No PCC API key given. Nothing was installed."
  exit 2
fi
green "  ✓ PCC_API_KEY ready"

# ── 3. install pcc-node ────────────────────────────────────────────────────
PCC_NODE_COMMIT="1d11f37203f99eb1c9f2cfcd2b5ccf278e835820"
SPEC="pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud.git@${PCC_NODE_COMMIT}#subdirectory=packages/pcc-node"
cyan "[3/4] installing pcc-node from source (commit ${PCC_NODE_COMMIT:0:12})"
EXTERNAL_MANAGEMENT=$(python3 -c '
import os, sys, sysconfig
if sys.prefix == getattr(sys, "base_prefix", sys.prefix) and not hasattr(sys, "real_prefix") and os.path.isfile(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED")):
    print("externally-managed")
' 2>/dev/null || true)
if [ "$EXTERNAL_MANAGEMENT" = "externally-managed" ]; then
  VENV="$HOME/.pcc-node/venv"
  if python3 -m venv "$VENV" >/dev/null 2>&1; then
    "$VENV/bin/python" -m pip install --quiet --upgrade "$SPEC" \
      || { red "pcc-node install failed"; exit 1; }
    "$VENV/bin/python" -m pip install --quiet --force-reinstall --no-deps "$SPEC" \
      || { red "pcc-node install failed"; exit 1; }
  elif python3 -m venv --without-pip "$VENV" >/dev/null 2>&1 &&
       python3 -m pip --python "$VENV/bin/python" --version >/dev/null 2>&1; then
    python3 -m pip --python "$VENV/bin/python" install --quiet --upgrade "$SPEC" \
      || { red "pcc-node install failed"; exit 1; }
    python3 -m pip --python "$VENV/bin/python" install --quiet --force-reinstall --no-deps "$SPEC" \
      || { red "pcc-node install failed"; exit 1; }
  else
    red "pcc-node was not installed: this system's Python is externally managed, and this installer couldn't set up a virtual environment for pcc-node in $VENV. On Debian and Ubuntu, install the python3-venv package (sudo apt install python3-venv), then run this again."
    exit 1
  fi
else
  pip3 install --user --quiet --upgrade "$SPEC" \
    || { red "pcc-node install failed"; exit 1; }
  pip3 install --user --quiet --force-reinstall --no-deps "$SPEC" \
    || { red "pcc-node install failed"; exit 1; }
fi
if [ "$EXTERNAL_MANAGEMENT" = "externally-managed" ]; then
  NODE_BIN="$VENV/bin/pcc-node"
  if [ ! -x "$NODE_BIN" ]; then
    red "pcc-node install failed"; exit 1
  fi
elif [ -x "$HOME/.local/bin/pcc-node" ]; then
  NODE_BIN="$HOME/.local/bin/pcc-node"
elif NODE_BIN=$(command -v pcc-node); then
  :
else
  red "pcc-node is installed but not on your PATH. Add pip's user scripts directory to PATH, then run: pcc-node start"
  exit 1
fi
green "  ✓ pcc-node installed: $NODE_BIN"

# ── 4. save config or start daemon ─────────────────────────────────────────
KERNEL_ID="${KERNEL_ID:-kernel_$(hostname 2>/dev/null || echo op)_$(date +%s)}"
if [ "$NO_START" = "1" ]; then
  cyan "[4/4] saving pcc-node's config (--no-start: not starting it)"
else
  cyan "[4/4] starting pcc-node daemon"
fi
echo "  gateway:    $GATEWAY"
echo "  kernelId:   $KERNEL_ID"
echo "  api-key:    ${PCC_KEY:0:14}…"
echo

if [ "$NO_START" = "1" ]; then
  GATEWAY="$GATEWAY" PCC_KEY="$PCC_KEY" KERNEL_ID="$KERNEL_ID" \
    NODE_BIN="$NODE_BIN" python3 - <<'PCC_CONFIG'
import os
os.umask(0o077)

import json
import shlex
import stat
import sys
import tempfile

folder = os.path.join(os.environ["HOME"], ".pcc-node")
path = os.path.join(folder, "pcc-node.json")
tmp_path = None
previous_kernel_id = None


def refuse(unsafe_path, kind):
    print(f"Not saving pcc-node's config: {unsafe_path} must be {kind} you own, not a symbolic link. Move it aside, then run this again. pcc-node is installed; nothing was registered.", file=sys.stderr)
    sys.exit(1)


try:
    try:
        os.mkdir(folder, 0o700)
    except FileExistsError:
        pass
    directory = os.lstat(folder)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid():
        refuse(folder, "a directory")
    try:
        existing = os.lstat(path)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode) or existing.st_uid != os.getuid():
            refuse(path, "a regular file")
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "r") as earlier:
                if stat.S_ISREG(os.fstat(earlier.fileno()).st_mode):
                    data = json.load(earlier)
                    old_id = data.get("kernel_id") if isinstance(data, dict) else None
                    if isinstance(old_id, str) and old_id and old_id.isprintable():
                        previous_kernel_id = old_id
        except Exception:
            pass
    data = {"pcc_base": os.environ["GATEWAY"],
            "pcc_api_key": os.environ["PCC_KEY"],
            "kernel_id": os.environ["KERNEL_ID"]}
    fd, tmp_path = tempfile.mkstemp(dir=folder, prefix=".pcc-node.json.")
    with os.fdopen(fd, "w") as saved:
        json.dump(data, saved)
        saved.flush()
        os.fsync(saved.fileno())
    os.replace(tmp_path, path)
    tmp_path = None
except OSError as exc:
    print(f"Could not save pcc-node's config in {path}: {exc.strerror}. pcc-node is installed; nothing was registered.", file=sys.stderr)
    sys.exit(1)
finally:
    if tmp_path is not None:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

if previous_kernel_id is not None:
    print(f"Replaced pcc-node's earlier config in {path}, which named kernel ID {previous_kernel_id}.")
print(f"--no-start: pcc-node's config is saved in {path} (mode 0600). Nothing was registered: pcc-node registers your kernel when it starts.")
print("To start it, run:")
print("  " + shlex.quote(os.environ["NODE_BIN"]) + " start --config-file " + shlex.quote(path))
PCC_CONFIG
  exit 0
fi

export PCC_BASE="$GATEWAY"
export PCC_API_KEY="$PCC_KEY"
export KERNEL_ID

cyan "running: pcc-node start  (Ctrl-C to stop)"
NODE_STDIN=/dev/null
if (exec </dev/tty) 2>/dev/null; then
  NODE_STDIN=/dev/tty
fi
exec "$NODE_BIN" start <"$NODE_STDIN"
