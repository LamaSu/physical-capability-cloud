"""Pytest config — silences the PLR root logger handler the Server installs.

Without this, every test that constructs a Server adds a duplicate handler
to the global ``pylabrobot`` logger and the tests still pass but each test
leaks one handler. Reset before each test for hygiene.
"""

from __future__ import annotations
import logging
import pytest


@pytest.fixture(autouse=True)
def _reset_loggers():
    """Clear pylabrobot / pcc_plr_sidecar.run handlers between tests."""
    yield
    for name in ("pylabrobot", "pcc_plr_sidecar.run"):
        log = logging.getLogger(name)
        for h in list(log.handlers):
            log.removeHandler(h)
