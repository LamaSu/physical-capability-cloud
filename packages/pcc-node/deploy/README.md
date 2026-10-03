# Deploying pcc-node with the spawn allowlist

Three layers keep pcc-node from being coerced into running anything other than its pinned device
utilities (`arp`, `dd`, `ffmpeg`, `journalctl`, `sysctl`, `v4l2-ctl`). They are honest about what each
can and cannot guarantee (steward ruling 10/03, verdict 105n).

## Layer 1 (the HARD guarantee) -- AppArmor, at deploy time
[`apparmor/pcc-node`](apparmor/pcc-node) is the profile that actually guarantees "only the pinned
utilities execute". AppArmor is the right mechanism because it has **separate permissions for
execute-as-program (`x`) and executable memory-map (`m`)**. It grants the Python interpreter and the
six utilities execute (`ix`), grants their shared libraries and the ELF loader map-only (`mr`), and
**denies executing the loader as a program** -- so the one gadget an execve-only control cannot close
(`execve(ld.so, [ld, /bin/sh])`, see Layer 2) is refused here. Everything else is denied by default.

```sh
sudo deploy/install.sh                 # loads the profile + installs the unit (no network, no downloads)
sudo systemctl enable --now pcc-node
aa-status | grep pcc-node              # confirm the profile is loaded and enforced
aa-exec -p pcc-node -- /bin/sh -c true  # must print: Permission denied
```

Requires AppArmor enabled on the host. On a SELinux host, write the equivalent policy (execute-allow
the interpreter + utilities, map-only the loader, deny the rest) instead. The shipped unit sets
`AppArmorProfile=pcc-node` with **no** `-` prefix, so if the profile is not loaded the service *fails*
-- a host never silently loses Layer 1. **Runtime efficacy needs a per-distro host matrix** (profile
enforced; python + extensions load; each utility runs; a shell, a `/tmp` ELF, and `ld.so <non-pinned>`
all refused). That matrix is an operator/infra task -- it is not provable inside a lane worktree.

## Layer 2 (in-process, PARTIAL) -- Landlock, automatic at startup
pcc-node applies a Landlock ruleset itself (`pcc_node/_landlock.py`, via the guarded entry) before any
CLI dependency imports: it grants `execute` only on the pinned utilities + their loader, then
`restrict_self` (irreversible, unprivileged, no root). This blocks the **direct** `execve` of any
non-pinned binary (a shell, a `/tmp` ELF) at the kernel, as defence-in-depth.

It is **not** a complete allowlist. Landlock's execute right governs `execve`, not `mmap(PROT_EXEC)`
(the same property that lets C-extensions load). A dynamically-linked binary can only run if its loader
is execute-granted, and once it is, `execve(ld.so, [ld, <any ELF>])` runs that ELF -- the loader maps
it. Verified in-lane (`tests/test_landlock.py` pins both the blocks and this residual). Closing the
residual is Layer 1's job (AppArmor's `x`≠`m`). Where Landlock is unavailable pcc-node refuses to arm
device execution.

## Layer 3 -- the Python spawn guard (accidental-spawn check)
`pcc_node.spawn_guard` installs a PEP 578 audit hook at startup that refuses a *careless or mistaken*
spawn in pcc-node's own code, however it is reached. It is **not** a sandbox against code already
running in the process -- ordinary Python can mutate a captured function or race a `preexec_fn`/thread.
That is what Layers 1 and 2 are for.

## Launch pcc-node correctly
Always launch via **`python3 -I -m pcc_node`** (or the `pcc-node` console script). `-I` (isolated mode)
ignores `PYTHONPATH` and user site-packages, so nothing there can run before the guards install. Do
**not** run `python -m pcc_node.cli` -- it is refused (it would run unguarded).

## The systemd unit is hygiene only
[`pcc-node.service`](pcc-node.service) no longer tries to be the exec allowlist (the retired
`NoExecPaths=/` + `ExecPaths=` could not split `mmap` from `execve`, verdict 105m). It now provides a
dedicated ephemeral user (`DynamicUser=yes`), persistent key/state under `/var/lib/pcc-node`
(`StateDirectory=`), config under `/etc/pcc-node` (`ConfigurationDirectory=`), a non-interactive
bootstrap (`start --yes`), `NoNewPrivileges=yes`, an empty capability set, and `ProtectSystem=strict`.
Put `PCC_API_KEY` (and any `KERNEL_CONFIG_FILE`) in `/etc/pcc-node/pcc-node.env` (root-only, `chmod
600`), never in the unit. These directives need **systemd ≥ 239** (`ConfigurationDirectory=`;
`DynamicUser=` needs ≥ 232, `StateDirectory=` ≥ 235).

## Windows
The guards are **not enforced on Windows** (the device utilities are POSIX; a Windows exec-allowlist is
tracked follow-up that needs a Windows host). Run pcc-node's device operations on a POSIX host.
