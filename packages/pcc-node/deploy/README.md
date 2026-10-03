# Deploying pcc-node with the spawn allowlist

Three layers keep pcc-node from being coerced into running anything other than its pinned device
utilities (`arp`, `dd`, `ffmpeg`, `journalctl`, `sysctl`, `v4l2-ctl`). They are honest about what each
can and cannot guarantee (steward ruling 10/03, verdicts 105n).

## The hard guarantee needs BOTH Landlock and AppArmor
Neither kernel layer alone gives "only the pinned utilities execute":
- **AppArmor alone is incomplete.** pcc-node *is* a Python process, so the profile must grant `python3`
  execute to run at all. An execute grant on an interpreter is an arbitrary-code gadget: a compromised
  process can `execve(python3, ["-c", <anything>])`, which also escapes the in-process hook (Layer 3).
- **Landlock alone is incomplete.** A dynamically-linked binary needs its ELF loader execute-granted,
  and Landlock does not mediate `mmap(PROT_EXEC)`, so `execve(ld.so, [ld, <any ELF>])` runs that ELF.

They are complementary, so the hard guarantee is the two **together**: Landlock refuses to execute
`python3` (and every other non-pinned binary) directly; AppArmor refuses to execute the loader as a
program. **pcc-node therefore refuses to run when Landlock is unavailable** (see "Layer 2"), so the
guarantee never rests on AppArmor alone.

## Layer 1 -- AppArmor, at deploy time
[`apparmor/pcc-node`](apparmor/pcc-node) grants the interpreter and the six utilities execute (`ix`),
grants their shared libraries and the ELF loader map-only (`mr`), and **denies executing the loader as
a program** -- closing the `execve(ld.so, ...)` gadget Landlock leaves. Everything else is denied by
default; shells are denied explicitly. It also grants the camera paths the pinned utilities use
(`/dev/video*`, the frame scratch file).

```sh
sudo deploy/install.sh                 # loads the profile + installs the unit (no network, no downloads)
sudo systemctl enable --now pcc-node
aa-status | grep pcc-node              # confirm the profile is loaded and enforced
aa-exec -p pcc-node -- /bin/sh -c true  # must print: Permission denied
```

Requires AppArmor enabled on the host. On a SELinux host, write the equivalent policy. The shipped unit
sets `AppArmorProfile=pcc-node` with **no** `-` prefix, so if the profile is not loaded the service
*fails* -- a host never silently loses Layer 1. **Runtime efficacy needs a per-distro host matrix**
that exercises REAL operations (profile enforced; python + extensions load; each utility runs its
actual capture/probe, not just `--version`; a shell, a `/tmp` ELF, `ld.so <non-pinned>`, and
`python3 -c` of a non-pinned exec all refused). That matrix is an operator/infra task -- it is not
provable inside a lane worktree. `apparmor_parser -p apparmor/pcc-node` preprocesses the profile here;
full compile/load needs root.

## Layer 2 -- Landlock, in-process and MANDATORY
pcc-node applies a Landlock ruleset itself (`pcc_node/_landlock.py`, via the guarded entry) before any
CLI dependency imports: it grants `execute` only on the pinned utilities + their loader, then
`restrict_self` (irreversible, unprivileged, no root). This blocks the **direct** `execve` of any
non-pinned binary -- **including re-executing `python3`**, which is the path AppArmor cannot close.

It is applied FIRST and is **mandatory**: if Landlock is unavailable, `pcc_node._entry` **refuses to
run** (exit) rather than fall back to AppArmor alone. An operator who accepts the weaker posture (Layer
1 + Layer 3 only, and the operating runtime left unarmed) may set `PCC_ALLOW_NO_LANDLOCK=1` to run
anyway. Landlock does not close the loader gadget (that is Layer 1's job); `tests/test_landlock.py`
pins both the blocks and that residual at runtime.

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
`NoExecPaths=/` + `ExecPaths=` could not split `mmap` from `execve`, verdict 105m). It provides a
dedicated ephemeral user (`DynamicUser=yes`), persistent key/state under `/var/lib/pcc-node`
(`StateDirectory=`), config under `/etc/pcc-node` (`ConfigurationDirectory=`), a non-interactive
bootstrap, `NoNewPrivileges=yes`, an empty capability set, and `ProtectSystem=strict`. Because
`ProtectSystem=strict` makes the working directory (`/`) read-only, `ExecStart` passes an **absolute**
`--config-file /var/lib/pcc-node/pcc-node.json` so the node can persist its config (the CLI default
`./pcc-node.json` would fail to write). Put `PCC_API_KEY` in `/etc/pcc-node/pcc-node.env` (root-only,
`chmod 600`), never in the unit. These directives need **systemd ≥ 239** (`ConfigurationDirectory=`;
`DynamicUser=` needs ≥ 232, `StateDirectory=` ≥ 235).

## Windows
The guards are **not enforced on Windows** (the device utilities are POSIX; a Windows exec-allowlist is
tracked follow-up that needs a Windows host). Run pcc-node's device operations on a POSIX host.
