"""Verdict 105c on #454: the round-3 findings, each reproduced at 58d7a0f0 first.

- finding 1: the reviewed SHA's daemon polled jobs and ran them with no
  e-stop gate; the node must take no jobs at all;
- finding 2: a key file in the working directory was adopted automatically;
- finding 3: on Windows, key and config files had no trust checks at all;
- finding 4: when os.link failed, check-then-replace could overwrite an
  identity another process had just installed;
- finding 5: a config others could write was "repaired" with fchmod, which
  does not revoke a descriptor another account already holds;
- finding 6: `start` skipped the safe load for a dangling symlink, and
  carried on past a malformed config to save over it;
- finding 7: a new key directory's own entry was never made durable, and
  every directory fsync error was ignored.
"""

import errno
import json
import os
import socket
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node import config as config_mod
from pcc_node import crypto, daemon
from pcc_node.cli import main
from pcc_node.config import ConfigFileError, NodeConfig, load_config, save_config
from pcc_node.crypto import KeyFileError, LEGACY_KEYS_PATH, generate_node_keys, load_or_create_keys

POSIX_ONLY = pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Nothing here reaches a real gateway: any connection attempt fails loudly."""
    def refuse(address, *args, **kwargs):
        raise AssertionError(f"unexpected network call to {address}")

    monkeypatch.setattr(socket, "create_connection", refuse)


def _write_pair(path, public_hex, secret_hex, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w") as f:
        json.dump({"public": public_hex, "secret": secret_hex}, f)
    os.chmod(path, mode)


# ── Finding 1 ────────────────────────────────────────────────────────────────

def test_no_polled_job_reaches_an_executor_or_a_device(monkeypatch, tmp_path):
    job = {"id": "job-1", "capabilityType": "liquid-handling", "params": {"protocol": "x"}}
    client = mock.MagicMock()
    client.poll_for_jobs.return_value = [job]
    executed = []

    class Executor:
        def __init__(self, *args, **kwargs):
            pass

        def execute(self, polled):
            executed.append(polled)

    monkeypatch.setattr(daemon, "PCCGatewayClient", lambda **kwargs: client)
    monkeypatch.setattr(daemon, "JobExecutor", Executor, raising=False)
    monkeypatch.setattr(daemon, "register_kernel", mock.MagicMock(), raising=False)
    monkeypatch.setattr(daemon, "load_or_create_keys", lambda *a, **k: ("ab" * 32, "cd" * 32))
    monkeypatch.setattr(daemon, "detect_camera_device", lambda: None, raising=False)
    monkeypatch.setattr(daemon, "discover_network", lambda timeout=0.5: [], raising=False)
    monkeypatch.setattr("pcc_node.ui_server.start_ui_server", lambda **kwargs: None)
    monkeypatch.setattr(daemon, "PID_FILE", str(tmp_path / "pid"))
    monkeypatch.setattr(daemon, "STATE_FILE", str(tmp_path / "state.json"))
    sleeps = []

    def stop(seconds):
        sleeps.append(seconds)
        if len(sleeps) > 8:  # several passes of the loop, then out
            raise KeyboardInterrupt

    monkeypatch.setattr(daemon.time, "sleep", stop)
    config = NodeConfig(kernel_id="k1", pcc_base="https://gw.example.test", pcc_api_key="k",
                        devices=[{"id": "ot2", "type": "opentrons", "url": "http://192.0.2.10"}],
                        poll_interval=1, diagnostics_mode="off")
    with pytest.raises(KeyboardInterrupt):
        daemon.run_daemon(config)

    assert executed == [], "a polled job reached the executor"
    client.poll_for_jobs.assert_not_called()
    client.mark_job_seen.assert_not_called()


# ── Finding 2 ────────────────────────────────────────────────────────────────

@POSIX_ONLY
def test_a_key_file_in_the_working_directory_is_never_adopted_automatically(tmp_path, monkeypatch):
    work = tmp_path / "checkout"
    work.mkdir(mode=0o700)
    monkeypatch.chdir(work)
    planted_pub, planted_sec = generate_node_keys()  # a pair someone else knows
    _write_pair(LEGACY_KEYS_PATH, planted_pub, planted_sec, mode=0o600)
    new_path = tmp_path / "home" / "keys.json"
    monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(new_path))

    try:
        pair = load_or_create_keys()
    except KeyFileError:
        pair = None
    assert pair != (planted_pub, planted_sec), "the planted identity was adopted"
    assert not new_path.exists() or json.loads(new_path.read_text())["public"] != planted_pub


# ── Finding 3 ────────────────────────────────────────────────────────────────

def test_on_windows_no_key_is_kept_where_it_cannot_be_made_private(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto, "_POSIX", False)
    with pytest.raises(KeyFileError, match="Windows"):
        load_or_create_keys(str(tmp_path / "keys.json"))
    assert not (tmp_path / "keys.json").exists()


def test_on_windows_no_api_key_is_stored_in_a_config(tmp_path, monkeypatch):
    monkeypatch.setattr(config_mod, "_POSIX", False, raising=False)
    path = tmp_path / "pcc-node.json"
    with pytest.raises(ConfigFileError, match="Windows"):
        save_config(NodeConfig(kernel_id="k", pcc_api_key="secret-value"), str(path))
    assert not path.exists()


# ── Finding 4 ────────────────────────────────────────────────────────────────

@POSIX_ONLY
def test_a_failed_hard_link_never_replaces_an_identity_created_meanwhile(tmp_path, monkeypatch):
    path = tmp_path / "keys" / "keys.json"
    ours_pub, ours_sec = generate_node_keys()
    theirs_pub, theirs_sec = generate_node_keys()

    def no_links(src, dst, *args, **kwargs):
        raise OSError(errno.EPERM, "Operation not permitted")

    real_lexists = os.path.lexists

    def racing_lexists(p):
        # The competing process installs its identity just after our check.
        result = real_lexists(p)
        if os.fspath(p) == str(path) and not result:
            _write_pair(str(path), theirs_pub, theirs_sec)
        return result

    monkeypatch.setattr(crypto.os, "link", no_links)
    monkeypatch.setattr(crypto.os.path, "lexists", racing_lexists)
    try:
        installed = crypto._create_exclusive(str(path), ours_pub, ours_sec)
    except KeyFileError:
        installed = None
    monkeypatch.setattr(crypto.os.path, "lexists", real_lexists)
    assert installed is not True, "a key was installed without an atomic no-replace step"
    if path.exists():
        assert json.loads(path.read_text())["public"] == theirs_pub, "the competing identity was overwritten"


@POSIX_ONLY
def test_without_hard_links_no_key_and_no_temporary_file_is_left(tmp_path, monkeypatch):
    def no_links(src, dst, *args, **kwargs):
        raise OSError(errno.EXDEV, "Invalid cross-device link")

    monkeypatch.setattr(crypto.os, "link", no_links)
    path = tmp_path / "keys" / "keys.json"
    with pytest.raises(KeyFileError, match="atomically"):
        load_or_create_keys(str(path))
    assert os.listdir(tmp_path / "keys") == []


# ── Finding 5 ────────────────────────────────────────────────────────────────

@POSIX_ONLY
def test_a_config_others_could_write_is_refused_not_repaired(tmp_path):
    path = tmp_path / "pcc-node.json"
    path.write_text(json.dumps({"kernel_id": "k", "pcc_api_key": "operator-key"}))
    os.chmod(path, 0o666)
    held = open(path, "r+")  # what another account could hold open before any repair
    try:
        with pytest.raises(ConfigFileError, match="writ"):
            load_config(str(path))
        held.seek(0)
        held.truncate()
        held.write(json.dumps({"kernel_id": "k", "pcc_api_key": "operator-key", "pcc_base": "https://evil.test"}))
        held.flush()
        with pytest.raises(ConfigFileError):
            load_config(str(path))
    finally:
        held.close()


@POSIX_ONLY
def test_a_config_others_can_write_does_not_choose_where_the_key_goes(tmp_path):
    # Found while fixing finding 5: the config names the gateway that `start`
    # sends the operator's key to, even when the file itself holds no key.
    config_file = tmp_path / "pcc-node.json"
    config_file.write_text(json.dumps({"kernel_id": "k", "pcc_base": "https://evil.test"}))
    os.chmod(config_file, 0o666)
    with mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}) as register:
        result = _start(tmp_path, config_file, pass_base=False, register=register)
    assert result.exit_code != 0, result.output
    assert all("evil.test" not in str(call) for call in register.call_args_list), register.call_args_list


# ── Finding 6 ────────────────────────────────────────────────────────────────

def _start(tmp_path, config_file, pass_base=True, register=None):
    device = {"id": "printer-1", "type": "machine", "protocol": "octoprint", "url": "http://192.0.2.10"}
    args = ["start", "-c", str(config_file), "--api-key", "k", "--yes"]
    if pass_base:
        args += ["--pcc-base", "https://gw.example.test"]
    register = register or mock.MagicMock(return_value={"ok": True})
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli.detect_all", return_value=[device]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 32, "cd" * 32)), \
         mock.patch("pcc_node.cli.provision_api_key", return_value="test-key"), \
         mock.patch("pcc_node.cli.register_kernel", register), \
         mock.patch("pcc_node.cli.register_devices", return_value=None), \
         mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {}), create=True), \
         mock.patch("pcc_node.cli.announce_capabilities", create=True), \
         mock.patch("pcc_node.cli.run_daemon"), \
         mock.patch.dict(os.environ, {"PCC_BASE": ""}):
        os.environ.pop("PCC_BASE", None)
        return CliRunner().invoke(main, args)


def test_start_stops_on_a_malformed_config_instead_of_saving_over_it(tmp_path):
    config_file = tmp_path / "pcc-node.json"
    config_file.write_text('{"kernel_id": "k", "pcc_api_key": "operator-key"')  # truncated JSON
    before = config_file.read_bytes()
    result = _start(tmp_path, config_file)
    assert result.exit_code != 0, result.output
    assert config_file.read_bytes() == before


@POSIX_ONLY
def test_start_stops_on_a_dangling_symlink_instead_of_replacing_it(tmp_path):
    config_file = tmp_path / "pcc-node.json"
    os.symlink(tmp_path / "elsewhere.json", config_file)
    result = _start(tmp_path, config_file)
    assert result.exit_code != 0, result.output
    assert os.path.islink(config_file)


# ── Finding 7 ────────────────────────────────────────────────────────────────

@POSIX_ONLY
def test_a_new_key_directory_is_made_durable_in_its_parent(tmp_path, monkeypatch):
    synced = []
    real_fsync = os.fsync

    def recording_fsync(fd):
        try:
            synced.append(os.readlink(f"/proc/self/fd/{fd}"))
        except OSError:
            synced.append(None)
        return real_fsync(fd)

    if not os.path.isdir("/proc/self/fd"):
        pytest.skip("needs /proc to name descriptors")
    monkeypatch.setattr(crypto.os, "fsync", recording_fsync)
    path = tmp_path / "a" / "b" / "keys.json"
    load_or_create_keys(str(path))
    for directory in (tmp_path, tmp_path / "a", tmp_path / "a" / "b"):
        assert str(directory) in synced, f"{directory} was never fsynced after a new entry in it"


@POSIX_ONLY
def test_a_directory_fsync_io_error_is_not_ignored(tmp_path, monkeypatch):
    def failing_fsync(fd):
        raise OSError(errno.EIO, "Input/output error")

    monkeypatch.setattr(crypto.os, "fsync", failing_fsync)
    with pytest.raises(OSError):
        crypto._fsync_dir(str(tmp_path))


@POSIX_ONLY
def test_a_directory_fsync_the_filesystem_does_not_support_is_tolerated(tmp_path, monkeypatch):
    def unsupported(fd):
        raise OSError(errno.EINVAL, "Invalid argument")

    monkeypatch.setattr(crypto.os, "fsync", unsupported)
    crypto._fsync_dir(str(tmp_path))
