"""Shared test setup for pcc-node.

The daemon takes jobs only while the kernel's emergency stop reads clear
(pcc_node/estop.py), and an unreadable flag stops intake. Tests that are not
about the emergency stop get a gateway whose flag is clear. Tests about it
carry the ``real_estop`` marker and bring their own reader.
"""

import pytest

from pcc_node import estop


def pytest_configure(config):
    config.addinivalue_line("markers", "real_estop: keep pcc_node.estop.read_estop unpatched")


@pytest.fixture(autouse=True)
def _estop_reads_clear(request, monkeypatch):
    if request.node.get_closest_marker("real_estop"):
        return
    monkeypatch.setattr(estop, "read_estop", lambda *args, **kwargs: (estop.CLEAR, "test default"))
