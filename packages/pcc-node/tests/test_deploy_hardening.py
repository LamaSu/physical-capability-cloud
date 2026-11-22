"""The shipped deploy artifacts encode the three-layer spawn allowlist (steward ruling 10/03, verdict
105n): L1 the AppArmor profile (the HARD exec allowlist, incl. the loader-gadget closure), the systemd
unit reduced to service hygiene, and install.sh that loads the profile. Static checks only -- runtime
efficacy of L1 needs a per-distro AppArmor host matrix (operator task). L2 (Landlock) is proven by
tests/test_landlock.py; L3 (the hook) by the spawn-guard tests."""
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"
UTILS = ("arp", "dd", "ffmpeg", "journalctl", "sysctl", "v4l2-ctl")


def test_service_unit_is_hygiene_only_not_an_exec_allowlist():
    unit = (DEPLOY / "pcc-node.service").read_text(encoding="utf-8")
    # The retired, unsound exec-allowlist mechanism (105m) must be gone as an ACTIVE directive (the
    # comments may still name it to explain why it was dropped -- check directive lines, not prose).
    directives = [l.strip() for l in unit.splitlines() if not l.lstrip().startswith("#")]
    assert not any(l.startswith("NoExecPaths") for l in directives), \
        "systemd NoExecPaths was retired -- it cannot split mmap from execve"
    assert not any(l.startswith("ExecPaths=") for l in directives), "ExecPaths directive retired"
    assert "@EXEC_PATHS@" not in unit
    # Service hygiene the steward required.
    for directive in ("NoNewPrivileges=yes", "DynamicUser=yes",
                      "StateDirectory=pcc-node", "ConfigurationDirectory=pcc-node"):
        assert directive in unit, f"unit missing hygiene directive {directive!r}"
    # L1 is wired in and fails loud (no '-' prefix) if the profile is not loaded.
    assert "AppArmorProfile=pcc-node" in unit
    assert "AppArmorProfile=-pcc-node" not in unit, "must FAIL (no dash) if the profile is absent"
    # Launched isolated, through the guarded entry, non-interactively.
    starts = [l for l in unit.splitlines() if l.startswith("ExecStart=")]
    assert starts, "no ExecStart"
    assert " -I " in starts[0] and "-m pcc_node" in starts[0], f"not launched isolated via -m: {starts[0]!r}"
    assert "--yes" in starts[0], "non-interactive bootstrap needs --yes"
    assert "pcc_node.cli" not in starts[0], "must not launch the unguarded cli module"


def test_installer_loads_apparmor_and_does_not_compute_execpaths():
    sh = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    assert "apparmor_parser" in sh, "install.sh must load the L1 AppArmor profile"
    assert "apparmor/pcc-node" in sh, "install.sh must reference the profile path"
    assert "command -v python3" in sh, "install.sh must resolve the interpreter for ExecStart"
    # No active ExecPaths computation (comments may still name the retired mechanism).
    code = "\n".join(l for l in sh.splitlines() if not l.lstrip().startswith("#"))
    assert "@EXEC_PATHS@" not in sh
    assert "ExecPaths" not in code and "NoExecPaths" not in code, "no active ExecPaths logic"


def test_apparmor_profile_is_the_hard_exec_allowlist_and_closes_the_loader_gadget():
    prof = (DEPLOY / "apparmor" / "pcc-node").read_text(encoding="utf-8")
    assert "abstractions/base" in prof, "needs base abstraction (grants the loader map-only)"
    assert "python3" in prof
    for u in UTILS:
        assert u in prof, f"apparmor profile missing {u}"
    # Shells explicitly denied.
    assert any(l.strip().startswith("deny") and "sh x" in l for l in prof.splitlines()), \
        "shells must be explicitly denied"
    # The loader-gadget closure (verdict 105n): the ELF loader is denied execute-as-program while it
    # keeps map (so dynamic binaries still load). This is the control Landlock (L2) cannot express.
    assert any(l.strip().startswith("deny") and "ld-" in l and " x," in l for l in prof.splitlines()), \
        "the ELF loader must be denied execute-as-program (execve(ld.so,...) closes the gadget)"
