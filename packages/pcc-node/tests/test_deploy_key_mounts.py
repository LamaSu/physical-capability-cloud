"""Check the unit's plain key directory and a systemd-style key directory bind."""

import os
import sys

import pytest

from pcc_node import crypto
from .test_crypto import _e17b_checked_test_namespace, _private_dir  # noqa: F401

pytestmark = [
    pytest.mark.usefixtures("_e17b_checked_test_namespace"),
    pytest.mark.skipif(not sys.platform.startswith("linux"),
                       reason="the key store's mount checks are Linux only"),
]


def _mount_record(mount_id, devno, root, mountpoint, fstype="ext4", source="/dev/test-root"):
    return {
        "id": mount_id,
        "devno": devno,
        "root": root,
        "mountpoint": mountpoint,
        "fstype": fstype,
        "source": source,
        "super": "rw",
    }


def _unit_mounts(base, bind_key_directory=False):
    records = [_mount_record("unit-root", "259:2", "/", "/")]
    for name in ("usr", "etc"):
        path = str(base / name)
        records.append(_mount_record("unit-" + name, "259:2", path, path))
    records.append(_mount_record("unit-boot", "259:1", "/", str(base / "boot"),
                                 fstype="vfat", source="/dev/test-boot"))
    for name in ("tmp", "var/tmp"):
        path = base / name
        private = path / "systemd-private-t-pcc-node.service-t" / "tmp"
        records.append(_mount_record("unit-" + name.replace("/", "-"), "259:2",
                                     str(private), str(path)))
    if bind_key_directory:
        path = str(base / "var" / "lib" / "pcc-node")
        records.append(_mount_record("unit-key-directory", "259:2", path, path))
    return records


def _model_mount_lookup(monkeypatch, records):
    paths = []

    def mount_of(fd):
        path = os.readlink("/proc/self/fd/%d" % fd)
        paths.append(path)
        matches = [record for record in records
                   if record["mountpoint"] == "/" or path == record["mountpoint"]
                   or path.startswith(record["mountpoint"].rstrip("/") + "/")]
        return max(matches, key=lambda record: len(record["mountpoint"]))

    monkeypatch.setattr(crypto, "_mount_of", mount_of)
    monkeypatch.setattr(crypto, "_mountinfo", lambda: list(records))
    return paths


def test_unit_layout_key_directory_is_accepted(tmp_path, monkeypatch):
    base = _private_dir(tmp_path / "host")
    var = _private_dir(base / "var")
    lib = _private_dir(var / "lib")
    key_directory = _private_dir(lib / "pcc-node")
    paths = _model_mount_lookup(monkeypatch, _unit_mounts(base))
    fd = os.open(key_directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        crypto._refuse_checkout(fd, str(key_directory / "keys.json"))
    finally:
        os.close(fd)
    assert "/" in paths
    assert str(key_directory) in paths


def test_state_directory_self_bind_is_refused(tmp_path, monkeypatch):
    base = _private_dir(tmp_path / "host")
    var = _private_dir(base / "var")
    lib = _private_dir(var / "lib")
    key_directory = _private_dir(lib / "pcc-node")
    _model_mount_lookup(monkeypatch, _unit_mounts(base, bind_key_directory=True))
    fd = os.open(key_directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with pytest.raises(crypto.KeyFileError, match="reached through a bind mount of a subtree"):
            crypto._refuse_checkout(fd, str(key_directory / "keys.json"))
    finally:
        os.close(fd)
