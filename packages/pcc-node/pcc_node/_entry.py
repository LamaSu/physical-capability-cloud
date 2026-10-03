"""The ``pcc-node`` console entry point.

It installs the runtime spawn guard (:mod:`pcc_node.spawn_guard`) before importing the CLI and its
dependencies, so no import-time code runs ahead of the hook (verdict 105j HIGH 4). Only this module's
own imports and :mod:`pcc_node.spawn_guard` (stdlib only) load before the guard is up.

The tests call :func:`pcc_node.cli.main` and :func:`pcc_node.daemon.run_daemon` directly, so importing
those -- or this module -- in-process never installs the unremovable hook in the shared test process;
only running the installed ``pcc-node`` script (or :func:`run` below) does.
"""


def run() -> None:
    import os
    import shutil

    from . import _landlock, spawn_guard

    # Layer 2, applied first and irreversibly: confine execve at the kernel. Landlock blocks the direct
    # execve of ANY non-pinned binary -- INCLUDING re-executing the interpreter, which is how a
    # compromised process would otherwise run `python3 -c <arbitrary>` and escape the in-process hook.
    # It MUST succeed before the node runs: otherwise the exec floor rests on AppArmor alone, which has
    # to grant python3 execute (pcc-node IS python) and so cannot stop `python3 -c ...` (verdict 105n,
    # sol HIGH1). Where Landlock is unavailable we refuse by default, unless the operator consciously
    # opts out with PCC_ALLOW_NO_LANDLOCK=1 -- then only AppArmor (L1) + the accidental hook (L3) apply
    # and the operating runtime must stay unarmed (item 124 / #471). Landlock + AppArmor together are
    # the hard guarantee; neither alone is (AppArmor leaves the python path, Landlock the loader gadget).
    paths = [p for n in sorted(spawn_guard.EXECUTABLES) if (p := shutil.which(n))]
    if not _landlock.restrict(paths) and os.getenv("PCC_ALLOW_NO_LANDLOCK") != "1":
        raise SystemExit(
            "Refused: Landlock (Linux 5.13+) is unavailable, so pcc-node cannot confine execve in "
            "process, and AppArmor alone cannot stop `python3 -c ...`. Run on a Landlock kernel, or "
            "load the AppArmor profile and set PCC_ALLOW_NO_LANDLOCK=1 to run with Layer 1 only "
            "(deploy/README.md). Fail-closed by default."
        )
    # Layer 3, the accidental-spawn check: the in-process audit hook, then the CLI under both.
    spawn_guard.install()
    from .cli import main

    main()


if __name__ == "__main__":
    run()
