"""Runtime proof of Layer 2 -- the in-process Landlock execute restriction (pcc_node/_landlock.py,
steward ruling 10/03, verdict 105n). Landlock is IRREVERSIBLE once applied, so every test that calls
restrict() does so in a forked child and reports results back over a pipe; the pytest process is never
restricted. The self-test pins BOTH what Landlock guarantees (the direct execve of a non-pinned binary
is refused; the interpreter and C-extensions still load) AND its documented residual (the granted ELF
loader remains an exec gadget -- `execve(ld.so, [ld, <non-pinned>])` runs it), which is Layer 1's
(AppArmor's) job to close. Pinning the residual keeps anyone from later mistaking L2 for a complete
allowlist."""
import os
import shutil
import sys

import pytest

from pcc_node import _landlock

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or not hasattr(os, "fork") or not _landlock.available(),
    reason="Landlock self-test needs a POSIX host with Landlock (Linux 5.13+) and os.fork",
)

TRUE = os.path.realpath(shutil.which("true") or "/bin/true")
FALSE = os.path.realpath(shutil.which("false") or "/bin/false")


def _exec_in_grandchild(argv, path=None):
    """Fork, execv the target, return its exit code (13 == EACCES, Landlock refused the execve)."""
    pid = os.fork()
    if pid == 0:
        try:
            os.execv(path or argv[0], argv)
        except OSError as ex:
            os._exit(13 if ex.errno == 13 else 90)
        os._exit(0)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


def _probe_under_landlock(tmp_elf):
    """In a forked child: apply the real restrict([TRUE]) ruleset, then measure several execve paths
    plus a fresh C-extension load. Results come back as 'name=value' lines over a pipe."""
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        out = {}
        try:
            out["applied"] = _landlock.restrict([TRUE])
            out["pinned"] = _exec_in_grandchild([TRUE])                       # expect 0 (runs)
            out["direct_nonpinned"] = _exec_in_grandchild([FALSE])            # expect 13 (EACCES)
            out["direct_tmp_elf"] = _exec_in_grandchild([tmp_elf])            # expect 13 (EACCES)
            ld = os.path.realpath(_landlock._elf_interpreter(TRUE))
            out["loader_gadget"] = _exec_in_grandchild([ld, FALSE], path=ld)  # RESIDUAL: runs (rc 1)
            # A fresh C-extension import is an mmap(PROT_EXEC), which Landlock must NOT block.
            for m in ("bz2", "_bz2"):
                sys.modules.pop(m, None)
            try:
                import bz2
                bz2.compress(b"x")
                out["extension_loads"] = True
            except Exception:
                out["extension_loads"] = False
            payload = ";".join(f"{k}={v}" for k, v in out.items())
        except Exception as ex:  # report, don't hang the parent
            payload = f"error={type(ex).__name__}:{ex}"
        os.write(w, payload.encode())
        os.close(w)
        os._exit(0)
    os.close(w)
    data = b""
    while True:
        chunk = os.read(r, 4096)
        if not chunk:
            break
        data += chunk
    os.close(r)
    os.waitpid(pid, 0)
    fields = {}
    for part in data.decode().split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            fields[k] = v
    return fields


def test_available_reports_landlock_on_this_kernel():
    assert _landlock.available() is True


def test_elf_interpreter_resolves_the_loader():
    interp = _landlock._elf_interpreter(TRUE)
    assert interp and "ld-" in interp and os.path.exists(interp)


def test_restrict_with_no_resolvable_paths_is_a_safe_noop():
    # No grants -> returns False WITHOUT applying a ruleset, so this is safe to call in-process.
    assert _landlock.restrict([]) is False


def test_landlock_blocks_direct_nonpinned_execve_but_loads_extensions_and_leaves_the_loader_gadget(tmp_path):
    tmp_elf = str(tmp_path / "copy")
    shutil.copy(FALSE, tmp_elf)
    os.chmod(tmp_elf, 0o755)
    r = _probe_under_landlock(tmp_elf)
    assert "error" not in r, r
    assert r["applied"] == "True", "Landlock ruleset was not applied"
    # The guarantee: pinned runs; the DIRECT execve of a non-pinned binary / a /tmp ELF is refused.
    assert r["pinned"] == "0", f"pinned utility did not run: {r}"
    assert r["direct_nonpinned"] == "13", f"non-pinned /bin/false was not EACCES: {r}"
    assert r["direct_tmp_elf"] == "13", f"non-pinned /tmp ELF was not EACCES: {r}"
    # The interpreter + C-extensions keep working (FS_EXECUTE does not govern library mmap).
    assert r["extension_loads"] == "True", f"a C-extension failed to load under Landlock: {r}"
    # The DOCUMENTED RESIDUAL: the granted loader runs a non-pinned ELF. Landlock cannot close this;
    # Layer 1 (AppArmor, deny loader execute-as-program) does. If this ever becomes '13', Landlock's
    # behaviour changed and the honest story in the docs/README must be revisited.
    assert r["loader_gadget"] != "13", (
        "loader gadget unexpectedly blocked -- re-check the L1/L2 split in _landlock.py and README")
    assert r["loader_gadget"] == "1", f"loader ran a non-pinned binary (expected its rc=1): {r}"
