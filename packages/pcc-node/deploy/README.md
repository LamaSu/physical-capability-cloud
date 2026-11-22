# Running pcc-node under the spawn allowlist

Three layers are meant to keep pcc-node from being coerced into running anything other than its pinned
device utilities (`arp`, `dd`, `ffmpeg`, `journalctl`, `sysctl`, `v4l2-ctl`). This package ships two of
them: Landlock (Layer 2) and the Python spawn guard (Layer 3). Layer 1, an AppArmor profile applied at
deploy time, comes in a later change together with a systemd unit, after a run on a real host has
proved both. Each section below says what its layer does and does not guarantee.

## The full guarantee needs both Landlock and AppArmor
Neither kernel layer alone gives "only the pinned utilities execute":
- **AppArmor alone is incomplete.** pcc-node *is* a Python process, so a profile must grant `python3`
  execute for it to run at all. An execute grant on an interpreter is an arbitrary-code gadget: a
  compromised process can `execve(python3, ["-c", <anything>])`, which also escapes the in-process hook
  (Layer 3).
- **Landlock alone is incomplete.** A dynamically linked binary needs its ELF loader execute-granted,
  and Landlock does not mediate `mmap(PROT_EXEC)`, so `execve(ld.so, [ld, <any ELF>])` runs that ELF.

Together they close both paths: Landlock refuses to execute `python3` (and every other non-pinned
binary) directly, and an AppArmor profile can refuse to execute the loader as a program. Until Layer 1
lands, the loader path stays open.

## Layer 2 -- Landlock, in process and mandatory
pcc-node applies a Landlock ruleset itself (`pcc_node/_landlock.py`, through the guarded entry) before
any CLI dependency imports: it grants `execute` only on the pinned utilities and their loader, then
calls `restrict_self` (irreversible, unprivileged, no root). This blocks the **direct** `execve` of any
non-pinned binary, **including re-executing `python3`**, which is the path AppArmor cannot close.

Landlock needs Linux 5.13 or later with Landlock enabled. It is applied first and is **mandatory**: if
Landlock is unavailable or cannot be applied, `pcc_node._entry` **refuses to run**, after a warning that
names the cause. An operator who accepts the weaker posture may set `PCC_ALLOW_NO_LANDLOCK=1` to run
anyway, **but the node then runs UNARMED**: the spawn guard (Layer 3) is installed with `armed=False`,
so it **refuses every device-utility spawn** and no device command executes (the node still registers
and serves status). That unarmed state is enforced in code. Landlock does not close the loader gadget;
`tests/test_landlock.py` pins both the blocks and that residual at runtime.

## Layer 3 -- the Python spawn guard (accidental-spawn check)
`pcc_node.spawn_guard` installs a PEP 578 audit hook at startup. It refuses a *careless or mistaken*
spawn in pcc-node's own code made through any audited call, and it refuses loading a native library
through `ctypes`. It is **not** a sandbox against code already running in the process: ordinary Python
can mutate a captured function or race a `preexec_fn` or a thread. The kernel layers are for that.

**mDNS discovery is off under the guard.** With zeroconf installed (the `discovery` and `all` extras),
its interface lookup (ifaddr) loads a native library, which the hook refuses whether it is armed or
not, so the node logs one INFO line and finds no mDNS devices.

## Launch pcc-node correctly
- **`python3 -I -m pcc_node`** is the only form that ignores `PYTHONPATH` and user site-packages
  (isolated mode), so nothing there can run before the guards install.
- **The `pcc-node` console script** also starts through the guarded entry, but it runs without `-I`:
  `PYTHONPATH` and user site-packages, with their `.pth` files, are processed before the guards install.
- **An editable install made before** the console script moved to `pcc_node._entry:run` keeps a script
  that starts `pcc_node.cli:main`, unguarded, because pip writes console scripts at install time.
  Reinstall it so that the script starts through the entry.
- Do **not** run `python -m pcc_node.cli`: it is refused, since it would run unguarded.

## Windows and macOS
Landlock is Linux only. On Windows and macOS, `restrict()` returns False before any Linux call, so
pcc-node refuses to start, as it does on a Linux host without Landlock, unless `PCC_ALLOW_NO_LANDLOCK=1`
is set. With it set:
- on macOS, the spawn guard installs unarmed and refuses every device command;
- on Windows, the spawn guard is not installed, so nothing is refused. A Windows exec allowlist is
  follow-up work that needs a Windows host.

Run pcc-node's device operations on a Linux host with Landlock.
