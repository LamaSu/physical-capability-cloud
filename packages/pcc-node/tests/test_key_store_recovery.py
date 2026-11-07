"""Interrupted and concurrent key publication, without inspecting key bytes."""

import errno
import json
import os
import stat

import pytest

from pcc_node import crypto
from .test_crypto import _private_dir, needs_nacl


@pytest.fixture(autouse=True)
def _no_key_path_override(monkeypatch):
    monkeypatch.delenv("PCC_NODE_KEY_PATH", raising=False)
    monkeypatch.delenv("PCC_NODE_KEYS_FILE", raising=False)


def _residue(path, pid="123", token="abcdef12"):
    return path.with_name(".%s.%s.%s.tmp" % (path.name, pid, token))


@needs_nacl
class TestTemporaryKeyLinkRecovery:
    def test_a_crash_residue_is_removed_without_changing_the_identity_or_inode(
        self, monkeypatch, tmp_path, caplog
    ):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        pair = crypto.load_or_create_keys(str(path))
        before = path.stat()
        residue = _residue(path)
        os.link(path, residue)
        real_listdir, real_sync = os.listdir, crypto._fsync_dir
        listed, synced = [], []

        def listdir(directory):
            assert isinstance(directory, int), "recovery must list the verified descriptor"
            listed.append(directory)
            return real_listdir(directory)

        def sync(directory):
            synced.append(directory)
            return real_sync(directory)

        monkeypatch.setattr(crypto.os, "listdir", listdir)
        monkeypatch.setattr(crypto, "_fsync_dir", sync)
        same_pair = crypto.load_or_create_keys(str(path)) == pair
        assert same_pair
        assert not residue.exists()
        after = path.stat()
        assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
            before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns
        )
        assert after.st_nlink == 1
        assert listed and synced and set(listed) == set(synced)
        warnings = [record.getMessage() for record in caplog.records]
        assert warnings == ["removed interrupted key publication temporary name " + residue.name]

    @pytest.mark.parametrize("other_name", [
        "keys.json.bak", ".keys.json.tmp", ".keys.json.123.ABCDEF12.tmp",
        ".keys.json.12x.abcdef12.tmp", "sub/.keys.json.123.abcdef12.tmp",
        ".keysXjson.123.abcdef12.tmp", ".keys.json.123.abcdef12.tmp.extra",
        ".keys.json.123.abcdef12.tmp\n",
    ])
    def test_a_nonmatching_same_inode_name_is_refused_and_left_in_place(self, tmp_path, other_name):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        crypto.load_or_create_keys(str(path))
        other = path.parent / other_name
        _private_dir(other.parent)
        os.link(path, other)
        before = path.stat()
        with pytest.raises(crypto.KeyFileError, match="has 2 hard links") as refused:
            crypto.load_or_create_keys(str(path))
        assert "Temporary publication names" not in str(refused.value)
        assert other.stat().st_ino == before.st_ino
        assert path.stat().st_nlink == 2

    @pytest.mark.parametrize("symlink", [False, True], ids=["different-inode", "symlink"])
    def test_a_matching_name_that_is_not_the_open_regular_inode_is_untouched(self, tmp_path, symlink):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        pair = crypto.load_or_create_keys(str(path))
        residue = _residue(path)
        os.link(path, residue)
        decoy = _residue(path, token="1234abcd")
        if symlink:
            decoy.symlink_to(path)
        else:
            decoy.write_text("not a key")
        before = decoy.lstat()
        same_pair = crypto.load_or_create_keys(str(path)) == pair
        assert same_pair
        assert not residue.exists()
        after = decoy.lstat()
        assert (after.st_ino, after.st_size, after.st_mode) == (before.st_ino, before.st_size, before.st_mode)
        assert path.stat().st_nlink == 1

    def test_a_link_elsewhere_is_left_and_still_refused_after_removing_the_residue(self, tmp_path):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        crypto.load_or_create_keys(str(path))
        elsewhere = _private_dir(tmp_path / "checkout") / "other.json"
        os.link(path, elsewhere)
        residue = _residue(path)
        os.link(path, residue)
        before = elsewhere.stat()
        with pytest.raises(crypto.KeyFileError, match="has 2 hard links"):
            crypto.load_or_create_keys(str(path))
        assert not residue.exists()
        assert (elsewhere.stat().st_ino, elsewhere.stat().st_size) == (before.st_ino, before.st_size)
        assert path.stat().st_nlink == 2

    def test_a_concurrent_loader_recovers_before_the_creator_unlinks_its_temporary_name(
        self, monkeypatch, tmp_path
    ):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        real_unlink = os.unlink
        loading = []
        recovered = []
        missing = []

        def unlink(name, *, dir_fd=None):
            if not loading:
                assert name.startswith(".keys.json.") and name.endswith(".tmp")
                assert path.stat().st_nlink == 2, "the winner must already be published"
                loading.append(True)
                recovered.append(crypto.load_or_create_keys(str(path)))
            try:
                return real_unlink(name, dir_fd=dir_fd)
            except FileNotFoundError:
                missing.append(name)
                raise

        def scrub(*args, **kwargs):
            pytest.fail("a creator whose temporary name was recovered must not scrub the identity")

        monkeypatch.setattr(crypto.os, "unlink", unlink)
        monkeypatch.setattr(crypto, "_scrub_and_remove", scrub)
        pair = crypto.load_or_create_keys(str(path))
        same_pair = len(recovered) == 1 and pair == recovered[0]
        assert same_pair
        assert len(missing) == 1, "the creator did not encounter the recovered temporary name"
        assert path.stat().st_nlink == 1 and path.stat().st_size > 0
        assert os.listdir(path.parent) == [path.name]

    def test_every_unremovable_residue_is_named_with_its_errno(self, monkeypatch, tmp_path):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        crypto.load_or_create_keys(str(path))
        residues = [_residue(path), _residue(path, token="1234abcd")]
        for residue in residues:
            os.link(path, residue)
        real_unlink = os.unlink

        def unlink(name, *, dir_fd=None):
            if name in {residue.name for residue in residues}:
                raise PermissionError(errno.EACCES, "residue removal refused", name)
            return real_unlink(name, dir_fd=dir_fd)

        monkeypatch.setattr(crypto.os, "unlink", unlink)
        with pytest.raises(crypto.KeyFileError, match="has 3 hard links") as refused:
            crypto.load_or_create_keys(str(path))
        for residue in residues:
            assert str(residue) in str(refused.value)
            assert residue.stat().st_ino == path.stat().st_ino
        assert str(refused.value).count("errno 13, EACCES") == 2

    @pytest.mark.parametrize("foreign", [False, True], ids=["mode-0644", "foreign-owner"])
    def test_exposure_is_marked_and_refused_before_any_residue_is_removed(self, monkeypatch, tmp_path, foreign):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        crypto.load_or_create_keys(str(path))
        residue = _residue(path)
        os.link(path, residue)
        if foreign:
            real_fstat = os.fstat
            key_inode = path.stat().st_ino

            def fstat(fd):
                result = real_fstat(fd)
                if result.st_ino == key_inode and stat.S_ISREG(result.st_mode):
                    values = list(result)
                    values[4] = os.geteuid() + 1
                    return os.stat_result(values)
                return result

            monkeypatch.setattr(crypto.os, "fstat", fstat)
        else:
            path.chmod(0o644)
        with pytest.raises(crypto.KeyFileError, match="exposure marker|identity is compromised"):
            crypto.load_or_create_keys(str(path))
        assert residue.exists() and path.stat().st_nlink == 2
        assert path.with_name("keys.json.exposed").exists()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    def test_without_descriptor_directory_listing_the_residue_is_left_and_refused(self, monkeypatch, tmp_path):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        crypto.load_or_create_keys(str(path))
        residue = _residue(path)
        os.link(path, residue)
        monkeypatch.setattr(crypto.os, "supports_fd", {
            call for call in os.supports_fd if call.__name__ not in {"listdir", "scandir"}
        })
        with pytest.raises(crypto.KeyFileError, match="has 2 hard links"):
            crypto.load_or_create_keys(str(path))
        assert residue.exists() and path.stat().st_nlink == 2

    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_a_residue_that_appears_before_the_terminal_check_is_recovered(self, monkeypatch, tmp_path, existing):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        if existing:
            crypto.load_or_create_keys(str(path))
        real_terminal = crypto._check_key_location
        appeared = []

        def terminal(dir_fd, fd, key_path):
            os.link(path.name, _residue(path).name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            appeared.append(True)
            return real_terminal(dir_fd, fd, key_path)

        monkeypatch.setattr(crypto, "_check_key_location", terminal)
        crypto.load_or_create_keys(str(path))
        assert appeared == [True]
        assert path.stat().st_nlink == 1
        assert os.listdir(path.parent) == [path.name]

    def test_the_temporary_pattern_escapes_the_final_file_name(self, tmp_path):
        path = _private_dir(tmp_path / "keys") / "keys+[1].json"
        pair = crypto.load_or_create_keys(str(path))
        residue = _residue(path)
        os.link(path, residue)
        same_pair = crypto.load_or_create_keys(str(path)) == pair
        assert same_pair and not residue.exists()
        assert path.stat().st_nlink == 1


@needs_nacl
class TestTemporaryKeyCleanupMessages:
    @pytest.mark.parametrize("unlink_fails", [False, True], ids=["removed-name", "retained-name"])
    def test_a_failed_scrub_names_the_temporary_path_being_cleaned(self, monkeypatch, tmp_path, unlink_fails):
        path = _private_dir(tmp_path / "keys") / "keys.json"
        temporary = _residue(path)
        fd = os.open(str(temporary), os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        pair = crypto.generate_node_keys()
        os.write(fd, json.dumps({"public": pair[0], "secret": pair[1]}).encode("utf-8"))
        real_unlink = os.unlink

        def refuse(*args, **kwargs):
            raise PermissionError(errno.EACCES, "cleanup refused for test")

        def unlink(name, *, dir_fd=None):
            if unlink_fails:
                refuse()
            return real_unlink(name, dir_fd=dir_fd)

        directory_fd = os.open(str(path.parent), crypto._directory_flags())
        try:
            monkeypatch.setattr(crypto.os, "ftruncate", refuse)
            monkeypatch.setattr(crypto.os, "pwrite", refuse)
            monkeypatch.setattr(crypto.os, "unlink", unlink)
            with pytest.raises(crypto.KeyFileError, match="THE SECRET MAY REMAIN") as refused:
                crypto._scrub_and_remove(directory_fd, temporary.name, fd, str(path), str(temporary), None)
            message = str(refused.value)
            assert message.startswith(str(path) + " was refused")
            if unlink_fails:
                assert "in %s. Delete %s by hand" % (temporary, temporary) in message
            else:
                assert "through another name of " + str(temporary) in message
        finally:
            os.close(fd)
            os.close(directory_fd)
