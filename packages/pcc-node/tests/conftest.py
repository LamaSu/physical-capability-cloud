"""Shared setup for the pcc-node suite: no test depends on, or writes, the first-run answer
in the real home directory.

``cli.DIAG_ACK_PATH`` is fixed from the real HOME when ``pcc_node.cli`` is imported, so a
test's own HOME override never reaches it. On a machine that has never answered the
first-run diagnostics question (a fresh CI runner), every ``pcc-node start`` test would
prompt, read end-of-input and abort. Each test sees an already-answered question instead,
held in a temporary directory. A test of the question itself patches the path again.
"""

import pytest

from pcc_node import cli


@pytest.fixture(scope="session")
def _answered_diagnostics_sentinel(tmp_path_factory):
    sentinel = tmp_path_factory.mktemp("pcc-node-home") / "diagnostics-acknowledged"
    sentinel.write_text("mode=errors\n")
    return str(sentinel)


@pytest.fixture(autouse=True)
def _diagnostics_already_answered(monkeypatch, _answered_diagnostics_sentinel):
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", _answered_diagnostics_sentinel)
