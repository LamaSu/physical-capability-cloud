"""The release gate refuses every way a pcc-node build could bring back what
0.1.1 removed. pypi-publish.yml runs this before it builds, so a weakened gate
fails the release. Standard library only:
python .github/scripts/test_check_pcc_node_dist.py -v
"""

import contextlib
import io
import pathlib
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_pcc_node_dist as gate  # noqa: E402

VERSION = "0.1.1"
CLEAN_CODE = {
    "pcc_node/__init__.py": '__version__ = "0.1.1"\n',
    "pcc_node/job_executor.py": 'import subprocess\nsubprocess.run(["lp", "-d", "p"], check=True)\n',
    "pcc_node/ui_templates/job-status.html": "<html></html>\n",
}


def metadata(version=VERSION, name="pcc-node"):
    return f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n\n"


def build_dist(root, *, version=VERSION, wheel_extra=None, sdist_extra=None,
               wheel_name=None, sdist_name=None, extra_files=(), sdist_link=False):
    """Write a synthetic dist/ that passes the gate unless a case changes it."""
    dist = pathlib.Path(root) / "dist"
    dist.mkdir()
    wheel_files = dict(CLEAN_CODE)
    wheel_files[f"pcc_node-{version}.dist-info/METADATA"] = metadata(version)
    wheel_files.update(wheel_extra or {})
    with zipfile.ZipFile(dist / (wheel_name or f"pcc_node-{version}-py3-none-any.whl"), "w") as wheel:
        for name, text in wheel_files.items():
            wheel.writestr(name, text)
    top = f"pcc_node-{version}/"
    sdist_files = dict(CLEAN_CODE)
    sdist_files["PKG-INFO"] = metadata(version)
    sdist_files["pyproject.toml"] = "[project]\nname = 'pcc-node'\n"
    # The shipped guard test names shell=True on purpose; tests are not package code.
    sdist_files["tests/test_no_shell_execution.py"] = 'PATTERNS = {"shell=True": None}\n'
    sdist_files.update(sdist_extra or {})
    with tarfile.open(dist / (sdist_name or f"pcc_node-{version}.tar.gz"), "w:gz") as sdist:
        for name, text in sdist_files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(top + name)
            info.size = len(data)
            sdist.addfile(info, io.BytesIO(data))
        if sdist_link:
            link = tarfile.TarInfo(top + "pcc_node/linked.py")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            sdist.addfile(link)
    for name in extra_files:
        (dist / name).write_bytes(b"x")
    return dist


def run_gate(dist, tag=f"pcc-node-v{VERSION}"):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = gate.main(["--tag", tag, str(dist)])
    return code, out.getvalue()


class ReleaseGate(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def assertRefused(self, dist, reason, tag=f"pcc-node-v{VERSION}"):
        code, out = run_gate(dist, tag)
        self.assertEqual(code, 1, out)
        self.assertIn("REFUSED", out)
        self.assertIn(reason, out)
        return out

    def test_a_clean_build_passes_and_is_listed(self):
        code, out = run_gate(build_dist(self.root))
        self.assertEqual(code, 0, out)
        self.assertIn("pcc_node/job_executor.py", out)  # the listing the operator asked for
        self.assertIn("OK: pcc-node 0.1.1", out)

    def test_the_shell_executor_is_refused_in_the_wheel(self):
        dist = build_dist(self.root, wheel_extra={"pcc_node/executor.py": "x = 1\n"})
        self.assertRefused(dist, "wheel pcc_node/executor.py: the relay shell executor")

    def test_the_shell_executor_is_refused_in_the_sdist(self):
        dist = build_dist(self.root, sdist_extra={"pcc_node/executor.py": "x = 1\n"})
        self.assertRefused(dist, "sdist pcc_node/executor.py: the relay shell executor")

    def test_shell_true_in_package_code_is_refused_with_its_line(self):
        code = "import subprocess\n\nsubprocess.run(cmd, shell = True)\n"
        dist = build_dist(self.root, wheel_extra={"pcc_node/camera.py": code})
        self.assertRefused(dist, "pcc_node/camera.py:3: shell=True in the package code")

    def test_shell_true_in_shipped_tests_is_not_package_code(self):
        code, out = run_gate(build_dist(self.root))  # the sdist ships the guard test
        self.assertEqual(code, 0, out)

    def test_bytecode_is_refused(self):
        dist = build_dist(self.root, wheel_extra={"pcc_node/__pycache__/executor.cpython-311.pyc": "\x00"})
        self.assertRefused(dist, "compiled bytecode")

    def test_key_files_and_private_key_blocks_are_refused_without_echoing_them(self):
        marker = "PRIVATE " + "KEY-----"  # split so secret scanners do not flag this fixture
        fake = f"-----BEGIN {marker}\nNOT-A-REAL-KEY-TEST-FIXTURE\n-----END {marker}\n"
        dist = build_dist(self.root,
                          sdist_extra={"pcc-keys.json": "{}", "pcc_node/ui_templates/tls.pem": "x"},
                          wheel_extra={"pcc_node/ui_templates/notes.txt": fake})
        out = self.assertRefused(dist, "sdist pcc-keys.json: a key file by name")
        self.assertIn("sdist pcc_node/ui_templates/tls.pem: a key file by name", out)
        self.assertIn("wheel pcc_node/ui_templates/notes.txt: holds a PEM private-key block", out)
        self.assertNotIn("NOT-A-REAL-KEY-TEST-FIXTURE", out)

    def test_wheel_files_outside_the_package_are_refused(self):
        dist = build_dist(self.root, wheel_extra={"tests/test_cli.py": "x = 1\n"})
        self.assertRefused(dist, "tests/test_cli.py: outside pcc_node/")

    def test_a_link_in_the_sdist_is_refused(self):
        self.assertRefused(build_dist(self.root, sdist_link=True), "a link or special file")

    def test_the_tag_must_name_the_built_version(self):
        self.assertRefused(build_dist(self.root), "but the tag says 0.1.2", tag="pcc-node-v0.1.2")

    def test_metadata_must_name_the_tagged_version(self):
        dist = build_dist(self.root, wheel_extra={f"pcc_node-{VERSION}.dist-info/METADATA": metadata("0.1.0")})
        self.assertRefused(dist, "wheel METADATA names pcc-node 0.1.0")

    def test_malformed_tags_are_refused(self):
        dist = build_dist(self.root)
        for tag in ("v0.1.1", "pcc-node-0.1.1", "pcc-node-v0.1.1;true", "pcc-node-v"):
            with self.subTest(tag=tag):
                self.assertRefused(dist, "is not pcc-node-v<version>", tag=tag)

    def test_extra_or_missing_artifacts_are_refused(self):
        dist = build_dist(self.root, extra_files=["pcc_node-0.1.1-py2-none-any.whl"])
        self.assertRefused(dist, "unexpected file")
        (dist / f"pcc_node-{VERSION}.tar.gz").unlink()
        self.assertRefused(dist, "expected one wheel and one sdist, found 1 and 0")


def add_zip_symlink(wheel_path, name, target):
    info = zipfile.ZipInfo(name)
    info.create_system = 3  # Unix, so external_attr carries the file type
    info.external_attr = (0o120777 << 16)
    with zipfile.ZipFile(wheel_path, "a") as wheel:
        wheel.writestr(info, target)


def add_tar_member(sdist_path, name, data):
    # Rewrites the gzip'd tar with one more member (tarfile cannot append to .gz).
    with tarfile.open(sdist_path, "r:gz") as old:
        members = [(m, old.extractfile(m).read() if m.isfile() else None) for m in old.getmembers()]
    with tarfile.open(sdist_path, "w:gz") as sdist:
        for member, content in members:
            sdist.addfile(member, io.BytesIO(content) if content is not None else None)
        info = tarfile.TarInfo(name)
        info.size = len(data)
        sdist.addfile(info, io.BytesIO(data))


class ReleaseGateRound2(unittest.TestCase):
    """Verdict 93 on #449, findings 3, 4 and 6: each case passed the gate at 34332a67."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def refused(self, dist, reason):
        code, out = run_gate(dist)
        self.assertEqual(code, 1, out)
        self.assertIn(reason, out)
        return out

    def big(self, tail):
        return "#" * (gate.MAX_SCAN_BYTES + 1) + "\n" + tail

    def test_an_oversized_module_is_refused_in_the_wheel(self):
        dist = build_dist(self.root, wheel_extra={"pcc_node/job_executor.py": self.big("subprocess.run(cmd, shell=True)\n")})
        self.refused(dist, "wheel pcc_node/job_executor.py: too large to check")

    def test_an_oversized_module_is_refused_in_the_sdist(self):
        dist = build_dist(self.root, sdist_extra={"pcc_node/job_executor.py": self.big("subprocess.run(cmd, shell=True)\n")})
        self.refused(dist, "sdist pcc_node/job_executor.py: too large to check")

    def test_an_oversized_file_with_a_private_key_is_refused(self):
        marker = "PRIVATE " + "KEY-----"
        dist = build_dist(self.root, wheel_extra={"pcc_node/ui_templates/big.txt": self.big(f"-----BEGIN {marker}\n")})
        out = self.refused(dist, "wheel pcc_node/ui_templates/big.txt: too large to check")
        self.assertNotIn("BEGIN", out)

    def test_traversal_and_absolute_names_are_refused_in_the_wheel(self):
        for name in ("pcc_node/../../outside.py", f"pcc_node-{VERSION}.dist-info/../x.py", "/etc/cron.d/x",
                     "pcc_node/./cli.py", "pcc_node\\..\\x.py", "pcc_node//cli2.py"):
            with self.subTest(name=name):
                sub = pathlib.Path(self.root) / str(abs(hash(name)))
                sub.mkdir()
                dist = build_dist(sub, wheel_extra={name: "x = 1\n"})
                self.refused(dist, "not a plain relative path")

    def test_traversal_names_are_refused_in_the_sdist(self):
        dist = build_dist(self.root)
        add_tar_member(dist / f"pcc_node-{VERSION}.tar.gz", f"pcc_node-{VERSION}/../outside.py", b"x = 1\n")
        self.refused(dist, "not a plain relative path")

    def test_duplicate_names_are_refused(self):
        dist = build_dist(self.root)
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with zipfile.ZipFile(dist / f"pcc_node-{VERSION}-py3-none-any.whl", "a") as wheel:
                wheel.writestr("pcc_node/job_executor.py", "x = 2\n")
        self.refused(dist, "wheel pcc_node/job_executor.py: appears more than once")

    def test_a_zip_symlink_is_refused(self):
        dist = build_dist(self.root)
        add_zip_symlink(dist / f"pcc_node-{VERSION}-py3-none-any.whl", "pcc_node/linked.py", "/etc/passwd")
        self.refused(dist, "wheel pcc_node/linked.py: a link or special file")

    def test_member_names_are_printed_escaped(self):
        name = "pcc_node/x\n::error::injected\x1b[31m.py"
        dist = build_dist(self.root, wheel_extra={name: "x = 1\n"})
        code, out = run_gate(dist)
        self.assertNotIn("\n::error::", out)
        self.assertNotIn("\x1b", out)
        self.assertIn("\\n::error::injected\\x1b", out)


if __name__ == "__main__":
    unittest.main()
