"""The first-run diagnostics question, under the suite's shared setup (tests/conftest.py).

Every test starts with the question already answered, from a temporary sentinel, so no
`pcc-node start` test prompts on a fresh machine, and none reads or writes the real
~/.pcc-node. A test of the question itself points the sentinel somewhere new.
"""

import os

from click.testing import CliRunner

from pcc_node import cli
from pcc_node.config import NodeConfig


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
