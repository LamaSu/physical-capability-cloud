#!/bin/sh
# Install the hardened pcc-node systemd unit (steward ruling 10/03): the OS enforces that pcc-node
# can execute only its pinned device utilities (NoExecPaths=/ + ExecPaths=<python + libs + utils>,
# NoNewPrivileges=yes). This resolves ExecPaths for THIS host and writes the unit. Clean-room: no
# network, no downloads. Run as root (it writes under /etc/systemd/system).
#
# Where systemd's ExecPaths= is unavailable (systemd < 248, or a non-systemd host), apply the
# AppArmor profile in deploy/apparmor/pcc-node instead (see deploy/README.md).
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMPLATE="$HERE/pcc-node.service"
UNIT=/etc/systemd/system/pcc-node.service

PYTHON=$(command -v python3 || true)
[ -n "$PYTHON" ] || { echo "install.sh: python3 not found on PATH" >&2; exit 1; }

# The interpreter's own library directories, so its C extensions can be mmap'd executable under
# NoExecPaths=/. Resolved from the live interpreter, so the versioned stdlib dir is correct.
LIBDIRS=$("$PYTHON" - <<'PY'
import sys, sysconfig
dirs = {
    sysconfig.get_path("stdlib"), sysconfig.get_path("platstdlib"),
    sysconfig.get_path("purelib"), sysconfig.get_path("platlib"),
    sys.base_prefix + "/lib", sys.base_prefix + "/lib64",
}
print(" ".join(sorted(d for d in dirs if d)))
PY
)

# The pinned device utilities pcc-node runs, by resolved absolute path. A missing one is simply
# omitted (the node treats it as "not installed"); it is never an arbitrary name.
UTILS=""
for u in arp dd ffmpeg journalctl sysctl v4l2-ctl; do
    p=$(command -v "$u" 2>/dev/null || true)
    [ -n "$p" ] && UTILS="$UTILS $p"
done

EXEC_PATHS="$PYTHON $LIBDIRS$UTILS"
echo "install.sh: ExecPaths = $EXEC_PATHS"

# Substitute into the template. '|' delimiter: paths contain '/'.
ESCAPED=$(printf '%s' "$EXEC_PATHS" | sed 's/[&|\\]/\\&/g')
sed "s|@EXEC_PATHS@|$ESCAPED|; s|^ExecStart=/usr/bin/python3|ExecStart=$PYTHON|" "$TEMPLATE" > "$UNIT"

systemctl daemon-reload
echo "install.sh: wrote $UNIT. Enable with: systemctl enable --now pcc-node"
echo "install.sh: verify the sandbox with: systemd-analyze security pcc-node (NoExecPaths/ExecPaths),"
echo "            and confirm 'systemctl start pcc-node' then 'pcc-node status' works before relying on it."
