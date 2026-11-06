"""The first-run diagnostics question, under the suite's shared setup (tests/conftest.py).

Every test starts with the question already answered, from a temporary sentinel, so no
`pcc-node start` test prompts on a fresh machine, and none reads or writes the real
~/.pcc-node. A test of the question itself points the sentinel somewhere new.
"""

import io
import json
import os
import sys
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node import cli
from pcc_node.config import NodeConfig, load_config, save_config


def test_the_suite_never_uses_the_real_home_sentinel():
    real = os.path.expanduser("~/.pcc-node/diagnostics-acknowledged")
    assert cli.DIAG_ACK_PATH != real
    assert os.path.exists(cli.DIAG_ACK_PATH)


def test_an_answered_question_is_not_asked_again():
    config = NodeConfig()
    with CliRunner().isolation(input="") as streams:  # streams[0] is stdout in every click 8
        cli._maybe_prompt_diagnostics(config)
        shown = streams[0].getvalue()
    assert shown == b""
    assert config.diagnostics_mode == "errors"


def test_an_unanswered_question_is_asked_once_and_the_answer_kept(tmp_path, monkeypatch):
    sentinel = tmp_path / "home" / ".pcc-node" / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    monkeypatch.setattr(cli, "_interactive", lambda: True)
    config = NodeConfig()
    with CliRunner().isolation(input="n\n") as streams:
        cli._maybe_prompt_diagnostics(config)
        shown = streams[0].getvalue()
    assert b"Auto-diagnostics (first-run setup)" in shown
    assert config.diagnostics_mode == "off"
    assert sentinel.read_text() == "mode=off\n"
    with CliRunner().isolation(input="") as streams:
        cli._maybe_prompt_diagnostics(NodeConfig())
        shown_again = streams[0].getvalue()
    assert shown_again == b""


def _no_terminal_line(path):
    return (
        "  No terminal to ask about auto-diagnostics, so they are off for this run. "
        f"To turn them on: pcc-node feedback on --config-file {path}\n"
    )


def _separate_streams_runner():
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        return CliRunner()


def test_no_terminal_at_eof_defers_the_question(tmp_path, monkeypatch, capsys):
    sentinel = tmp_path / "home" / ".pcc-node" / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    config = NodeConfig()
    assert config.diagnostics_mode == "errors"
    assert cli._interactive() is False

    cli._maybe_prompt_diagnostics(config)

    assert config.diagnostics_mode == "off"
    assert not sentinel.exists()
    shown = capsys.readouterr()
    assert shown.out == _no_terminal_line(os.path.join(os.getcwd(), "pcc-node.json"))
    assert shown.err == ""

    monkeypatch.setattr(cli, "_interactive", lambda: True)
    monkeypatch.setattr(sys, "stdin", io.StringIO("n\n"))
    cli._maybe_prompt_diagnostics(NodeConfig())
    shown = capsys.readouterr()
    assert "Auto-diagnostics (first-run setup)" in shown.out
    assert sentinel.read_text() == "mode=off\n"


def test_no_terminal_leaves_a_waiting_answer_unread(tmp_path, monkeypatch, capsys):
    sentinel = tmp_path / "home" / ".pcc-node" / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    monkeypatch.chdir(tmp_path)
    stdin = io.StringIO("y\n")
    monkeypatch.setattr(sys, "stdin", stdin)
    config = NodeConfig()
    assert cli._interactive() is False

    cli._maybe_prompt_diagnostics(config)

    assert config.diagnostics_mode == "off"
    assert not sentinel.exists()
    shown = capsys.readouterr()
    assert shown.out == _no_terminal_line(os.path.join(os.getcwd(), "pcc-node.json"))
    assert shown.err == ""
    assert stdin.read() == "y\n"


@pytest.mark.parametrize("config_name", ["node.json", "my dir/it's.json"], ids=["T4s", "T4q"])
def test_start_without_a_terminal_runs_with_diagnostics_off(tmp_path, monkeypatch, config_name):
    sentinel = tmp_path / "home" / ".pcc-node" / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    config_path = tmp_path / config_name
    config_path.parent.mkdir(parents=True, exist_ok=True)
    runner = _separate_streams_runner()
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli.detect_all", return_value=[]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
         mock.patch("pcc_node.cli.provision_api_key", side_effect=AssertionError), \
         mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}), \
         mock.patch("pcc_node.cli.register_devices"), \
         mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
         mock.patch("pcc_node.cli.run_daemon") as run_daemon:
        result = runner.invoke(
            cli.main, ["start", "-c", str(config_path), "--api-key", "k"],
            input="", env={"PCC_BASE": "http://127.0.0.1:9"},
        )

    assert result.exit_code == 0, result.output
    run_daemon.assert_called_once()
    assert run_daemon.call_args[0][0].diagnostics_mode == "off"
    assert json.loads(config_path.read_text())["diagnostics_mode"] == "off"
    assert not sentinel.exists()
    path_word = str(config_path)
    if config_name == "my dir/it's.json":
        path_word = "'" + str(tmp_path) + "/my dir/it'\"'\"'s.json'"
    assert result.stdout.count(_no_terminal_line(path_word)) == 1
    assert "Auto-diagnostics (first-run setup)" not in result.stdout
    assert f"  Config saved to {config_path}\n" in result.stdout
    assert result.stderr == ""


@pytest.mark.parametrize(
    "arg,saved_mode",
    [("on", "errors"), ("errors", "errors"), ("periodic", "periodic"), ("off", "off")],
    ids=["T6-on", "T6-errors", "T6-periodic", "T6-off"],
)
def test_feedback_records_the_saved_choice(tmp_path, monkeypatch, capsys, arg, saved_mode):
    sentinel = tmp_path / "home" / ".pcc-node" / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    config_path = tmp_path / "node.json"
    save_config(NodeConfig(diagnostics_mode="off"), str(config_path))

    result = _separate_streams_runner().invoke(
        cli.main, ["feedback", arg, "-c", str(config_path)],
        env={"PCC_BASE": "http://127.0.0.1:9"},
    )

    assert result.exit_code == 0, result.output
    assert sentinel.read_text() == f"mode={saved_mode}\n"
    config = load_config(str(config_path))
    assert config.diagnostics_mode == saved_mode
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    capsys.readouterr()
    cli._maybe_prompt_diagnostics(config)
    assert config.diagnostics_mode == saved_mode
    shown = capsys.readouterr()
    assert shown.out == shown.err == ""


@pytest.mark.parametrize("case", ["status", "missing", "refused"], ids=["T6-status", "T6-missing", "T6-refused"])
def test_feedback_without_a_saved_choice_writes_no_record(tmp_path, monkeypatch, case):
    sentinel = tmp_path / "home" / ".pcc-node" / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    config_path = tmp_path / "node.json"
    if case != "missing":
        save_config(NodeConfig(diagnostics_mode="off"), str(config_path))
    if case == "refused":
        config_path.chmod(0o666)
    arg = "status" if case == "status" else "on"

    result = _separate_streams_runner().invoke(
        cli.main, ["feedback", arg, "-c", str(config_path)],
        env={"PCC_BASE": "http://127.0.0.1:9"},
    )

    assert result.exit_code == (1 if case == "refused" else 0), result.output
    assert not sentinel.exists()


@pytest.mark.parametrize(
    "record,expected_mode",
    [(b"mode=off\n", "off"), (b"", "off"), (b"garbage\n", "off"),
     (b"\xff\xfe\n", "off"), (b"mode=errors\n", "errors"), (b"mode=periodic\n", "errors")],
    ids=["T7-off", "T7-empty", "T7-garbage", "T7-bytes", "T7-errors", "T7-periodic"],
)
def test_recorded_answer_binds_a_fresh_config(tmp_path, monkeypatch, capsys, record, expected_mode):
    sentinel = tmp_path / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    sentinel.write_bytes(record)
    config = NodeConfig()
    assert config.diagnostics_mode == "errors"

    cli._maybe_prompt_diagnostics(config)

    assert config.diagnostics_mode == expected_mode
    assert sentinel.read_bytes() == record
    shown = capsys.readouterr()
    assert shown.out == shown.err == ""


def test_a_record_that_cannot_be_opened_disables_diagnostics(tmp_path, monkeypatch, capsys):
    sentinel = tmp_path / "diagnostics-acknowledged"
    monkeypatch.setattr(cli, "DIAG_ACK_PATH", str(sentinel))
    sentinel.write_text("mode=errors\n")
    config = NodeConfig()

    with mock.patch("builtins.open", side_effect=PermissionError):
        cli._maybe_prompt_diagnostics(config)

    assert config.diagnostics_mode == "off"
    assert sentinel.read_text() == "mode=errors\n"
    shown = capsys.readouterr()
    assert shown.out == shown.err == ""
