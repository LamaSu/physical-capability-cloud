"""`python -m pcc_node` -- the guarded entry point.

Delegates to :func:`pcc_node._entry.run`, which installs the runtime spawn guard before importing the
CLI and its dependencies. Use this (or the ``pcc-node`` console script); ``python -m pcc_node.cli``
is refused because it would run the CLI without the guard (verdict 105k HIGH 3).
"""
from ._entry import run

run()
