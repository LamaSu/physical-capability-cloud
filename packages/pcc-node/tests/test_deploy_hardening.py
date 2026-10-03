"""The shipped deploy artifacts pin the hard spawn-allowlist -- the OS layer of the two-layer guard
(steward ruling 10/03). Static checks: the unit carries the directives; install.sh resolves them for
the host; the AppArmor fallback allowlists the same set. Runtime efficacy needs a systemd/AppArmor host."""
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"
UTILS = ("arp", "dd", "ffmpeg", "journalctl", "sysctl", "v4l2-ctl")


def test_service_unit_pins_the_exec_allowlist_directives():
    unit = (DEPLOY / "pcc-node.service").read_text(encoding="utf-8")
    assert "NoExecPaths=/" in unit
    assert "NoNewPrivileges=yes" in unit
    assert "ExecPaths=" in unit
    starts = [l for l in unit.splitlines() if l.startswith("ExecStart=")]
    assert starts, "no ExecStart"
    assert " -I " in starts[0] and "-m pcc_node" in starts[0], f"not launched isolated via -m: {starts[0]!r}"
    assert "pcc_node.cli" not in starts[0], "must not launch the unguarded cli module"


def test_installer_resolves_python_and_each_pinned_utility():
    sh = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    assert "command -v python3" in sh
    assert "@EXEC_PATHS@" in sh, "install.sh must substitute the template placeholder"
    for u in UTILS:
        assert u in sh, f"install.sh does not resolve {u}"


def test_apparmor_fallback_allowlists_python_and_denies_shells():
    prof = (DEPLOY / "apparmor" / "pcc-node").read_text(encoding="utf-8")
    assert "python3" in prof
    for u in UTILS:
        assert u in prof, f"apparmor profile missing {u}"
    assert "deny" in prof and "sh x" in prof, "shells must be explicitly denied"
