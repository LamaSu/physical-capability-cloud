#!/bin/sh
# Install pcc-node as a hardened systemd service (steward ruling 10/03, verdict 105n). The hard exec
# allowlist is two kernel layers TOGETHER (neither alone), plus an accidental-spawn hook:
#   AppArmor  deploy/apparmor/pcc-node -- loaded here; closes the loader residual Landlock leaves.
#   Landlock  applied in-process by pcc-node at startup (mandatory; no action here); closes python3 re-exec.
#   Hook      the PEP 578 spawn hook, installed in-process (no action needed here).
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

# Config dir for the operator's secrets (PCC_API_KEY). systemd also
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

# Load the AppArmor profile. With the mandatory in-process Landlock it forms the hard exec allowlist
# (AppArmor closes the loader residual); the unit's AppArmorProfile=pcc-node makes the service FAIL if
# it is not loaded, so do this before enabling the unit.
if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -r -W "$HERE/apparmor/pcc-node"
    echo "install.sh: loaded AppArmor profile 'pcc-node' (L1 exec allowlist)"
else
    echo "install.sh: WARNING -- apparmor_parser not found. Half the hard exec allowlist (AppArmor," >&2
    echo "            which closes the loader residual) is NOT in force. Use a SELinux-equivalent" >&2
    echo "            policy, or edit the unit to drop AppArmorProfile= only after accepting that the" >&2
    echo "            loader gadget is open and only mandatory Landlock + the spawn hook remain. See deploy/README.md." >&2
fi

# Install the unit, pointing ExecStart at the resolved interpreter.
sed "s|^ExecStart=/usr/bin/python3|ExecStart=$PYTHON|" "$TEMPLATE" > "$UNIT"
systemctl daemon-reload

echo "install.sh: wrote $UNIT. Enable with: systemctl enable --now pcc-node"
echo "install.sh: VERIFY before relying on it --"
echo "            aa-status | grep pcc-node                 # profile loaded + enforced"
echo "            systemd-analyze security pcc-node          # hygiene (NoNewPrivileges, dirs)"
echo "            then confirm a shell is refused and the node still starts (deploy/README.md)."
