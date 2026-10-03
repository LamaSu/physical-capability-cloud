"""The ``pcc-node`` console entry point.

It installs the runtime spawn guard (:mod:`pcc_node.spawn_guard`) before importing the CLI and its
dependencies, so no import-time code runs ahead of the hook (verdict 105j HIGH 4). Only this module's
own imports and :mod:`pcc_node.spawn_guard` (stdlib only) load before the guard is up.

The tests call :func:`pcc_node.cli.main` and :func:`pcc_node.daemon.run_daemon` directly, so importing
those -- or this module -- in-process never installs the unremovable hook in the shared test process;
only running the installed ``pcc-node`` script (or :func:`run` below) does.
"""


def run() -> None:
    import shutil

    from . import _landlock, spawn_guard

    # In-process hardening (partial): raise the bar at the kernel before anything else runs -- block
    # the direct execve of non-pinned binaries, irreversibly (steward ruling 10/03). This is NOT the
    # hard "only pinned execute" guarantee: the granted ELF loader remains an exec gadget (see
    # _landlock.py). The complete allowlist is the AppArmor/SELinux profile in deploy/ (applied by the
    # operator at deploy time, where a MAC LSM can grant the loader map-only).
    paths = [p for n in sorted(spawn_guard.EXECUTABLES) if (p := shutil.which(n))]
    _landlock.restrict(paths)
    # The accidental-spawn check: the in-process audit hook, then the CLI under both.
    spawn_guard.install()
    from .cli import main

    main()


if __name__ == "__main__":
    run()
