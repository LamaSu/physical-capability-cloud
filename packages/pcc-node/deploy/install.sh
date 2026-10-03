#!/bin/sh
# Install pcc-node as a hardened systemd service (steward ruling 10/03, verdict 105n). Three layers keep
# pcc-node from being coerced into running anything but its pinned device utilities:
#   L1 (HARD)    AppArmor profile deploy/apparmor/pcc-node -- loaded here; the OS exec allowlist.
#   L2 (partial) Landlock, applied in-process by pcc-node itself at startup (no action needed here).
#   L3           the PEP 578 spawn hook, installed in-process (no action needed here).
# This script installs the unit, loads the AppArmor profile, and prepares /etc/pcc-node. Clean-room:
# no network, no downloads. Run as root (it writes under /etc). It does NOT compute an ExecPaths list:
# systemd NoExecPaths/ExecPaths was retired (verdict 105m -- it cannot split mmap from execve).
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMPLATE="$HERE/pcc-node.service"
UNIT=/etc/systemd/system/pcc-node.service
CONFDIR=/etc/pcc-node

PYTHON=$(command -v python3 || true)
[ -n "$PYTHON" ] || { echo "install.sh: python3 not found on PATH" >&2; exit 1; }

# Config dir for the operator's secrets (PCC_API_KEY) and optional KERNEL_CONFIG_FILE. systemd also
# creates it via ConfigurationDirectory=, but we seed a template env file now so first boot is clean.
mkdir -p "$CONFDIR"
if [ ! -e "$CONFDIR/pcc-node.env" ]; then
    cat > "$CONFDIR/pcc-node.env" <<'ENV'
# pcc-node service environment. Secrets live here, not in the unit (root-only; chmod 600).
# PCC_API_KEY=pcc_live_...
ENV
    chmod 600 "$CONFDIR/pcc-node.env"
    echo "install.sh: wrote template $CONFDIR/pcc-node.env (add PCC_API_KEY, chmod 600 kept)"
fi

# L1: load the AppArmor profile. This is the hard exec allowlist; the unit's AppArmorProfile=pcc-node
# makes the service FAIL if it is not loaded, so do this before enabling the unit.
if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -r -W "$HERE/apparmor/pcc-node"
    echo "install.sh: loaded AppArmor profile 'pcc-node' (L1 exec allowlist)"
else
    echo "install.sh: WARNING -- apparmor_parser not found. L1 (the hard exec allowlist) is NOT in" >&2
    echo "            force. Use a SELinux-equivalent policy, or edit the unit to drop" >&2
    echo "            AppArmorProfile= only after accepting that only L2 (Landlock, partial) + L3" >&2
    echo "            (the spawn hook) remain. See deploy/README.md." >&2
fi

# Install the unit, pointing ExecStart at the resolved interpreter.
sed "s|^ExecStart=/usr/bin/python3|ExecStart=$PYTHON|" "$TEMPLATE" > "$UNIT"
systemctl daemon-reload

echo "install.sh: wrote $UNIT. Enable with: systemctl enable --now pcc-node"
echo "install.sh: VERIFY before relying on it --"
echo "            aa-status | grep pcc-node                 # profile loaded + enforced"
echo "            systemd-analyze security pcc-node          # hygiene (NoNewPrivileges, dirs)"
echo "            then confirm a shell is refused and the node still starts (deploy/README.md)."
