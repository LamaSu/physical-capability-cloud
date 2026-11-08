"""N209/N210: exercise published pipe-to-bash commands without network access."""

import errno
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import signal
import stat
import subprocess
import time
from unittest import mock

if os.name != "nt":
    import pty

import pytest
from click.testing import CliRunner

from pcc_node.cli import main
from pcc_node.config import NodeConfig, load_config_data


pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="install.sh needs a POSIX shell, pty and /dev/tty"
)
ROOT = Path(__file__).resolve().parents[3]
SCRIPT = Path(os.environ.get("N209_INSTALL_SH", ROOT / "apps/dashboard/public/install.sh"))
HTML = Path(os.environ.get("N209_INSTALL_HTML", ROOT / "apps/dashboard/public/install.html"))
REAL_PYTHON = shutil.which("python3")
REAL_ENV = shutil.which("env")
RUNNER_PATH = os.environ["PATH"]
URL = "http://192.0.2.10:8080"
USER = "alice"
PASSWORD = "pa'ss\" w\\o$rd`x` "
PCC_KEY = "pcc_live_installer-test-not-a-key"
VENDORS = ("hamilton", "opentrons", "octoprint", "sila", "mock")
SPEC_RE = re.compile(
    r"^pcc-node\[crypto\] @ git\+https://github\.com/LamaSu/physical-capability-cloud\.git@"
    r"([0-9a-f]{40})#subdirectory=packages/pcc-node$"
)
PIN = "1d11f37203f99eb1c9f2cfcd2b5ccf278e835820"
KEY_QUESTION = (r"PCC API key[^\r\n]*: ", PCC_KEY)
KEY_GUIDANCE = (
    "  This installer doesn't create PCC API keys. How to get one: "
    "https://capability.network/auth.md"
)
KEY_STOP = "No terminal to ask: Paste a PCC API key (pcc_live_*). Run it in a terminal to type it hidden, or pass --key=<PCC_API_KEY> (a flag shows in the process list and your shell history). Nothing was installed."
H1 = '              <li>Ask you for a PCC API key (it doesn\'t create one: <a href="/auth.md">how to get one</a>)</li>'
H2 = '            <p style="margin-top:18px;color:#9aa3b2">When done, the node has registered your kernel using your PCC API key. The node keeps your kernel online and does not take jobs: your devices run only through your operating agent\'s typed operations.</p>'
H5 = "              <li>Start <code>pcc-node</code>, which finds the devices it can detect and registers your kernel</li>"
H6 = "              <li>Install <code>pcc-node</code> from source, at a fixed commit</li>"
H3 = ["              <li>Check for python3 / pip / git</li>", H1, H6, H5]
S9 = "#   --vendor=<TYPE>      hamilton | opentrons | octoprint | sila | mock (optional; pcc-node finds the devices it can detect)"
S11 = "#   --no-start           install pcc-node and save its config, but don't start it (nothing registers until it starts)"
S15 = "--url, --user and --pass are not used: pcc-node finds the devices it can detect when it starts."
S17 = "[4/4] saving pcc-node's config (--no-start: not starting it)"


class Installer:
    def __init__(self, root, managed=False, ensurepip=True, pip="24.0"):
        self.home = root / "home"
        self.cwd = root / "cwd"
        self.bin = root / "bin"
        self.log = root / "log"
        self.venv = self.home / ".pcc-node/venv"
        self.config = self.home / ".pcc-node/pcc-node.json"
        stubs = root / "stubs"
        for directory in (self.home, self.cwd, self.bin, self.log, stubs):
            directory.mkdir(parents=True)
        self.nodes = {
            "path": self.bin / "pcc-node",
            "home": self.home / ".local/bin/pcc-node",
            "venv": self.venv / "bin/pcc-node",
        }
        self.env = {
            "HOME": str(self.home),
            "PATH": str(self.bin) + os.pathsep + RUNNER_PATH,
            "LANG": "C.UTF-8",
            "TERM": "dumb",
            "PCC_BASE": "http://127.0.0.1:9",
            "N209_LOG": str(self.log),
            "N210_EM": "1" if managed else "0",
            "N210_ENSUREPIP": "1" if ensurepip else "0",
            "N210_PIP": pip,
            "N210_NODE_STUB": str(stubs / "pcc-node"),
            "N210_VENV_PYTHON": str(stubs / "venv-python"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        self.stub("pip3", r'''printf '%s\n' "$*" >> "$N209_LOG/pip3.calls"
if [ "$N210_EM" = 1 ]; then
    for arg in "$@"; do
        if [ "$arg" = --user ]; then
            echo 'error: externally-managed-environment' >&2
            exit 1
        fi
    done
fi
exit 0
''')
        self.stub("git", "exit 1\n")
        self.stub("curl", 'printf "%s\\n" "$*" >> "$N209_LOG/curl.calls"\nexit 7\n')
        for marker, path in (("path", self.nodes["path"]),
                             ("home", self.nodes["home"]),
                             ("venv", stubs / "pcc-node")):
            self.write_stub(path, "printf '%s' " + shlex.quote(marker) + r''' > "$N209_LOG/node.which"
printf '%s' "$0" > "$N209_LOG/node.bin"
printf '%s\n' "$*" >> "$N209_LOG/node.calls"
if [ -t 0 ]; then
    printf '%s' tty > "$N209_LOG/node.stdin"
else
    printf '%s' not-a-tty > "$N209_LOG/node.stdin"
fi
printf '%s' "$PCC_API_KEY" > "$N209_LOG/node.key"
printf '%s' "$KERNEL_ID" > "$N209_LOG/node.kernel_id"
printf '%s' "${KERNEL_CONFIG+set}" > "$N209_LOG/node.kernel_config_set"
exit 0
''')
        self.write_stub(stubs / "venv-python", r'''printf '%s\n' "$*" >> "$N209_LOG/venv-python.calls"
if [ "$1" = -m ] && [ "$2" = pip ] && [ "$3" = install ]; then
    cp "$N210_NODE_STUB" "$(dirname "$0")/pcc-node"
    chmod 755 "$(dirname "$0")/pcc-node"
    exit 0
fi
exit 1
''')
        assert REAL_PYTHON is not None
        self.stub("python3", r'''printf '%s\0' "$@" >> "$N209_LOG/python3.argv"
printf '%s\n' "$(printf '%s' "$*" | tr '\n' ' ')" >> "$N209_LOG/python3.calls"
for arg in "$@"; do
    case "$arg" in
        *EXTERNALLY-MANAGED*)
            if [ "$N210_EM" = 1 ]; then echo externally-managed; fi
            exit 0 ;;
    esac
done
if [ "$1" = -m ] && [ "$2" = venv ]; then
    without_pip=0
    for arg in "$@"; do
        destination="$arg"
        if [ "$arg" = --without-pip ]; then without_pip=1; fi
    done
    mkdir -p "$destination/bin"
    cp "$N210_VENV_PYTHON" "$destination/bin/python"
    chmod 755 "$destination/bin/python"
    if [ "$N210_ENSUREPIP" = 1 ] || [ "$without_pip" = 1 ]; then exit 0; fi
    echo 'The virtual environment was not created successfully because ensurepip is not'
    exit 1
fi
if [ "$1" = -m ] && [ "$2" = pip ] && [ "$3" = --python ]; then
    if [ "$N210_PIP" = 22.0.2 ]; then
        echo 'no such option: --python' >&2
        exit 2
    fi
    if [ "$5" = --version ]; then
        echo 'pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)'
        exit 0
    fi
    if [ "$5" = install ]; then
        cp "$N210_NODE_STUB" "$(dirname "$4")/pcc-node"
        chmod 755 "$(dirname "$4")/pcc-node"
        exit 0
    fi
    exit 1
fi
exec ''' + shlex.quote(REAL_PYTHON) + ' "$@"\n')
        assert REAL_ENV is not None
        self.stub("env", r'''printf '%s\0' "$@" >> "$N209_LOG/env.argv"
exec ''' + shlex.quote(REAL_ENV) + ' "$@"\n')

    @staticmethod
    def write_stub(path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def stub(self, name, body):
        self.write_stub(self.bin / name, body)

    def command(self, flags=None):
        if flags is None:
            return ["bash", "-c", 'cat "$0" | bash', str(SCRIPT)]
        return ["bash", "-c", 'cat "$0" | bash -s -- "$@"', str(SCRIPT)] + flags

    def terminal(self, flags, questions):
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(str(self.cwd))
                os.execvpe("bash", self.command(flags), self.env)
            finally:
                os._exit(127)
        output = b""
        answered = 0
        cursor = 0
        status = None
        waiting_since = None
        deadline = time.monotonic() + 30
        try:
            while True:
                now = time.monotonic()
                if now >= deadline:
                    pytest.fail("installer timed out: " + output.decode(errors="replace"))
                if answered < len(questions):
                    pattern, answer = questions[answered]
                    if re.search(pattern.encode() + rb"$", output[cursor:], re.MULTILINE):
                        time.sleep(0.1)
                        cursor = len(output)
                        os.write(fd, (answer + "\n").encode())
                        answered += 1
                        waiting_since = None
                    elif output[cursor:].endswith(b": "):
                        if waiting_since is None:
                            waiting_since = now
                        elif now - waiting_since >= 2:
                            pytest.fail("unexpected installer question: " + output.decode(errors="replace"))
                ready, _, _ = select.select([fd], [], [], 0.1)
                if not ready:
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output += chunk
            _, status = os.waitpid(pid, 0)
        finally:
            os.close(fd)
            if status is None:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status), output.decode(errors="replace"), answered

    def no_terminal(self, flags=None):
        result = subprocess.run(
            self.command(flags), env=self.env, cwd=str(self.cwd),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, start_new_session=True, timeout=30,
        )
        return result.returncode, result.stdout.decode(errors="replace")

    def read(self, name):
        return (self.log / name).read_text()

    def calls(self, name):
        path = self.log / name
        return path.read_text().splitlines() if path.exists() else []

    def no_install(self):
        for name in ("pip3.calls", "python3.calls", "node.calls"):
            assert not (self.log / name).exists()

    def no_curl(self):
        assert not (self.log / "curl.calls").exists()


@pytest.fixture
def installer(tmp_path):
    return Installer(tmp_path)


def assert_started(installer, marker, code, output):
    assert code == 0, output
    for step in range(1, 5):
        assert "[{}/4]".format(step) in output
    for error in ("Traceback", "NameError", "SyntaxError", "syntax error"):
        assert error not in output
    assert installer.read("node.key") == PCC_KEY
    kernel_id = installer.read("node.kernel_id")
    assert re.fullmatch(r"kernel_.+_[0-9]+", kernel_id)
    assert installer.read("node.kernel_config_set") == ""
    assert installer.read("node.which") == marker
    assert installer.read("node.bin") == str(installer.nodes[marker])
    assert "  ✓ pcc-node installed: " + str(installer.nodes[marker]) in output
    assert PCC_KEY not in output
    assert installer.read("node.calls") == "start\n"
    assert installer.read("node.stdin") == "tty"
    installer.no_curl()


@pytest.mark.parametrize("vendor", (None,) + VENDORS, ids=("plain",) + VENDORS)
def test_T1_page_commands(installer, vendor):
    flags = None if vendor is None else ["--vendor=" + vendor]
    code, output, answered = installer.terminal(flags, [KEY_QUESTION])
    assert_started(installer, "home", code, output)
    assert answered == 1, output


def test_T3a_no_terminal_vendor(installer):
    code, output = installer.no_terminal()
    assert code == 2, output
    assert KEY_GUIDANCE in output
    assert KEY_STOP in output
    assert output.index(KEY_GUIDANCE) < output.index(KEY_STOP)
    assert "syntax error" not in output
    assert "Traceback" not in output
    installer.no_install()
    installer.no_curl()


def test_T3b_no_terminal_key(installer):
    code, output = installer.no_terminal(["--vendor=mock"])
    assert code == 2, output
    assert KEY_GUIDANCE in output
    assert KEY_STOP in output
    assert output.index(KEY_GUIDANCE) < output.index(KEY_STOP)
    installer.no_install()
    installer.no_curl()


def test_T3c_no_terminal_with_flags(installer):
    code, output = installer.no_terminal(["--vendor=mock", "--key=" + PCC_KEY])
    assert code == 0, output
    assert installer.read("node.key") == PCC_KEY
    assert installer.read("node.stdin") == "not-a-tty"
    installer.no_curl()


def test_T3d_empty_key(installer):
    code, output, answered = installer.terminal(["--vendor=mock"], [(KEY_QUESTION[0], "")])
    assert code == 2, output
    assert answered == 1, output
    assert "No PCC API key given. Nothing was installed." in output
    installer.no_install()
    installer.no_curl()


def test_T4_no_provisioning():
    source = SCRIPT.read_text()
    assert "/api/auth/provision" not in source
    assert "auto-provision" not in source.lower()


def test_T5b_node_on_path(installer):
    (installer.home / ".local/bin/pcc-node").unlink()
    code, output, answered = installer.terminal(["--vendor=mock"], [KEY_QUESTION])
    assert_started(installer, "path", code, output)
    assert answered == 1, output


def test_T6_approved_copy():
    script = SCRIPT.read_text()
    assert "#   --key=<PCC_API_KEY>  your PCC API key (default: prompt; this installer creates none)" in script.splitlines()
    assert KEY_GUIDANCE in script
    assert "Operator dashboard will appear at" not in script
    html = HTML.read_text()
    lines = html.splitlines()
    assert lines.count(H1) == 1
    assert lines.count(H2) == 1
    for forbidden in ("Auto-provision a PCC API key", "your kernel page will be at", "accepting jobs"):
        assert forbidden not in html
    positions = [lines.index(line) for line in H3]
    assert positions == sorted(positions)


def install_spec(installer):
    installs = [line for name in ("pip3.calls", "python3.calls", "venv-python.calls")
                for line in installer.calls(name) if " install " in " " + line + " "]
    assert len(installs) == 1, installs
    return installs[0].split("--upgrade ", 1)[1]


def test_n210_T1a_externally_managed_plain(tmp_path):
    case = Installer(tmp_path, managed=True, ensurepip=False)
    code, output, answered = case.terminal(None, [KEY_QUESTION])
    assert_started(case, "venv", code, output)
    assert answered == 1
    assert not any("--user" in call for call in case.calls("pip3.calls"))
    assert "externally-managed-environment" not in output


def test_n210_R1a_venv_own_pip(tmp_path):
    case = Installer(tmp_path, managed=True)
    code, output, answered = case.terminal(["--vendor=mock"], [KEY_QUESTION])
    assert_started(case, "venv", code, output)
    assert answered == 1
    spec = install_spec(case)
    assert case.calls("venv-python.calls") == ["-m pip install --quiet --upgrade " + spec]
    calls = case.calls("python3.calls")
    assert calls.count("-m venv " + str(case.venv)) == 1
    assert not any("--without-pip" in call or "-m pip" in call for call in calls)


def test_n210_R1b_system_pip_python(tmp_path):
    case = Installer(tmp_path, managed=True, ensurepip=False)
    code, output, answered = case.terminal(["--vendor=mock"], [KEY_QUESTION])
    assert_started(case, "venv", code, output)
    assert answered == 1
    spec = install_spec(case)
    assert case.calls("python3.calls")[1:] == [
        "-m venv " + str(case.venv),
        "-m venv --without-pip " + str(case.venv),
        "-m pip --python " + str(case.venv / "bin/python") + " --version",
        "-m pip --python " + str(case.venv / "bin/python") + " install --quiet --upgrade " + spec,
    ]
    assert not (case.log / "venv-python.calls").exists()
    assert "The virtual environment was not created" not in output


def test_n210_R1e_no_usable_venv(tmp_path):
    case = Installer(tmp_path, managed=True, ensurepip=False, pip="22.0.2")
    code, output = case.no_terminal(["--vendor=mock", "--key=" + PCC_KEY])
    assert code == 1, output
    assert ("pcc-node was not installed: this system's Python is externally managed, and this installer couldn't set up a virtual environment for pcc-node in "
            + str(case.venv) + ". On Debian and Ubuntu, install the python3-venv package (sudo apt install python3-venv), then run this again.") in output
    assert not any("install" in call for call in case.calls("python3.calls") + case.calls("pip3.calls"))
    assert not (case.log / "venv-python.calls").exists()
    assert not (case.log / "node.calls").exists()
    assert "no such option" not in output


def test_n210_T1b_pinned_crypto_spec(tmp_path):
    commits = []
    for label, managed, ensurepip in (("user", False, True), ("own-pip", True, True),
                                      ("system-pip", True, False)):
        case = Installer(tmp_path / label, managed=managed, ensurepip=ensurepip)
        code, output = case.no_terminal(["--vendor=mock", "--key=" + PCC_KEY])
        assert code == 0, output
        matched = SPEC_RE.fullmatch(install_spec(case))
        assert matched is not None, install_spec(case)
        commits.append(matched.group(1))
        assert "[3/4] installing pcc-node from source (commit " + commits[-1][:12] + ")" in output
    assert commits == [PIN] * 3
    assert SCRIPT.read_text().count(PIN) == 1


@pytest.mark.parametrize("stale_venv", (False, True), ids=("fresh", "stale-venv"))
def test_n210_T1c_user_rung(tmp_path, stale_venv):
    case = Installer(tmp_path)
    if stale_venv:
        case.nodes["venv"].parent.mkdir(parents=True)
        shutil.copy2(case.env["N210_NODE_STUB"], case.nodes["venv"])
    code, output, answered = case.terminal(["--vendor=mock"], [KEY_QUESTION])
    assert code == 0, output
    assert answered == 1
    calls = case.calls("pip3.calls")
    assert len(calls) == 1 and calls[0].startswith("install --user --quiet --upgrade ")
    assert not any("-m venv" in call or "-m pip" in call for call in case.calls("python3.calls"))
    assert case.read("node.which") == "home"
    assert case.read("node.bin") == str(case.nodes["home"])


@pytest.mark.parametrize("vendor", VENDORS + ("retired-flags",))
def test_n210_T2a_only_key(installer, vendor):
    flags = ["--vendor=" + ("hamilton" if vendor == "retired-flags" else vendor), "--key=" + PCC_KEY]
    if vendor == "retired-flags":
        flags += ["--url=" + URL, "--user=" + USER, "--pass=" + PASSWORD]
    code, output = installer.no_terminal(flags)
    assert code == 0, output
    assert installer.read("node.key") == PCC_KEY
    assert installer.read("node.kernel_config_set") == ""
    assert "No terminal to ask" not in output
    if vendor == "retired-flags":
        assert output.count(S15) == 1
        for value in (URL, USER, PASSWORD):
            assert value not in output


def test_n210_T2b_page_list():
    html = HTML.read_text()
    for line in (H5, H6):
        assert html.splitlines().count(line) == 1
    # The separate LLM hand-off still discusses the TS kernel's config and is
    # explicitly outside N210-A. Check the install step list for this promise.
    steps = html.split("<ol>", 1)[1].split("</ol>", 1)[0]
    assert "KERNEL_CONFIG" not in steps
    assert "URL + credentials" not in html


def test_n210_L2_no_prompt_before_terminal(installer):
    code, output = installer.no_terminal(["--vendor=mock", "--no-prompt"])
    assert code == 2, output
    assert "missing PCC_KEY and --no-prompt set; aborting" in output
    assert "No terminal to ask" not in output
    installer.no_install()


@pytest.mark.parametrize("source", ("terminal", "flag", "blank"))
def test_n210_I2_key_trim(installer, source):
    if source == "flag":
        code, output = installer.no_terminal(["--vendor=mock", "--key= " + PCC_KEY + " "])
    else:
        answer = "   " if source == "blank" else "  " + PCC_KEY + " \t"
        code, output, answered = installer.terminal(["--vendor=mock"], [(KEY_QUESTION[0], answer)])
        assert answered == 1
    if source == "blank":
        assert code == 2, output
        assert "No PCC API key given. Nothing was installed." in output
        installer.no_install()
    else:
        assert code == 0, output
        assert installer.read("node.key") == PCC_KEY


def test_n210_T3_page_vendors(tmp_path):
    match = re.search(r"const KNOWN_ADAPTERS = new Set\(\[([^\]]*)\]\);", HTML.read_text())
    assert match is not None
    known = re.findall(r"'([^']+)'", match.group(1))
    assert set(known) == set(VENDORS)
    for vendor in known + ["modbus", "opcua"]:
        case = Installer(tmp_path / vendor)
        code, output = case.no_terminal(["--vendor=" + vendor, "--key=" + PCC_KEY])
        if vendor in VENDORS:
            assert code == 0, output
        else:
            assert code == 2, output
            assert "unknown vendor: " + vendor in output
            assert "[1/4]" not in output
            case.no_install()


def save_without_start(installer, extra=()):
    return installer.no_terminal(["--no-start", "--vendor=mock", "--key=" + PCC_KEY] + list(extra))


def summary_kernel(output):
    match = re.search(r"^  kernelId:   (.+)\r?$", output, re.MULTILINE)
    assert match is not None, output
    return match.group(1)


def expected_saved(output, gateway="http://127.0.0.1:9"):
    return {"pcc_base": gateway, "pcc_api_key": PCC_KEY, "kernel_id": summary_kernel(output)}


def saved_line(installer):
    return ("--no-start: pcc-node's config is saved in " + str(installer.config)
            + " (mode 0600). Nothing was registered: pcc-node registers your kernel when it starts.")


def printed_command(output):
    lines = output.splitlines()
    # The first two S18 lines may have terminal colors; the command itself is plain.
    index = next(i for i, line in enumerate(lines) if "To start it, run:" in line)
    assert lines[index + 1].startswith("  ")
    return shlex.split(lines[index + 1])


def test_n210_T5a_saved_file(installer):
    code, output = save_without_start(installer)
    assert code == 0, output
    assert not (installer.log / "node.calls").exists()
    info = installer.config.lstat()
    assert stat.S_ISREG(info.st_mode)
    assert stat.S_IMODE(info.st_mode) == 0o600
    assert info.st_uid == os.getuid()
    assert stat.S_IMODE(installer.config.parent.stat().st_mode) == 0o700
    assert json.loads(installer.config.read_text()) == expected_saved(output)
    assert S17 in output
    assert saved_line(installer) in output
    assert "To start it, run:" in output
    assert PCC_KEY not in output
    assert "Replaced pcc-node's earlier config" not in output
    for name in ("python3.argv", "env.argv"):
        path = installer.log / name
        arguments = path.read_bytes().split(b"\0") if path.exists() else []
        assert all(PCC_KEY.encode() not in argument for argument in arguments)
    assert not list(installer.config.parent.glob(".pcc-node.json.*"))
    assert not list(installer.cwd.iterdir())


def test_n210_T5b_config_loader(installer, caplog):
    code, output = save_without_start(installer)
    assert code == 0, output
    caplog.clear()
    assert load_config_data(str(installer.config)) == expected_saved(output)
    assert not caplog.records


def test_n210_T5c_help_copy():
    script = SCRIPT.read_text()
    assert S11 in script.splitlines()
    assert "generate config + register" not in script
    assert "environment exported but daemon NOT started" not in script


@pytest.mark.parametrize("cell", ("local", "public", "missing-no-key", "missing-key"))
def test_n210_T5d_printed_command(installer, cell):
    control = cell.startswith("missing-")
    gateway = "https://capability.network" if cell == "public" else "http://127.0.0.1:9"
    if control:
        args = ["start", "--config-file", str(installer.home / "missing.json")]
        kernel_id = None
    else:
        extra = ["--gateway=" + gateway]
        code, output = save_without_start(installer, extra)
        assert code == 0, output
        words = printed_command(output)
        assert words == [str(installer.nodes["home"]), "start", "--config-file", str(installer.config)]
        args = words[1:]
        kernel_id = summary_kernel(output)
    env = {"HOME": str(installer.home), "PCC_BASE": None, "PCC_API_KEY": None, "KERNEL_ID": None}
    if cell == "missing-key":
        env["PCC_API_KEY"] = PCC_KEY
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli.detect_all", return_value=[]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
         mock.patch("pcc_node.cli.provision_api_key", side_effect=AssertionError("unexpected provisioning")), \
         mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}) as register, \
         mock.patch("pcc_node.cli.register_devices"), \
         mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})), \
         mock.patch("pcc_node.cli.run_daemon") as daemon, \
         mock.patch("pcc_node.register.pcc_request", side_effect=AssertionError("unexpected request")), \
         mock.patch("pcc_node.http_util.pcc_request", side_effect=AssertionError("unexpected request")):
        result = CliRunner().invoke(main, args, env=env, input="")
    if control:
        assert result.exit_code == 1, result.output
        refusal = ("Pass --yes or set PCC_BASE to register with the public network." if cell == "missing-key"
                   else "Refusing to start: no gateway chosen and no API key")
        assert refusal in result.output
        register.assert_not_called()
        daemon.assert_not_called()
    else:
        assert result.exit_code == 0, (result.output, result.exception)
        register.assert_called_once()
        actual_gateway, key, config = register.call_args[0]
        assert actual_gateway == gateway
        assert key == PCC_KEY
        assert config.kernel_id == kernel_id
        daemon.assert_called_once()
        assert "Refusing to start: no gateway chosen" not in result.output
        assert "Pass --yes or set PCC_BASE" not in result.output


@pytest.mark.parametrize("cell", ("file-symlink", "file-directory", "directory-symlink"))
def test_n210_T5e_unsafe_paths(installer, tmp_path, cell):
    if cell == "directory-symlink":
        target = tmp_path / "other"
        target.mkdir()
        installer.config.parent.symlink_to(target, target_is_directory=True)
        refused, kind = installer.config.parent, "a directory"
    else:
        installer.config.parent.mkdir(mode=0o700)
        if cell == "file-symlink":
            target = installer.home / "elsewhere.json"
            target.write_text("{}")
            installer.config.symlink_to(target)
        else:
            installer.config.mkdir()
        refused, kind = installer.config, "a regular file"
    code, output = save_without_start(installer)
    assert code == 1, output
    assert ("Not saving pcc-node's config: " + str(refused) + " must be " + kind
            + " you own, not a symbolic link. Move it aside, then run this again. pcc-node is installed; nothing was registered.") in output
    assert not (installer.log / "node.calls").exists()
    assert not list(installer.config.parent.glob(".pcc-node.json.*"))
    if cell == "file-symlink":
        assert installer.config.is_symlink()
        assert target.read_text() == "{}"
    elif cell == "file-directory":
        assert installer.config.is_dir()
        assert not list(installer.config.iterdir())
    else:
        assert installer.config.parent.is_symlink()
        assert not list(target.iterdir())


@pytest.mark.parametrize("cell", ("earlier-no-start", "started-config", "not-json", "empty-object", "unprintable-id"))
def test_n210_T5f_replaced_kernel_id(installer, cell):
    previous = None
    if cell == "earlier-no-start":
        previous = "kernel_earlier_1"
        code, output = save_without_start(installer, ["--kernel-id=" + previous])
        assert code == 0, output
        assert "Replaced pcc-node's earlier config" not in output
    else:
        installer.config.parent.mkdir(mode=0o700)
        if cell == "started-config":
            previous = "kernel-0123456789ab"
            data = json.dumps(NodeConfig(kernel_id=previous, pcc_base="http://127.0.0.1:9",
                                         pcc_api_key=PCC_KEY).to_dict(), indent=2)
        else:
            data = {"not-json": "not json", "empty-object": "{}",
                    "unprintable-id": '{"kernel_id": "kernel\\u001b[2J"}'}[cell]
        installer.config.write_text(data)
        installer.config.chmod(0o600)
    code, output = save_without_start(installer)
    assert code == 0, output
    assert json.loads(installer.config.read_text()) == expected_saved(output)
    assert not (installer.log / "node.calls").exists()
    if previous is not None:
        line = ("Replaced pcc-node's earlier config in " + str(installer.config)
                + ", which named kernel ID " + previous + ".")
        clean_lines = re.sub(r"\x1b\[[0-9;]*m", "", output).splitlines()
        assert output.count(line) == 1
        index = clean_lines.index(line)
        assert clean_lines[index + 1] == saved_line(installer)
    else:
        assert "Replaced pcc-node's earlier config" not in output
        assert "Traceback" not in output
        assert "\x1b[2J" not in output


def test_n210_T5q_shell_paths(tmp_path):
    case = Installer(tmp_path / "it's a dir")
    code, output = save_without_start(case)
    assert code == 0, output
    assert printed_command(output) == [str(case.nodes["home"]), "start", "--config-file", str(case.config)]
    assert case.config.is_file()


def test_n210_T8_removed_copy():
    script = SCRIPT.read_text()
    assert S9 in script.splitlines()
    removed = (
        "#   curl -fsSL https://capability.network/install.sh | bash -s -- --vendor=hamilton --url=http://192.168.1.50 --user=alice",
        "#   --url=<URL>          instrument URL on the LAN (default: prompt)",
        "#   --user=<USERNAME>    instrument username/api-key (default: prompt; type-dependent)",
        "#   --pass=<PASSWORD>    instrument password (default: prompt; only Hamilton needs this)",
        "[2/6]", "generating KERNEL_CONFIG",
    )
    for text in removed:
        assert text not in script
