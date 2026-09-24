"""Test isolation for pcc-node (board row N52).

pcc-node writes node state wherever it runs:

* ``crypto.load_or_create_keys()`` writes ``./pcc-keys.json`` (an Ed25519 pair,
  secret included) into the current directory on first use.  That is how a key
  pair came to be committed at ``packages/pcc-node/pcc-keys.json`` (N35).
* ``cli``, ``daemon``, ``diagnostics``, ``ui_gen`` and ``ui_server`` write under
  ``~`` (a PID file, state, logs, the diagnostics acknowledgement, generated UIs).

So every test runs in its own temporary working directory, with ``HOME`` pointed
at a temporary directory and the import-time home paths redirected there.  A
session guard fails the run if the package directory gains or changes a
``pcc-keys.json``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parents[1]
PACKAGE_KEY_FILE = PACKAGE_DIR / "pcc-keys.json"


def _key_file_state(path: Path):
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return (stat.st_size, stat.st_mtime_ns)


@pytest.fixture(autouse=True)
def _isolate_node_state(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(home))

    # Paths computed at import time do not follow HOME; redirect them too.
    import pcc_node.cli as cli
    import pcc_node.daemon as daemon
    import pcc_node.diagnostics as diagnostics
    import pcc_node.ui_gen as ui_gen
    import pcc_node.ui_server as ui_server

    state_dir = home / ".pcc-node"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(state_dir / "diagnostics-acknowledged"))
    monkeypatch.setattr(daemon, "PID_FILE", str(home / ".pcc-node.pid"))
    monkeypatch.setattr(daemon, "STATE_FILE", str(home / ".pcc-node-state.json"))
    monkeypatch.setattr(diagnostics, "LOG_DIR", str(state_dir / "logs"))
    monkeypatch.setattr(ui_gen, "DEFAULT_UI_DIR", state_dir / "ui")
    monkeypatch.setattr(ui_server, "_DEFAULT_UI_DIR", state_dir / "ui")
    yield


@pytest.fixture(autouse=True, scope="session")
def _no_key_file_written_into_the_package():
    before = _key_file_state(PACKAGE_KEY_FILE)
    yield
    after = _key_file_state(PACKAGE_KEY_FILE)
    assert after == before, (
        f"a test created or modified {PACKAGE_KEY_FILE}; tests must write node keys "
        "only under their own tmp_path (board N52)"
    )
