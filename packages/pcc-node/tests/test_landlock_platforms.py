"""Landlock returns before Linux-specific operations on other platforms."""

import ctypes
import logging
import os
import sys

import pytest

from pcc_node import _landlock


@pytest.mark.parametrize("platform", ["win32", "darwin"])
def test_landlock_is_not_tried_off_linux(platform, monkeypatch, caplog):
    calls = []

    def uname(*args, **kwargs):
        calls.append("uname")
        raise AssertionError("os.uname must not run")

    def cdll(*args, **kwargs):
        calls.append("CDLL")
        raise AssertionError("ctypes.CDLL must not run")

    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(os, "uname", uname, raising=False)
    monkeypatch.setattr(ctypes, "CDLL", cdll, raising=False)
    with caplog.at_level(logging.DEBUG, logger="pcc-node.landlock"):
        assert _landlock.available() is False
        assert _landlock.restrict([sys.executable]) is False

    assert calls == []
    records = [r for r in caplog.records if r.name == "pcc-node.landlock"]
    assert [(r.levelno, r.getMessage()) for r in records] == [
        (logging.WARNING, f"Landlock: Linux only, not available on {platform}; execute-allowlist NOT enforced")
    ]
