"""In-process, PARTIAL hardening of pcc-node's spawn allowlist: a Landlock execute restriction.

Steward ruling (DECISIONS 10/03, after verdicts 105j-105m): a pure-Python audit hook
(:mod:`pcc_node.spawn_guard`) cannot *soundly* allow a device subprocess -- ordinary in-process
Python can mutate the hook's captured functions or race a ``preexec_fn``/thread. Landlock (Linux
5.13+, PEP-578-independent) raises the bar at the kernel:

- ``LANDLOCK_ACCESS_FS_EXECUTE`` governs ``execve``, NOT the ``mmap(PROT_EXEC)`` a library load does
  -- so the interpreter and its C extensions keep working while non-pinned ``execve`` is confined.
- A ruleset is applied with ``landlock_restrict_self`` and is IRREVERSIBLE for the thread and its
  children, so in-process Python (the 105l threat) cannot loosen it, and it covers ``/tmp`` too.

:func:`restrict` grants execute on the pinned utilities' real paths AND the ELF interpreter they need
(``execve`` of a dynamically linked binary also checks the interpreter -- verified: the binary is
EACCES until the loader is granted). It blocks the *direct* ``execve`` of any non-pinned binary (a
shell, an arbitrary ELF in ``/tmp`` or under ``/usr/lib``).

Landlock and AppArmor are COMPLEMENTARY, and the hard guarantee is the two TOGETHER -- pcc-node
refuses to run without Landlock (see :mod:`pcc_node._entry`), so neither is relied on alone:
- Landlock blocks the direct ``execve`` of ANY non-pinned binary, INCLUDING re-executing the
  interpreter: ``execve(python3, ["-c", <arbitrary>])`` is EACCES, because python3 is not a pinned
  utility. That is the path AppArmor cannot close, since it must grant python3 execute to run pcc-node
  at all -- so this is why Landlock is MANDATORY, not optional (verdict 105n, sol HIGH1).
- Landlock does NOT close the loader gadget: a dynamic binary needs its loader execute-granted, and
  Landlock's execute right does not mediate ``mmap(PROT_EXEC)``, so ``execve(ld.so, [ld, <any ELF>])``
  runs that ELF (the loader maps it). Verified in-lane (6.17/aarch64). AppArmor closes this -- a MAC
  LSM has separate execute-as-program and executable-mmap permissions, so it grants the loader
  map-only and denies execute-as-program.
So neither layer alone is the complete allowlist (AppArmor leaves the python path; Landlock leaves the
loader gadget); together they are. Both pair with :mod:`pcc_node.spawn_guard` (the accidental hook).

Where Landlock is unavailable :func:`restrict` returns False and :mod:`pcc_node._entry` refuses to run
unless the operator sets ``PCC_ALLOW_NO_LANDLOCK=1`` -- then only AppArmor + the hook apply and the
operating runtime must stay unarmed (steward ruling, folded into item 118 / #471).

This module is the ONE place pcc-node uses ``ctypes`` (there is no stdlib Landlock API): it issues
the three Landlock syscalls and nothing else. The no-shell guard (tests/test_no_shell_execution.py)
grants it a scoped exemption and pins that it imports ctypes only here and uses it only for Landlock.
It runs from the console entry (:mod:`pcc_node._entry`) before any CLI dependency imports.
"""

import ctypes
import logging
import os

log = logging.getLogger("pcc-node.landlock")

# Landlock is a set of arch-generic syscalls, added with the same numbers across the arches pcc-node
# targets. An arch we don't know the numbers for is treated as "Landlock unavailable".
_SYSCALLS = {
    "x86_64": (444, 445, 446),
    "aarch64": (444, 445, 446),
    "riscv64": (444, 445, 446),
    "ppc64le": (444, 445, 446),
    "s390x": (444, 445, 446),
}
_FS_EXECUTE = 1 << 0
_RULE_PATH_BENEATH = 1
_CREATE_RULESET_VERSION = 1 << 0
_PR_SET_NO_NEW_PRIVS = 38


class _PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def _elf_interpreter(path):
    """The dynamic loader an ELF asks for (its PT_INTERP), or None for a static/unknown binary."""
    try:
        with open(path, "rb") as f:
            head = f.read(64)
            if head[:4] != b"\x7fELF" or head[4] != 2:  # ELF64 only (the pcc-node targets)
                return None
            endian = "little" if head[5] == 1 else "big"

            def u(off, size):
                return int.from_bytes(head[off:off + size], endian)

            e_phoff, e_phentsize, e_phnum = u(0x20, 8), u(0x36, 2), u(0x38, 2)
            for i in range(e_phnum):
                f.seek(e_phoff + i * e_phentsize)
                ph = f.read(e_phentsize)
                if int.from_bytes(ph[0:4], endian) != 3:  # PT_INTERP
                    continue
                p_offset = int.from_bytes(ph[8:16], endian)
                p_filesz = int.from_bytes(ph[32:40], endian)
                f.seek(p_offset)
                return f.read(p_filesz).rstrip(b"\x00").decode("utf-8", "strict")
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return None


def available():
    """Whether this kernel offers Landlock with at least the execute right (ABI >= 1)."""
    nrs = _SYSCALLS.get(os.uname().machine)
    if nrs is None:
        return False
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    ver = libc.syscall(ctypes.c_long(nrs[0]), None, ctypes.c_size_t(0), ctypes.c_uint32(_CREATE_RULESET_VERSION))
    return ver > 0


def restrict(paths):
    """Confine ``execve`` to exactly ``paths`` (absolute) and the ELF interpreters they need.

    Returns True once the kernel ruleset is in force (irreversibly), False if Landlock is
    unavailable or the ruleset could not be applied.
    """
    nrs = _SYSCALLS.get(os.uname().machine)
    if nrs is None:
        log.warning("Landlock: unknown arch %s; execute-allowlist NOT enforced", os.uname().machine)
        return False
    create, add_rule, restrict_self = nrs
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long

    def sc(n, *a):
        ctypes.set_errno(0)
        r = libc.syscall(ctypes.c_long(n), *a)
        return r, ctypes.get_errno()

    if not available():
        log.warning("Landlock: unavailable on this kernel; execute-allowlist NOT enforced")
        return False

    # Grant execute on each real path plus the ELF interpreter each needs (dynamically linked binaries
    # also check FS_EXECUTE on their loader). Deduplicate by realpath.
    grants = set()
    for p in paths:
        rp = os.path.realpath(p)
        if not os.path.exists(rp):
            continue
        grants.add(rp)
        interp = _elf_interpreter(rp)
        if interp:
            grants.add(os.path.realpath(interp))
    if not grants:
        log.warning("Landlock: no pinned executables resolved; execute-allowlist NOT enforced")
        return False

    attr = ctypes.c_uint64(_FS_EXECUTE)  # ABI v1 ruleset_attr: one u64 (handled_access_fs)
    rs, e = sc(create, ctypes.byref(attr), ctypes.c_size_t(8), ctypes.c_uint32(0))
    if rs < 0:
        log.warning("Landlock: create_ruleset failed (errno %d); NOT enforced", e)
        return False
    try:
        for rp in grants:
            fd = os.open(rp, os.O_PATH)
            try:
                pb = _PathBeneath(_FS_EXECUTE, fd)
                r, e = sc(add_rule, ctypes.c_int(rs), ctypes.c_int(_RULE_PATH_BENEATH), ctypes.byref(pb), ctypes.c_uint32(0))
            finally:
                os.close(fd)
            if r != 0:
                log.warning("Landlock: add_rule(%s) failed (errno %d); NOT enforced", rp, e)
                return False
        if libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            log.warning("Landlock: PR_SET_NO_NEW_PRIVS failed; NOT enforced")
            return False
        r, e = sc(restrict_self, ctypes.c_int(rs), ctypes.c_uint32(0))
        if r != 0:
            log.warning("Landlock: restrict_self failed (errno %d); NOT enforced", e)
            return False
    finally:
        os.close(rs)
    log.info("Landlock: execute confined to %d pinned path(s) + interpreter", len(paths))
    return True
