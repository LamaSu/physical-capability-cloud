# Deploying pcc-node with the hard spawn allowlist

Two layers keep pcc-node from being coerced into running anything other than its pinned device
utilities (`arp`, `dd`, `ffmpeg`, `journalctl`, `sysctl`, `v4l2-ctl`):

## 1. The OS -- the hard guarantee
The shipped systemd unit denies execute everywhere (`NoExecPaths=/`) and re-allows only the Python
interpreter, its library directories, and the pinned utilities (`ExecPaths=`), with
`NoNewPrivileges=yes`. A shell (`/bin/sh`, `/bin/bash`) is then un-executable. `install.sh` resolves
the paths for your host (the versioned stdlib dir and each utility's real location) and writes the
unit:

```sh
sudo deploy/install.sh
sudo systemctl enable --now pcc-node
systemd-analyze security pcc-node       # confirm NoExecPaths / ExecPaths are in effect
```

`NoExecPaths=`/`ExecPaths=` need systemd >= 248. Where that is unavailable, or on a non-systemd host,
apply the AppArmor fallback in [`apparmor/pcc-node`](apparmor/pcc-node) instead (it allowlists exec of
the same interpreter + utilities and denies the rest) and run pcc-node under it.

## 2. The Python spawn guard -- the accidental-spawn check
`pcc_node.spawn_guard` installs a PEP 578 audit hook at startup that refuses a *careless or mistaken*
spawn in pcc-node's own code, however it is reached. It is **not** a sandbox against code already
running in the process -- ordinary Python can mutate a captured function or race a `preexec_fn`/thread.
That is what layer 1 is for.

## Launch pcc-node correctly
Always launch via **`python3 -I -m pcc_node`** (or the `pcc-node` console script). `-I` (isolated
mode) ignores `PYTHONPATH` and user site-packages, so nothing there can run before the guard installs.
Do **not** run `python -m pcc_node.cli` -- it is refused (it would run unguarded).

## Windows
The spawn guard is **not enforced on Windows** (the device utilities are POSIX; a Windows
exec-allowlist is tracked follow-up that needs a Windows host). Run pcc-node's device operations on a
POSIX host.
