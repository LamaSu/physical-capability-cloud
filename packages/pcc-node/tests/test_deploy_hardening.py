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
    for directive in ("NoNewPrivileges=yes", "ConfigurationDirectory=pcc-node"):
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


def _unit_directives():
    lines = (DEPLOY / "pcc-node.service").read_text(encoding="utf-8").splitlines()
    section = None
    directives = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line
        directives.append((section, line))
    return directives


def _active_lines(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]


def _assert_unit_directive(directives, prefix, expected, section="[Service]"):
    matches = [(where, line) for where, line in directives if line.startswith(prefix)]
    assert matches == [(section, expected)]


def test_unit_runs_as_the_static_pcc_node_user():
    directives = _unit_directives()
    for directive in ("User=pcc-node", "Group=pcc-node", "ProtectSystem=full"):
        _assert_unit_directive(directives, directive.split("=", 1)[0] + "=", directive)


def test_unit_has_no_dynamic_user_state_directory_or_read_write_paths():
    directives = _unit_directives()
    assert not any(line.startswith(("DynamicUser=", "StateDirectory=", "ReadWritePaths="))
                   for _, line in directives)


def test_unit_does_not_restart_a_permanent_refusal():
    _assert_unit_directive(_unit_directives(), "RestartPreventExitStatus=",
                           "RestartPreventExitStatus=78")


def test_unit_asserts_apparmor_before_starting():
    _assert_unit_directive(_unit_directives(), "AssertSecurity=", "AssertSecurity=apparmor", "[Unit]")


def test_unit_keeps_its_hygiene_and_key_paths():
    directives = _unit_directives()
    for directive in (
        "NoNewPrivileges=yes",
        "CapabilityBoundingSet=",
        "ProtectHome=yes",
        "PrivateTmp=yes",
        "ProtectKernelTunables=yes",
        "ProtectControlGroups=yes",
        "RestrictSUIDSGID=yes",
        "RemoveIPC=yes",
        "ConfigurationDirectory=pcc-node",
        "Environment=HOME=/var/lib/pcc-node",
        "Environment=PCC_NODE_KEYS_FILE=/var/lib/pcc-node/keys.json",
    ):
        _assert_unit_directive(directives, directive.rsplit("=", 1)[0] + "=", directive)
    starts = [line for _, line in directives if line.startswith("ExecStart=")]
    assert len(starts) == 1
    assert starts[0].endswith(" --config-file /var/lib/pcc-node/pcc-node.json")


def test_installer_creates_the_system_user_and_group():
    commands = _active_lines(DEPLOY / "install.sh")
    groups = [line for line in commands if "groupadd" in line]
    assert groups == ["getent group pcc-node >/dev/null || groupadd --system pcc-node"]
    users = [line for line in commands if "useradd" in line]
    assert len(users) == 1
    assert users[0].startswith("getent passwd pcc-node >/dev/null || useradd ")
    words = users[0].split()
    options = words[words.index("useradd") + 1:]
    assert "--system" in options
    assert "--no-create-home" in options
    for option, value in (("--gid", "pcc-node"), ("--home-dir", "/var/lib/pcc-node"),
                          ("--shell", "/usr/sbin/nologin")):
        assert option in options
        assert options[options.index(option) + 1] == value
    assert options[-1] == "pcc-node"
    assert commands.index(groups[0]) < commands.index(users[0])


def test_installer_creates_the_key_directory_after_the_user():
    commands = _active_lines(DEPLOY / "install.sh")
    installs = [line for line in commands if line.startswith("install ") and "-d" in line.split()]
    assert len(installs) == 1
    words = installs[0].split()
    assert "-d" in words
    for option, value in (("-m", "0700"), ("-o", "pcc-node"), ("-g", "pcc-node")):
        assert option in words
        assert words[words.index(option) + 1] == value
    assert words[-1] == "/var/lib/pcc-node"
    users = [line for line in commands if "useradd" in line]
    assert len(users) == 1
    assert commands.index(users[0]) < commands.index(installs[0])


def test_installer_warning_says_the_unit_will_not_start_without_apparmor():
    text = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    lines = text.splitlines()
    warnings = [
        '    echo "install.sh: WARNING -- apparmor_parser not found, so the AppArmor profile (Layer 1) is not" >&2',
        '    echo "            loaded and the unit will not start: AssertSecurity=apparmor fails the start where" >&2',
        '    echo "            AppArmor is not enabled, and AppArmorProfile=pcc-node fails it where the profile" >&2',
        '    echo "            is not loaded. deploy/README.md says how to enable AppArmor on each install" >&2',
        '    echo "            target, and how to run without Layer 1. Without it the loader path is open, and" >&2',
        '    echo "            only mandatory Landlock and the spawn hook remain." >&2',
    ]
    for line in warnings:
        assert lines.count(line) == 1
    start = lines.index(warnings[0])
    assert lines[start:start + len(warnings)] == warnings
    assert "edit the unit to drop AppArmorProfile=" not in text


def test_installer_starts_nothing():
    commands = _active_lines(DEPLOY / "install.sh")
    assert [line for line in commands if line.startswith("systemctl")] == ["systemctl daemon-reload"]


def test_apparmor_profile_grants_the_key_store_reads():
    rules = _active_lines(DEPLOY / "apparmor" / "pcc-node")
    for grant in (
        "@{PROC}/@{pid}/mountinfo r,",
        "@{PROC}/@{pid}/fdinfo/* r,",
        "/ r,",
        "/var/ r,",
        "/var/lib/ r,",
        "/var/lib/pcc-node/ r,",
    ):
        assert rules.count(grant) == 1
    assert not any("@{HOME}" in line for line in rules)
    assert "/var/lib/pcc-node/** rwk," in rules


def test_apparmor_profile_includes_name_service_and_certificates():
    lines = (DEPLOY / "apparmor" / "pcc-node").read_text(encoding="utf-8").splitlines()
    includes = [line.strip() for line in lines if line.strip().startswith("#include ")]
    base = includes.index("#include <abstractions/base>")
    for include in ("#include <abstractions/nameservice>", "#include <abstractions/ssl_certs>"):
        assert includes.count(include) == 1
        assert includes.index(include) > base


def test_apparmor_profile_grants_the_key_store_link():
    rules = _active_lines(DEPLOY / "apparmor" / "pcc-node")
    assert rules.count("/var/lib/pcc-node/** l,") == 1


def test_installer_installs_the_profile_where_it_loads_at_boot():
    commands = _active_lines(DEPLOY / "install.sh")
    install = 'install -m 0644 "$HERE/apparmor/pcc-node" /etc/apparmor.d/pcc-node'
    load = 'apparmor_parser -r -W "$HERE/apparmor/pcc-node"'
    assert [line for line in commands if "/etc/apparmor.d" in line] == [install]
    assert commands.count(load) == 1
    assert commands.index(install) < commands.index(load)


def test_installer_loads_the_profile_or_warns_in_one_block():
    lines = (DEPLOY / "install.sh").read_text(encoding="utf-8").splitlines()
    block = [
        'if command -v apparmor_parser >/dev/null 2>&1; then',
        '    install -m 0644 "$HERE/apparmor/pcc-node" /etc/apparmor.d/pcc-node',
        '    apparmor_parser -r -W "$HERE/apparmor/pcc-node"',
        "    echo \"install.sh: loaded AppArmor profile 'pcc-node' (L1 exec allowlist)\"",
        'else',
        '    echo "install.sh: WARNING -- apparmor_parser not found, so the AppArmor profile (Layer 1) is not" >&2',
        '    echo "            loaded and the unit will not start: AssertSecurity=apparmor fails the start where" >&2',
        '    echo "            AppArmor is not enabled, and AppArmorProfile=pcc-node fails it where the profile" >&2',
        '    echo "            is not loaded. deploy/README.md says how to enable AppArmor on each install" >&2',
        '    echo "            target, and how to run without Layer 1. Without it the loader path is open, and" >&2',
        '    echo "            only mandatory Landlock and the spawn hook remain." >&2',
        'fi',
    ]
    assert lines.count(block[0]) == 1
    start = lines.index(block[0])
    assert lines[start:start + len(block)] == block


def test_unit_sets_the_apparmor_profile_once():
    _assert_unit_directive(_unit_directives(), "AppArmorProfile=", "AppArmorProfile=pcc-node")


def test_unit_directives_hold_with_spaces_around_equals():
    directives = []
    for section, line in _unit_directives():
        if "=" in line:
            key, value = line.split("=", 1)
            directives.append((section, key.strip() + "=" + value.strip()))
    for directive in (
        "User=pcc-node",
        "Group=pcc-node",
        "ProtectSystem=full",
        "AppArmorProfile=pcc-node",
        "NoNewPrivileges=yes",
        "RestartPreventExitStatus=78",
    ):
        _assert_unit_directive(directives, directive.split("=", 1)[0] + "=", directive)
    _assert_unit_directive(directives, "AssertSecurity=", "AssertSecurity=apparmor", "[Unit]")
    assert not any(line.startswith(("DynamicUser=", "StateDirectory=", "ReadWritePaths="))
                   for _, line in directives)


def test_installer_runs_no_service_command_in_any_spelling():
    import re

    command = re.compile(
        r"(?:^|[;&|({]) *(?:(?:exec|sudo) +)?"
        r"(?:[^\s;&|({]+/)?(?:systemctl|service|systemd-run)\b"
    )
    found = []
    for line in _active_lines(DEPLOY / "install.sh"):
        if line.startswith("echo "):
            continue
        match = command.search(line)
        if match:
            found.append(line[match.start():].strip(" ;&|({"))
    assert found == ["systemctl daemon-reload"]
