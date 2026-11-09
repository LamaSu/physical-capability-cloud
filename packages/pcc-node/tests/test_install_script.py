"""N209: exercise both published pipe-to-bash commands without network access."""

import errno
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import shutil
import signal
import subprocess
import time

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = Path(os.environ.get("N209_INSTALL_SH", ROOT / "apps/dashboard/public/install.sh"))
HTML = Path(os.environ.get("N209_INSTALL_HTML", ROOT / "apps/dashboard/public/install.html"))
REAL_PYTHON = shutil.which("python3")
RUNNER_PATH = os.environ["PATH"]
URL = "http://192.0.2.10:8080"
USER = "alice"
OCTO_KEY = "octo-api-key-123"
PASSWORD = "pa'ss\" w\\o$rd`x` "
PCC_KEY = "pcc_live_installer-test-not-a-key"
VENDORS = ("hamilton", "opentrons", "octoprint", "sila", "mock")
KEY_QUESTION = (r"PCC API key[^\r\n]*: ", PCC_KEY)
KEY_GUIDANCE = (
    "  This installer doesn't create PCC API keys. How to get one: "
    "https://capability.network/auth.md"
)
H1 = '              <li>Ask you for a PCC API key (it doesn\'t create one: <a href="/auth.md">how to get one</a>)</li>'
H2 = '            <p style="margin-top:18px;color:#9aa3b2">When done, the node has registered your kernel using your PCC API key. The node keeps your kernel online and does not take jobs: your devices run only through your operating agent\'s typed operations.</p>'
H3 = [
    "              <li>Check for python3 / pip / git</li>",
    "              <li>Ask you for the instrument URL + credentials</li>",
    H1,
    "              <li>Install <code>pcc-node</code> from source (covers all current adapters)</li>",
    "              <li>Generate a KERNEL_CONFIG and start the kernel daemon</li>",
]


class Installer:
    def __init__(self, root):
        self.home = root / "home"
        self.cwd = root / "cwd"
        self.bin = root / "bin"
        self.log = root / "log"
        for directory in (self.home, self.cwd, self.bin, self.log):
            directory.mkdir()
        self.env = {
            "HOME": str(self.home),
            "PATH": str(self.bin) + os.pathsep + RUNNER_PATH,
            "LANG": "C.UTF-8",
            "TERM": "dumb",
            "PCC_BASE": "http://127.0.0.1:9",
            "N209_LOG": str(self.log),
        }
        self.stub("pip3", 'printf "%s\\n" "$*" >> "$N209_LOG/pip3.calls"\nexit 0\n')
        self.stub("git", "exit 1\n")
        self.stub("curl", 'printf "%s\\n" "$*" >> "$N209_LOG/curl.calls"\nexit 7\n')
        self.stub("pcc-node", '''printf '%s\\n' "$*" >> "$N209_LOG/node.calls"
if [ -t 0 ]; then
    printf '%s' tty > "$N209_LOG/node.stdin"
else
    printf '%s' not-a-tty > "$N209_LOG/node.stdin"
fi
printf '%s' "$PCC_API_KEY" > "$N209_LOG/node.key"
printf '%s' "$KERNEL_ID" > "$N209_LOG/node.kernel_id"
printf '%s' "$KERNEL_CONFIG" > "$N209_LOG/node.kernel_config"
exit 0
''')
        local_node = self.home / ".local/bin/pcc-node"
        local_node.parent.mkdir(parents=True)
        shutil.copy2(self.bin / "pcc-node", local_node)

    def stub(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def record_python_argv(self):
        assert REAL_PYTHON is not None
        self.stub("python3", '''printf '%s\\0' "$@" >> "$N209_LOG/python3.argv"
exec ''' + shlex.quote(REAL_PYTHON) + ' "$@"\n')

    def command(self, flags=None):
        if flags is None:
            return ["bash", "-c", 'cat "$0" | bash', str(SCRIPT)]
        return ["bash", "-c", 'cat "$0" | bash -s -- "$@"', str(SCRIPT)] + flags

    def terminal(self, flags, questions):
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(str(self.cwd))
            os.execvpe("bash", self.command(flags), self.env)
        output = b""
        answered = 0
        cursor = 0
        status = None
        deadline = time.monotonic() + 30
        try:
            while True:
                if time.monotonic() >= deadline:
                    pytest.fail("installer timed out: " + output.decode(errors="replace"))
                if answered < len(questions):
                    pattern, answer = questions[answered]
                    if re.search(pattern.encode() + rb"$", output[cursor:], re.MULTILINE):
                        time.sleep(0.1)
                        cursor = len(output)
                        os.write(fd, (answer + "\n").encode())
                        answered += 1
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
                os.kill(pid, signal.SIGKILL)
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

    def no_install(self):
        assert not (self.log / "pip3.calls").exists()
        assert not (self.log / "node.calls").exists()

    def no_curl(self):
        assert not (self.log / "curl.calls").exists()

    def password_not_in_argv(self):
        arguments = (self.log / "python3.argv").read_bytes().split(b"\0")
        assert all(PASSWORD.encode() not in argument for argument in arguments)


@pytest.fixture
def installer(tmp_path):
    return Installer(tmp_path)


def questions_for(vendor, plain):
    questions = [(r"Vendor \(hamilton[^\r\n]*: ", vendor)] if plain else []
    questions += {
        "hamilton": [
            (r"Hamilton instrument URL[^\r\n]*: ", URL),
            (r"Hamilton username[^\r\n]*: ", USER),
            (r"Hamilton password[^\r\n]*: ", PASSWORD),
        ],
        "opentrons": [(r"Opentrons URL[^\r\n]*: ", URL)],
        "octoprint": [
            (r"OctoPrint URL[^\r\n]*: ", URL),
            (r"OctoPrint API key[^\r\n]*: ", OCTO_KEY),
        ],
        "sila": [(r"SiLA server URL[^\r\n]*: ", URL)],
        "mock": [],
    }[vendor]
    return questions + [KEY_QUESTION]


def expected_config(vendor, kernel_id):
    config = {
        "hamilton": {"url": URL, "username": USER, "password": PASSWORD,
                     "mockMode": False, "pollIntervalMs": 3000},
        "opentrons": {"url": URL, "apiVersion": "2.18", "mockMode": False},
        "octoprint": {"url": URL, "apiKey": OCTO_KEY, "mockMode": False},
        "sila": {"url": URL},
        "mock": {"mockMode": True},
    }[vendor]
    config["kernelId"] = kernel_id
    return {"kernelId": kernel_id, "devices": [{
        "id": "dev_" + vendor + "_01",
        "type": "sensor" if vendor == "sila" else "machine",
        "adapterType": vendor, "config": config,
    }]}


def assert_started(installer, vendor, code, output):
    assert code == 0, output
    for step in range(1, 7):
        assert "[{}/6]".format(step) in output
    for error in ("Traceback", "NameError", "SyntaxError", "syntax error"):
        assert error not in output
    assert installer.read("node.key") == PCC_KEY
    kernel_id = installer.read("node.kernel_id")
    assert re.fullmatch(r"kernel_.+_[0-9]+", kernel_id)
    assert json.loads(installer.read("node.kernel_config")) == expected_config(vendor, kernel_id)
    assert PCC_KEY not in output
    assert PASSWORD not in output
    if vendor == "octoprint":
        assert OCTO_KEY not in output
    assert installer.read("node.calls") == "start\n"
    assert installer.read("node.stdin") == "tty"
    installer.no_curl()


@pytest.mark.parametrize("vendor", VENDORS)
@pytest.mark.parametrize("page_command", ("plain", "vendor"))
def test_T1_page_commands(installer, vendor, page_command):
    """T1; Hamilton also covers T2a/T2c, and every case covers T5a."""
    if vendor == "hamilton":
        installer.record_python_argv()
    plain = page_command == "plain"
    questions = questions_for(vendor, plain)
    flags = None if plain else ["--vendor=" + vendor]
    code, output, answered = installer.terminal(flags, questions)
    assert_started(installer, vendor, code, output)
    assert answered == len(questions), output
    if vendor == "hamilton":
        installer.password_not_in_argv()


def test_T2b_T2c_password_flag(installer):
    installer.record_python_argv()
    flags = ["--vendor=hamilton", "--url=" + URL, "--user=" + USER, "--pass=" + PASSWORD]
    code, output, answered = installer.terminal(flags, [KEY_QUESTION])
    assert_started(installer, "hamilton", code, output)
    assert answered == 1, output
    installer.password_not_in_argv()


def test_T3a_no_terminal_vendor(installer):
    code, output = installer.no_terminal()
    assert code == 2, output
    assert "No terminal to ask: Vendor (hamilton | opentrons | octoprint | sila | mock). Pass --vendor=<TYPE> and run again. Nothing was installed." in output
    assert "syntax error" not in output
    assert "Traceback" not in output
    installer.no_install()
    installer.no_curl()


def test_T3b_no_terminal_key(installer):
    code, output = installer.no_terminal(["--vendor=mock"])
    assert code == 2, output
    stop = "No terminal to ask: Paste a PCC API key (pcc_live_*). Run it in a terminal to type it hidden, or pass --key=<PCC_API_KEY> (a flag shows in the process list and your shell history). Nothing was installed."
    assert KEY_GUIDANCE in output
    assert stop in output
    assert output.index(KEY_GUIDANCE) < output.index(stop)
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


def test_T3e_no_terminal_octoprint_key(installer):
    code, output = installer.no_terminal(["--vendor=octoprint", "--url=" + URL])
    assert code == 2, output
    assert "No terminal to ask: OctoPrint API key (X-Api-Key). Run it in a terminal to type it hidden, or pass --user=<USERNAME> (a flag shows in the process list and your shell history). Nothing was installed." in output
    installer.no_install()
    installer.no_curl()


def test_T4_no_provisioning():
    source = SCRIPT.read_text()
    assert "/api/auth/provision" not in source
    assert "auto-provision" not in source.lower()


def test_T5b_node_on_path(installer):
    (installer.home / ".local/bin/pcc-node").unlink()
    code, output, answered = installer.terminal(["--vendor=mock"], [KEY_QUESTION])
    assert_started(installer, "mock", code, output)
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
