"""Pin key-store environment, ownership and competing-publication checks."""

import json
import os

import pytest

from pcc_node import crypto
from .test_crypto import (
    BY_ARGUMENT_OR_ENV,
    _e17b_checked_test_namespace,
    _e17b_directory_metadata,
    _loader,
    _private_dir,
    needs_nacl,
)

pytestmark = pytest.mark.usefixtures("_e17b_checked_test_namespace")


@pytest.fixture(autouse=True)
def _no_key_path_override(monkeypatch):
    monkeypatch.delenv("PCC_NODE_KEY_PATH", raising=False)
    monkeypatch.delenv("PCC_NODE_KEYS_FILE", raising=False)


class TestKeyPathEnvironmentPrecedence:
    def test_key_path_wins_when_both_environment_overrides_are_set(self, monkeypatch, tmp_path):
        preferred = tmp_path / "preferred" / "keys.json"
        fallback = tmp_path / "fallback" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEY_PATH", str(preferred))
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(fallback))
        assert crypto.default_key_path() == str(preferred)

    @needs_nacl
    def test_default_load_creates_only_the_preferred_environment_key(self, monkeypatch, tmp_path):
        preferred = tmp_path / "preferred" / "keys.json"
        fallback = tmp_path / "fallback" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEY_PATH", str(preferred))
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(fallback))
        created = crypto.load_or_create_keys(None)
        assert preferred.is_file()
        assert not fallback.parent.exists()
        reloaded_the_preferred_key = crypto.load_or_create_keys(str(preferred)) == created
        assert reloaded_the_preferred_key


@needs_nacl
class TestKeyDirectoryOwnership:
    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_a_root_owned_key_directory_is_refused(self, monkeypatch, tmp_path, existing):
        directory = _private_dir(tmp_path / "root-owned")
        path = directory / "keys.json"
        if existing:
            crypto.load_or_create_keys(str(path))
        inspected = _e17b_directory_metadata(monkeypatch, directory, owner=0, mode=0o700)
        if os.geteuid() == 0:
            # Keep the assertion meaningful when the suite itself runs as root.
            monkeypatch.setattr(crypto.os, "geteuid", lambda: 10001)
        with pytest.raises(crypto.KeyFileError, match="not owned by this user") as refused:
            crypto.load_or_create_keys(str(path))
        assert str(directory) in str(refused.value)
        assert inspected, "the key directory's open descriptor was not inspected"
        assert path.exists() == existing


@needs_nacl
class TestKeyLocationEnvironmentRoutes:
    @BY_ARGUMENT_OR_ENV
    def test_a_file_alias_inside_a_checkout_is_refused(self, monkeypatch, tmp_path, via_env):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        crypto.load_or_create_keys(str(path))
        before = path.stat()
        checkout = _private_dir(tmp_path / "checkout")
        (checkout / ".git").mkdir()
        alias = checkout / "mounted-key.json"
        alias.write_text("synthetic mount point, no key material")
        directory_metadata = checkout.stat()
        real_stat, real_fstat = os.stat, os.fstat
        checked = []

        def stat_with_file_alias(name, *, dir_fd=None, follow_symlinks=True):
            if name == alias.name and dir_fd is not None:
                held = real_fstat(dir_fd)
                if (held.st_dev, held.st_ino) == (
                    directory_metadata.st_dev, directory_metadata.st_ino
                ):
                    checked.append(True)
                    return before  # a file bind mount adds a name without a hard link
            return real_stat(name, dir_fd=dir_fd, follow_symlinks=follow_symlinks)

        ordinary = crypto._mountinfo()[0]
        mounted_file = dict(ordinary, id="file-alias", root=str(path), mountpoint=str(alias))
        monkeypatch.setattr(crypto.os, "stat", stat_with_file_alias)
        monkeypatch.setattr(crypto, "_mountinfo", lambda: [ordinary, mounted_file])
        load = _loader(monkeypatch, path, via_env)
        with pytest.raises(crypto.KeyFileError, match="inside a source checkout"):
            load()
        assert checked, "the mounted file's alias was not inspected"
        after = path.stat()
        assert (after.st_dev, after.st_ino, after.st_size, after.st_nlink) == (
            before.st_dev, before.st_ino, before.st_size, 1
        )


@needs_nacl
class TestRefusedCompetingKeyPublication:
    @pytest.mark.parametrize("kind", ["mismatched", "denylisted", "checkout"])
    def test_a_refused_winner_is_checked_and_left_in_place(self, monkeypatch, tmp_path, kind):
        directory = _private_dir(tmp_path / "keys")
        path = directory / "keys.json"
        winner = crypto.generate_node_keys()
        if kind == "mismatched":
            winner = (winner[0], crypto.generate_node_keys()[1])
            error = crypto.KeyFileError
            message = "does not belong to its secret"
        elif kind == "denylisted":
            monkeypatch.setattr(crypto, "COMPROMISED_PUBLIC_KEYS", frozenset({winner[0]}))
            error = crypto.CompromisedKeyError
            message = "secret was published"
        else:
            error = crypto.KeyFileError
            message = "inside a source checkout"
        real_link, real_open, real_dump = os.link, os.open, json.dump
        published = []

        def publish_first(src, dst, *, src_dir_fd=None, dst_dir_fd=None, follow_symlinks=True):
            assert dst == path.name
            assert src_dir_fd is not None and dst_dir_fd is not None
            assert not published, "the competing publisher should run exactly once"
            fd = real_open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                           0o600, dir_fd=dst_dir_fd)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                real_dump({"public": winner[0], "secret": winner[1]}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            published.append(path.stat())
            if kind == "checkout":
                os.mkdir(".git", mode=0o700, dir_fd=dst_dir_fd)
            return real_link(src, dst, src_dir_fd=src_dir_fd,
                             dst_dir_fd=dst_dir_fd, follow_symlinks=follow_symlinks)

        monkeypatch.setattr(crypto.os, "link", publish_first)
        with pytest.raises(error, match=message):
            crypto.load_or_create_keys(str(path))
        assert len(published) == 1, "the exclusive-publication race was not exercised"
        retained = path.stat()
        assert (retained.st_dev, retained.st_ino, retained.st_size) == (
            published[0].st_dev, published[0].st_ino, published[0].st_size
        ), "the losing creator changed the winner's file"
        assert retained.st_nlink == 1
        expected = [".git", "keys.json"] if kind == "checkout" else ["keys.json"]
        assert sorted(os.listdir(directory)) == expected, "the losing temporary key survived"
