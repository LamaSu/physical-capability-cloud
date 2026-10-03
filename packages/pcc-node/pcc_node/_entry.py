"""The ``pcc-node`` console entry point.

It installs the runtime spawn guard (:mod:`pcc_node.spawn_guard`) before importing the CLI and its
dependencies, so no import-time code runs ahead of the hook (verdict 105j HIGH 4). Only this module's
own imports and :mod:`pcc_node.spawn_guard` (stdlib only) load before the guard is up.

The tests call :func:`pcc_node.cli.main` and :func:`pcc_node.daemon.run_daemon` directly, so importing
those -- or this module -- in-process never installs the unremovable hook in the shared test process;
only running the installed ``pcc-node`` script (or :func:`run` below) does.
"""


def run() -> None:
    from . import spawn_guard

    spawn_guard.install()
    from .cli import main  # imported after the hook is live, so the CLI's dependencies load under it

    main()


if __name__ == "__main__":
    run()
