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


# ── async tests without pytest-asyncio (R39) ─────────────────────────────────
# pytest-asyncio is a declared dev dependency, but it is not installed on every
# box that runs these tests (and fetching it is not always allowed). When it is
# missing, run coroutine tests on a fresh event loop here instead. When it is
# present, this block does nothing and pytest-asyncio's auto mode applies.
try:
    import pytest_asyncio  # noqa: F401

    _HAVE_PYTEST_ASYNCIO = True
except ImportError:
    _HAVE_PYTEST_ASYNCIO = False

if not _HAVE_PYTEST_ASYNCIO:
    import asyncio
    import inspect

    def pytest_configure(config):
        config.addinivalue_line(
            "markers", "asyncio: coroutine test (run by conftest when pytest-asyncio is absent)",
        )

    @pytest.hookimpl(tryfirst=True)
    def pytest_pyfunc_call(pyfuncitem):
        if not inspect.iscoroutinefunction(pyfuncitem.obj):
            return None
        kwargs = {name: pyfuncitem.funcargs[name] for name in pyfuncitem._fixtureinfo.argnames}
        asyncio.run(pyfuncitem.obj(**kwargs))
        return True
