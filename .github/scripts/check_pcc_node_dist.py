#!/usr/bin/env python3
"""Refuse to publish a pcc-node build that brings back what 0.1.1 removed.

.github/workflows/pypi-publish.yml runs this after `python -m build` and
before anything leaves the build job. It lists every file in the wheel and
the sdist, and exits 1 if:

- dist/ is not exactly one pcc-node wheel and one sdist, both for the
  version that the tag (pcc-node-v<version>) names;
- either artifact contains pcc_node/executor.py, the relay executor that
  ran tool-call commands through a shell (N66). Compiled bytecode is refused
  too, because it can carry a deleted module;
- any module of the pcc_node package passes shell=True;
- either artifact carries key material: a pcc-keys.json, a .pem, .key,
  .p12 or .pfx file, or a PEM private-key block. Only the file name is
  printed, never the content;
- the wheel holds anything outside pcc_node/ and its .dist-info, or the
  sdist holds a link or a special file;
- a member name is not a plain relative path (absolute, a backslash, an
  empty, "." or ".." part), appears twice, or is a ZIP symlink or special
  file;
- a member is too large to check (over 5 MiB): it is refused, not skipped.
Member names are printed escaped, so a name cannot add log lines.

Standard library only, so the check runs before any downloaded code can
influence it. Usage: check_pcc_node_dist.py --tag pcc-node-v0.1.1 DIST_DIR
"""

import argparse
import email.parser
import pathlib
import re
import stat
import sys
import tarfile
import zipfile

TAG = re.compile(r"pcc-node-v(?P<version>[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?)")
WHEEL = re.compile(r"pcc_node-(?P<version>[^-]+)-py3-none-any\.whl")
SDIST = re.compile(r"pcc_node-(?P<version>.+)\.tar\.gz")
SHELL_TRUE = re.compile(r"shell\s*=\s*True")
KEY_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
PEM_PRIVATE_KEY = re.compile(rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
MAX_SCAN_BYTES = 5 * 1024 * 1024


def shown(text):
    """Text as printed: escaped, so an archive member's name cannot add lines,
    workflow commands or terminal controls to the log (verdict 93, finding 6)."""
    return ascii(text)[1:-1]


def path_problem(name):
    """Why an archive member's name is not a plain relative path, or None
    (verdict 93, finding 4): the scope checks compare names, so a name must
    mean what it says."""
    parts = name[:-1].split("/") if name.endswith("/") else name.split("/")
    if name.startswith("/") or "\\" in name or any(part in ("", ".", "..") for part in parts):
        return "not a plain relative path"
    return None


def member_problems(rel, size, read):
    """Problems with one archive member. rel is its path inside the project
    ("pcc_node/cli.py"). read() returns its bytes. Content is never echoed.
    A member too large to read in full is refused, never passed unread
    (verdict 93, finding 3)."""
    problems = []
    name = rel.rsplit("/", 1)[-1]
    if rel == "pcc_node/executor.py":
        problems.append(f"{rel}: the relay shell executor removed in 0.1.1 (N66) is back")
    if name.endswith((".pyc", ".pyo")) or "__pycache__/" in rel:
        problems.append(f"{rel}: compiled bytecode, which can carry a deleted module")
    if name == "pcc-keys.json" or name.endswith(KEY_SUFFIXES):
        problems.append(f"{rel}: a key file by name (content not shown)")
    if size > MAX_SCAN_BYTES:
        problems.append(f"{rel}: too large to check ({size} bytes; the limit is {MAX_SCAN_BYTES})")
        return problems
    data = read()
    if PEM_PRIVATE_KEY.search(data):
        problems.append(f"{rel}: holds a PEM private-key block (content not shown)")
    if rel.startswith("pcc_node/") and name.endswith(".py"):
        text = data.decode("utf-8", errors="replace")
        for match in SHELL_TRUE.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            problems.append(f"{rel}:{line}: shell=True in the package code")
    return problems


def check_wheel(path, version):
    problems = []
    with zipfile.ZipFile(path) as wheel:
        infos = wheel.infolist()
        print(f"== wheel {path.name}: {len(infos)} files")
        dist_info = f"pcc_node-{version}.dist-info/"
        for info in infos:
            print(f"   {info.file_size:>8}  {shown(info.filename)}")
        seen = set()
        for info in infos:
            rel = info.filename
            if rel in seen:
                problems.append(f"wheel {rel}: appears more than once")
            seen.add(rel)
            bad_path = path_problem(rel)
            if bad_path:
                problems.append(f"wheel {rel}: {bad_path}")
                continue
            if info.is_dir():
                continue
            mode = info.external_attr >> 16
            if stat.S_IFMT(mode) and not stat.S_ISREG(mode):
                problems.append(f"wheel {rel}: a link or special file")
                continue
            if not (rel.startswith("pcc_node/") or rel.startswith(dist_info)):
                problems.append(f"{rel}: outside pcc_node/ and {dist_info}")

            problems += [f"wheel {p}" for p in member_problems(rel, info.file_size, lambda info=info: wheel.read(info))]
        try:
            metadata = wheel.read(dist_info + "METADATA").decode("utf-8")
        except KeyError:
            return problems + [f"wheel: no {dist_info}METADATA"]
    fields = email.parser.Parser().parsestr(metadata)
    if fields.get("Name") != "pcc-node" or fields.get("Version") != version:
        problems.append(f"wheel METADATA names {fields.get('Name')} {fields.get('Version')}, not pcc-node {version}")
    return problems


def check_sdist(path, version):
    problems = []
    top = f"pcc_node-{version}/"
    with tarfile.open(path, "r:gz") as sdist:
        members = sdist.getmembers()
        print(f"== sdist {path.name}: {len(members)} entries")
        for member in members:
            print(f"   {member.size:>8}  {shown(member.name)}")
        pkg_info = None
        seen = set()
        for member in members:
            if member.name in seen:
                problems.append(f"sdist {member.name}: appears more than once")
            seen.add(member.name)
            bad_path = path_problem(member.name)
            if bad_path:
                problems.append(f"sdist {member.name}: {bad_path}")
                continue
            if member.isdir():
                continue
            if not member.isfile():
                problems.append(f"sdist {member.name}: a link or special file")
                continue
            if not member.name.startswith(top):
                problems.append(f"sdist {member.name}: outside {top}")
                continue
            rel = member.name[len(top):]
            problems += [f"sdist {p}" for p in member_problems(rel, member.size,
                                                              lambda member=member: sdist.extractfile(member).read())]
            if rel == "PKG-INFO":
                pkg_info = sdist.extractfile(member).read().decode("utf-8")
    if pkg_info is None:
        return problems + [f"sdist: no {top}PKG-INFO"]
    fields = email.parser.Parser().parsestr(pkg_info)
    if fields.get("Name") != "pcc-node" or fields.get("Version") != version:
        problems.append(f"sdist PKG-INFO names {fields.get('Name')} {fields.get('Version')}, not pcc-node {version}")
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tag", required=True, help="the pushed tag, e.g. pcc-node-v0.1.1")
    parser.add_argument("dist", type=pathlib.Path)
    args = parser.parse_args(argv)

    tag = TAG.fullmatch(args.tag)
    if not tag:
        print(f"REFUSED: tag {args.tag!r} is not pcc-node-v<version>")
        return 1
    version = tag.group("version")

    files = sorted(p for p in args.dist.iterdir())
    wheels = [p for p in files if WHEEL.fullmatch(p.name)]
    sdists = [p for p in files if SDIST.fullmatch(p.name)]
    problems = [f"{p.name}: unexpected file in {args.dist}" for p in files if p not in wheels + sdists]
    if len(wheels) != 1 or len(sdists) != 1:
        problems.append(f"expected one wheel and one sdist, found {len(wheels)} and {len(sdists)}")
    for path, pattern in [(p, WHEEL) for p in wheels] + [(p, SDIST) for p in sdists]:
        found = pattern.fullmatch(path.name).group("version")
        if found != version:
            problems.append(f"{path.name}: version {found}, but the tag says {version}")
    if not problems:
        problems += check_wheel(wheels[0], version)
        problems += check_sdist(sdists[0], version)

    if problems:
        print(f"REFUSED: {len(problems)} problem(s) in the pcc-node {version} build:")
        for problem in problems:
            print(f"  - {shown(problem)}")
        return 1
    print(f"OK: pcc-node {version}: one wheel and one sdist; no executor.py, bytecode, shell=True or key material")
    return 0


if __name__ == "__main__":
    sys.exit(main())
