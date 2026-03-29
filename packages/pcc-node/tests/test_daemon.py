"""Tests for the daemon module."""

import json
import os
import time
from unittest import mock

import pytest

from pcc_node.daemon import (
    _write_pid,
    _remove_pid,
    _write_state,
    read_state,
    read_pid,
    is_running,
    PID_FILE,
    STATE_FILE,
)
from pcc_node.config import NodeConfig


@pytest.fixture(autouse=True)
def clean_pid_files():
    """Clean up PID and state files before and after each test."""
    for f in [PID_FILE, STATE_FILE]:
        try:
            os.remove(f)
        except OSError:
            pass
    yield
    for f in [PID_FILE, STATE_FILE]:
        try:
            os.remove(f)
        except OSError:
            pass


class TestPidFile:
    def test_write_and_read(self):
        _write_pid()
        pid = read_pid()
        assert pid == os.getpid()

    def test_remove(self):
        _write_pid()
        _remove_pid()
        assert read_pid() is None

    def test_read_missing(self):
        assert read_pid() is None


class TestStateFile:
    def test_write_and_read(self):
        cfg = NodeConfig(kernel_id="k-test", kernel_name="test-node")
        _write_state(cfg, time.time(), 42)
        state = read_state()
        assert state is not None
        assert state["kernel_id"] == "k-test"
        assert state["jobs_completed"] == 42

    def test_read_missing(self):
        assert read_state() is None


class TestIsRunning:
    def test_not_running_no_pid_file(self):
        running, pid = is_running()
        assert running is False
        assert pid is None

    def test_stale_pid(self):
        # Write a PID that almost certainly doesn't exist
        with open(PID_FILE, "w") as f:
            f.write("999999999")
        running, pid = is_running()
        assert running is False

    def test_current_process(self):
        _write_pid()
        running, pid = is_running()
        assert running is True
        assert pid == os.getpid()
