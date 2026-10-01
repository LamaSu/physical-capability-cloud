"""Tests for cryptographic utilities."""

import json
import os

import pytest

from pcc_node.crypto import (
    generate_node_keys,
    sign_announcement,
    verify_signature,
    load_or_create_keys,
    _HAS_NACL,
)

# The crypto CI job sets PCC_REQUIRE_PYNACL=1 and installs PyNaCl, so there a
# missing PyNaCl FAILS this file instead of skipping the Ed25519 tests.
if os.environ.get("PCC_REQUIRE_PYNACL") == "1" and not _HAS_NACL:
    raise RuntimeError("PCC_REQUIRE_PYNACL=1 but PyNaCl is not importable")

needs_nacl = pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")


@pytest.fixture(autouse=True)
def _no_key_path_override(monkeypatch):
    """A developer's PCC_NODE_KEY_PATH must not steer these tests."""
    monkeypatch.delenv("PCC_NODE_KEY_PATH", raising=False)


@needs_nacl
class TestGenerateNodeKeys:
    def test_returns_hex_strings(self):
        pub, sec = generate_node_keys()
        assert isinstance(pub, str)
        assert isinstance(sec, str)
        # Should be valid hex
        bytes.fromhex(pub)
        bytes.fromhex(sec)

    def test_keys_are_32_bytes(self):
        pub, sec = generate_node_keys()
        assert len(bytes.fromhex(pub)) == 32
        assert len(bytes.fromhex(sec)) == 32

    def test_different_each_time(self):
        pub1, sec1 = generate_node_keys()
        pub2, sec2 = generate_node_keys()
        assert pub1 != pub2
        assert sec1 != sec2


@needs_nacl
class TestSignAnnouncement:
    def test_produces_hex_signature(self):
        _pub, sec = generate_node_keys()
        announcement = {"kernelId": "k1", "capabilities": ["liquid-handler"]}
        sig = sign_announcement(announcement, sec)
        assert isinstance(sig, str)
        bytes.fromhex(sig)  # valid hex

    def test_deterministic(self):
        """Same input + same key = same signature."""
        _pub, sec = generate_node_keys()
        announcement = {"kernelId": "k1", "capabilities": ["x"]}
        sig1 = sign_announcement(announcement, sec)
        sig2 = sign_announcement(announcement, sec)
        assert sig1 == sig2

    def test_different_payload_different_sig(self):
        _pub, sec = generate_node_keys()
        sig1 = sign_announcement({"a": 1}, sec)
        sig2 = sign_announcement({"a": 2}, sec)
        assert sig1 != sig2

    def test_canonical_json_order(self):
        """Key order in the dict should not matter (canonical JSON)."""
        _pub, sec = generate_node_keys()
        sig1 = sign_announcement({"b": 2, "a": 1}, sec)
        sig2 = sign_announcement({"a": 1, "b": 2}, sec)
        assert sig1 == sig2


class TestVerifySignature:
    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")
    def test_valid_signature(self):
        pub, sec = generate_node_keys()
        announcement = {"test": "data"}
        sig = sign_announcement(announcement, sec)
        assert verify_signature(announcement, sig, pub) is True

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")
    def test_invalid_signature(self):
        pub, sec = generate_node_keys()
        announcement = {"test": "data"}
        sig = sign_announcement(announcement, sec)
        # Tamper with signature
        bad_sig = "00" * len(bytes.fromhex(sig))
        assert verify_signature(announcement, bad_sig, pub) is False

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")
    def test_wrong_key(self):
        pub1, sec1 = generate_node_keys()
        pub2, sec2 = generate_node_keys()
        announcement = {"test": "data"}
        sig = sign_announcement(announcement, sec1)
        assert verify_signature(announcement, sig, pub2) is False


@needs_nacl
class TestLoadOrCreateKeys:
    def test_creates_new_keys(self, tmp_path):
        path = str(tmp_path / "keys.json")
        pub, sec = load_or_create_keys(path)
        assert os.path.exists(path)
        assert len(bytes.fromhex(pub)) == 32

    def test_loads_existing_keys(self, tmp_path):
        path = str(tmp_path / "keys.json")
        pub1, sec1 = load_or_create_keys(path)
        pub2, sec2 = load_or_create_keys(path)
        assert pub1 == pub2
        assert sec1 == sec2

    def test_key_file_is_valid_json(self, tmp_path):
        path = str(tmp_path / "keys.json")
        load_or_create_keys(path)
        with open(path) as f:
            data = json.load(f)
        assert "public" in data
        assert "secret" in data


# ---------------------------------------------------------------------------
# N35b: verification fails closed; a key file inside a checkout is refused when it is loaded or created
# ---------------------------------------------------------------------------

import errno  # noqa: E402
import hashlib  # noqa: E402
import re  # noqa: E402
import stat  # noqa: E402
from pathlib import Path  # noqa: E402

from pcc_node import crypto as crypto_module  # noqa: E402


class TestVerifyFailsClosed:
    def test_without_pynacl_no_signature_verifies(self, monkeypatch):
        # This used to return True as a "dev-mode pass-through".
        monkeypatch.setattr(crypto_module, "_HAS_NACL", False)
        assert verify_signature({"a": 1}, "00" * 64, "11" * 32) is False

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")
    def test_a_compromised_key_never_verifies(self, monkeypatch):
        pub, sec = generate_node_keys()
        sig = sign_announcement({"a": 1}, sec)
        assert verify_signature({"a": 1}, sig, pub) is True
        monkeypatch.setattr(crypto_module, "COMPROMISED_PUBLIC_KEYS", frozenset({pub}))
        assert verify_signature({"a": 1}, sig, pub) is False
        assert verify_signature({"a": 1}, sig, pub.upper()) is False

    def test_the_committed_key_is_on_the_denylist(self):
        # The entry itself, by the sha256 of its hex text (the key is public, but
        # pinning the fingerprint keeps the test from depending on a count).
        fingerprints = {hashlib.sha256(k.encode()).hexdigest()[:16] for k in crypto_module.COMPROMISED_PUBLIC_KEYS}
        assert "e3b726020a9bb4a5" in fingerprints
        for key in crypto_module.COMPROMISED_PUBLIC_KEYS:
            assert re.fullmatch("[0-9a-f]{64}", key)

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")
    def test_malformed_inputs_fail_closed_instead_of_raising(self):
        pub, sec = generate_node_keys()
        sig = sign_announcement({"a": 1}, sec)
        assert verify_signature({"a": 1}, "zz", pub) is False
        assert verify_signature({"a": 1}, sig, "zz") is False
        assert verify_signature({"a": 1}, sig, pub[:-2]) is False
        assert verify_signature({"a": 1}, sig, None) is False
        assert verify_signature({"a": object()}, sig, pub) is False


@needs_nacl
class TestKeyFileLocation:
    def test_default_path_is_under_home_not_the_checkout(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HOME", str(tmp_path))
        assert crypto_module.default_key_path() == str(tmp_path / ".pcc-node" / "keys.json")
        package_dir = Path(crypto_module.__file__).resolve().parents[1]
        assert not Path(crypto_module.default_key_path()).resolve().is_relative_to(package_dir)

    def test_default_load_never_reads_the_working_directory(self, monkeypatch, tmp_path):
        home = tmp_path / "home"
        cwd = tmp_path / "checkout"
        cwd.mkdir()
        # A key file where the old default ("./pcc-keys.json") would find it.
        (cwd / "pcc-keys.json").write_text(json.dumps({"public": "aa" * 32, "secret": "bb" * 32}))
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.chdir(cwd)
        pub, _ = load_or_create_keys()
        assert pub != "aa" * 32
        assert (home / ".pcc-node" / "keys.json").exists()

    def test_a_compromised_key_file_is_refused(self, monkeypatch, tmp_path):
        path = str(tmp_path / "keys.json")
        pub, _ = load_or_create_keys(path)
        monkeypatch.setattr(crypto_module, "COMPROMISED_PUBLIC_KEYS", frozenset({pub}))
        with pytest.raises(crypto_module.CompromisedKeyError):
            load_or_create_keys(path)


# ---------------------------------------------------------------------------
# N35b round 2: decoded-key denylist, signing and loading check the pair,
# strict hex, a dict-only schema, and key-file permissions and location.
# A fresh key stands in for the compromised one (its secret is never used).
# ---------------------------------------------------------------------------

def _write_key_file(path, public, secret, mode=0o600):
    path.write_text(json.dumps({"public": public, "secret": secret}))
    os.chmod(path, mode)
    return str(path)


class TestDenylistComparesDecodedKeys:
    @needs_nacl
    def test_no_spelling_of_a_denylisted_key_verifies(self, monkeypatch):
        pub, sec = generate_node_keys()
        sig = sign_announcement({"a": 1}, sec)
        monkeypatch.setattr(crypto_module, "COMPROMISED_PUBLIC_KEYS", frozenset({pub}))
        for spelling in (pub, pub.upper(), " " + pub, pub + " ", pub + "\n", "\t" + pub, pub[:32] + " " + pub[32:]):
            assert verify_signature({"a": 1}, sig, spelling) is False, repr(spelling)

    @needs_nacl
    def test_key_and_signature_hex_are_strict_for_every_key(self):
        pub, sec = generate_node_keys()
        sig = sign_announcement({"a": 1}, sec)
        assert verify_signature({"a": 1}, sig, pub) is True
        assert verify_signature({"a": 1}, sig.upper(), pub.upper()) is True
        for bad_pub in (" " + pub, pub + "\n", "0x" + pub):
            assert verify_signature({"a": 1}, sig, bad_pub) is False
        for bad_sig in (" " + sig, sig + " ", sig[:64] + " " + sig[64:]):
            assert verify_signature({"a": 1}, bad_sig, pub) is False


class TestSigningChecksTheKey:
    @needs_nacl
    def test_signing_with_a_denylisted_key_is_refused(self, monkeypatch):
        pub, sec = generate_node_keys()
        monkeypatch.setattr(crypto_module, "COMPROMISED_PUBLIC_KEYS", frozenset({pub}))
        with pytest.raises(crypto_module.CompromisedKeyError):
            sign_announcement({"a": 1}, sec)

    def test_only_a_dict_is_an_announcement(self):
        sec = "11" * 32  # input checks come before the PyNaCl requirement, so no real key is needed
        for not_a_dict in (None, [1], "a", 1):
            with pytest.raises(TypeError):
                sign_announcement(not_a_dict, sec)

    def test_values_json_cannot_hold_are_refused(self):
        sec = "11" * 32  # input checks come before the PyNaCl requirement, so no real key is needed
        with pytest.raises(ValueError):
            sign_announcement({"x": float("nan")}, sec)

    def test_a_malformed_secret_is_refused(self):
        sec = "11" * 32  # input checks come before the PyNaCl requirement, so no real key is needed
        with pytest.raises(ValueError):
            sign_announcement({"a": 1}, " " + sec)

    @needs_nacl
    def test_verification_never_raises(self):
        pub, sec = generate_node_keys()
        sig = sign_announcement({"a": 1}, sec)
        assert verify_signature(None, sig, pub) is False
        deep = []
        cursor = deep
        for _ in range(100000):
            cursor.append([])
            cursor = cursor[0]
        assert verify_signature({"deep": deep}, sig, pub) is False


class TestLoadingChecksThePair:
    @needs_nacl
    def test_a_benign_public_key_cannot_carry_a_compromised_secret(self, monkeypatch, tmp_path):
        bad_pub, bad_sec = generate_node_keys()
        good_pub, _ = generate_node_keys()
        path = _write_key_file(tmp_path / "keys.json", good_pub, bad_sec)
        monkeypatch.setattr(crypto_module, "COMPROMISED_PUBLIC_KEYS", frozenset({bad_pub}))
        with pytest.raises(crypto_module.CompromisedKeyError):
            load_or_create_keys(path)

    @needs_nacl
    def test_a_denylisted_key_spelled_in_uppercase_is_still_refused(self, monkeypatch, tmp_path):
        pub, sec = generate_node_keys()
        path = _write_key_file(tmp_path / "keys.json", pub, sec)
        monkeypatch.setattr(crypto_module, "COMPROMISED_PUBLIC_KEYS", frozenset({pub.upper()}))
        with pytest.raises(crypto_module.CompromisedKeyError):
            load_or_create_keys(path)

    @needs_nacl
    def test_a_public_key_that_does_not_belong_to_the_secret_is_refused(self, tmp_path):
        pub_a, _ = generate_node_keys()
        _, sec_b = generate_node_keys()
        path = _write_key_file(tmp_path / "keys.json", pub_a, sec_b)
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(path)

    @needs_nacl
    def test_keys_that_are_not_exact_hex_are_refused(self, tmp_path):
        pub, sec = generate_node_keys()
        for public, secret in ((" " + pub, sec), (pub, sec + "\n"), (pub, None)):
            path = _write_key_file(tmp_path / "keys.json", public, secret)
            with pytest.raises(crypto_module.KeyFileError):
                load_or_create_keys(path)


@needs_nacl
class TestKeyFilePermissionsAndPlace:
    def test_a_new_key_file_is_0600(self, tmp_path):
        path = tmp_path / "keys.json"
        load_or_create_keys(str(path))
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600

    def test_an_existing_key_file_readable_by_others_is_corrected(self, tmp_path):
        path = tmp_path / "keys.json"
        load_or_create_keys(str(path))
        os.chmod(path, 0o644)
        load_or_create_keys(str(path))
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600

    def test_no_key_file_is_created_inside_a_checkout(self, tmp_path):
        repo = tmp_path / "repo"
        (repo / ".git").mkdir(parents=True)
        target = repo / "packages" / "pcc-node" / "pcc-keys.json"
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(target))
        assert not target.exists()

    def test_a_repository_at_home_blocks_the_default_and_the_override_escapes_it(self, monkeypatch, tmp_path):
        # No home exemption (cross-family A02): a dotfiles repository at home
        # would publish ~/.pcc-node/keys.json with one `git add`.
        home = tmp_path / "home"
        (home / ".git").mkdir(parents=True)
        monkeypatch.setenv("HOME", str(home))
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys()
        assert not (home / ".pcc-node" / "keys.json").exists()
        outside = tmp_path / "keys-outside" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEY_PATH", str(outside))
        load_or_create_keys()
        assert outside.exists()

    def test_an_existing_key_inside_a_checkout_is_refused_before_it_is_read(self, tmp_path):
        made = tmp_path / "made" / "keys.json"
        load_or_create_keys(str(made))
        repo = tmp_path / "repo"
        (repo / ".git").mkdir(parents=True)
        inside = repo / "pcc-keys.json"
        inside.write_bytes(made.read_bytes())
        os.chmod(inside, 0o600)
        with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
            load_or_create_keys(str(inside))

    def test_a_key_file_that_is_a_symbolic_link_is_refused(self, tmp_path):
        real = tmp_path / "real" / "keys.json"
        load_or_create_keys(str(real))
        link_dir = tmp_path / "links"
        link_dir.mkdir(mode=0o700)
        link = link_dir / "keys.json"
        link.symlink_to(real)
        with pytest.raises(crypto_module.KeyFileError, match="symbolic link"):
            load_or_create_keys(str(link))

    def test_a_directory_link_into_a_checkout_is_refused(self, tmp_path):
        repo = tmp_path / "repo"
        (repo / ".git").mkdir(parents=True)
        (repo / "keys").mkdir(mode=0o700)
        alias = tmp_path / "alias"
        alias.symlink_to(repo / "keys", target_is_directory=True)
        with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
            load_or_create_keys(str(alias / "keys.json"))
        assert not (repo / "keys" / "keys.json").exists()

    @pytest.mark.skipif(os.name != "posix", reason="POSIX ownership and modes")
    def test_a_directory_others_can_write_is_refused(self, tmp_path):
        shared = tmp_path / "shared"
        shared.mkdir()
        os.chmod(shared, 0o777)
        with pytest.raises(crypto_module.KeyFileError, match="writable by other users"):
            load_or_create_keys(str(shared / "keys.json"))
        assert not (shared / "keys.json").exists()

    @pytest.mark.skipif(os.name != "posix", reason="POSIX ownership and modes")
    def test_a_directory_or_key_file_owned_by_another_user_is_refused(self, monkeypatch, tmp_path):
        path = tmp_path / "own" / "keys.json"
        load_or_create_keys(str(path))
        real_uid = os.getuid()
        monkeypatch.setattr(crypto_module.os, "getuid", lambda: real_uid + 1)
        with pytest.raises(crypto_module.KeyFileError, match="not owned by this user"):
            load_or_create_keys(str(path))
        monkeypatch.setattr(crypto_module, "_check_directory", lambda *args: None)
        with pytest.raises(crypto_module.KeyFileError, match="not owned by this user"):
            load_or_create_keys(str(path))


class TestWithoutPyNaClNoKeyIsUsed:
    """Cross-family A02: without PyNaCl the node cannot derive its Ed25519
    identity, so it may not create, load or sign with a key at all."""

    def test_no_key_is_created_loaded_or_used(self, monkeypatch, tmp_path):
        monkeypatch.setattr(crypto_module, "_HAS_NACL", False)
        with pytest.raises(crypto_module.CryptoUnavailableError):
            generate_node_keys()
        with pytest.raises(crypto_module.CryptoUnavailableError):
            load_or_create_keys(str(tmp_path / "new" / "keys.json"))
        assert not (tmp_path / "new" / "keys.json").exists()
        existing = _write_key_file(tmp_path / "keys.json", "aa" * 32, "bb" * 32)
        with pytest.raises(crypto_module.CryptoUnavailableError):
            load_or_create_keys(existing)
        with pytest.raises(crypto_module.CryptoUnavailableError):
            sign_announcement({"kernelId": "k"}, "bb" * 32)
        assert verify_signature({"kernelId": "k"}, "00" * 64, "aa" * 32) is False


# ---------------------------------------------------------------------------
# N35b round 4 (cross-family A02b, astra at 258166a5): the checkout check is
# decided from the very directory the key file is opened through, a hard link
# to a key in a checkout is refused, and a platform that cannot do either
# fails closed. Races are simulated with no timing: a hook runs at the exact
# point where a swap would hurt.
# ---------------------------------------------------------------------------

def _private_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _new_key_pair_file(path):
    """A valid, consistent key file at *path* (0600); returns (public, secret)."""
    public, secret = generate_node_keys()
    _write_key_file(path, public, secret)
    return public, secret


def _checkout_holding(tmp_path, *, key=False):
    """A work tree (``repo/.git``) with a private ``repo/keys`` directory, optionally holding a valid key."""
    held = _private_dir(tmp_path / "repo" / "keys")
    (tmp_path / "repo" / ".git").mkdir()
    pair = _new_key_pair_file(held / "keys.json") if key else None
    return held, pair


def _repoint_after_the_checkout_check(monkeypatch, alias, new_target):
    """The race, with no timing: the first time the checkout check returns, the
    directory link *alias* is re-pointed at *new_target*, so whatever the load
    does next sees the swapped link, as a real swap in that gap would."""
    check = crypto_module._refuse_checkout
    done = []

    def check_then_swap(*args, **kwargs):
        result = check(*args, **kwargs)
        if not done:
            done.append(True)
            alias.unlink()
            alias.symlink_to(new_target, target_is_directory=True)
        return result

    monkeypatch.setattr(crypto_module, "_refuse_checkout", check_then_swap)
    return done


def _open_descriptors():
    """How many of the low file descriptors are open right now."""
    count = 0
    for fd in range(512):
        try:
            os.fstat(fd)
        except OSError:
            continue
        count += 1
    return count


def _loader(monkeypatch, path, via_env):
    """``load_or_create_keys`` aimed at *path*, by argument or through PCC_NODE_KEY_PATH."""
    if via_env:
        monkeypatch.setenv("PCC_NODE_KEY_PATH", str(path))
        return load_or_create_keys
    return lambda: load_or_create_keys(str(path))


BY_ARGUMENT_OR_ENV = pytest.mark.parametrize("via_env", [False, True], ids=["path-argument", "PCC_NODE_KEY_PATH"])


@needs_nacl
class TestKeyLocationIsBoundToTheDirectoryOpened:
    """A02b F1: the check and the open must concern the same directory."""

    @BY_ARGUMENT_OR_ENV
    def test_a_directory_link_swapped_after_the_check_cannot_redirect_the_load(self, monkeypatch, tmp_path, via_env):
        safe = _private_dir(tmp_path / "safe")
        safe_pair = _new_key_pair_file(safe / "keys.json")
        held, checkout_pair = _checkout_holding(tmp_path, key=True)
        the_pairs_differ = safe_pair != checkout_pair
        assert the_pairs_differ
        alias = tmp_path / "alias"
        alias.symlink_to(safe, target_is_directory=True)
        swapped = _repoint_after_the_checkout_check(monkeypatch, alias, held)
        load = _loader(monkeypatch, alias / "keys.json", via_env)
        try:
            got = load()
        except crypto_module.KeyFileError:
            got = None  # refusing is correct too
        assert swapped, "the checkout check never ran, so no swap happened"
        # Booleans, so a failure never prints a secret into a log.
        accepted_the_checkout_key = got == checkout_pair
        assert not accepted_the_checkout_key, "the key file inside the checkout was accepted"
        used_the_directory_it_checked = got is None or got == safe_pair
        assert used_the_directory_it_checked

    @BY_ARGUMENT_OR_ENV
    def test_a_directory_link_swapped_after_the_check_cannot_redirect_a_new_key(self, monkeypatch, tmp_path, via_env):
        safe = _private_dir(tmp_path / "safe")
        held, _ = _checkout_holding(tmp_path)
        alias = tmp_path / "alias"
        alias.symlink_to(safe, target_is_directory=True)
        swapped = _repoint_after_the_checkout_check(monkeypatch, alias, held)
        load = _loader(monkeypatch, alias / "keys.json", via_env)
        try:
            load()
        except crypto_module.KeyFileError:
            pass  # refusing is correct too
        assert swapped, "the checkout check never ran, so no swap happened"
        assert os.listdir(held) == [], "a new secret was created inside the checkout"

    @BY_ARGUMENT_OR_ENV
    def test_no_key_file_is_opened_through_its_multi_component_pathname(self, monkeypatch, tmp_path, via_env):
        calls = []
        real_open = os.open

        def spy(path, flags, mode=0o777, *, dir_fd=None):
            calls.append((str(path), flags, dir_fd))
            return real_open(path, flags, mode, dir_fd=dir_fd)

        load = _loader(monkeypatch, tmp_path / "new" / "keys.json", via_env)
        monkeypatch.setattr(crypto_module.os, "open", spy)
        created = load()
        loaded = load()
        loaded_what_it_created = created == loaded
        assert loaded_what_it_created
        by_pathname = [c for c in calls if c[2] is None and not c[1] & os.O_DIRECTORY]
        assert by_pathname == [], "opened by pathname, not through a verified directory: %r" % by_pathname
        assert any(c[2] is not None for c in calls)

    @pytest.mark.parametrize("form", ["directory", "file", "dangling-symlink", "symlink-to-directory"])
    def test_a_git_entry_of_any_form_in_an_ancestor_counts_as_a_checkout(self, tmp_path, form):
        work = _private_dir(tmp_path / "work")
        git = work / ".git"
        if form == "directory":
            git.mkdir()
        elif form == "file":  # a linked work tree or a submodule
            git.write_text("gitdir: /elsewhere/.git/worktrees/w\n")
        elif form == "dangling-symlink":
            git.symlink_to(tmp_path / "does-not-exist")
        else:
            (tmp_path / "gitdir").mkdir()
            git.symlink_to(tmp_path / "gitdir", target_is_directory=True)
        for target in (work / "keys.json", work / "a" / "b" / "keys.json"):
            with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
                load_or_create_keys(str(target))
        assert os.listdir(work) == [".git"], "something was created inside the checkout"

    def test_a_checkout_several_levels_above_an_existing_key_directory_is_found(self, tmp_path):
        made = tmp_path / "made" / "keys.json"
        load_or_create_keys(str(made))
        deep = _private_dir(tmp_path / "repo" / "a" / "b" / "c")
        (tmp_path / "repo" / ".git").mkdir()
        (deep / "keys.json").write_bytes(made.read_bytes())
        os.chmod(deep / "keys.json", 0o600)
        with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
            load_or_create_keys(str(deep / "keys.json"))

    def test_missing_directories_are_created_private_outside_a_checkout(self, tmp_path):
        target = tmp_path / "a" / "b" / "keys.json"
        load_or_create_keys(str(target))
        assert stat.S_IMODE(os.stat(target.parent).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(target).st_mode) == 0o600

    def test_a_git_file_in_an_ancestor_refuses_an_existing_key_too(self, tmp_path):
        made = tmp_path / "made" / "keys.json"
        load_or_create_keys(str(made))
        work = _private_dir(tmp_path / "worktree")
        (work / ".git").write_text("gitdir: /elsewhere/.git/worktrees/w\n")
        inside = _private_dir(work / "sub") / "keys.json"
        inside.write_bytes(made.read_bytes())
        os.chmod(inside, 0o600)
        with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
            load_or_create_keys(str(inside))

    def test_an_ancestor_that_cannot_be_opened_refuses_instead_of_skipping_the_check(self, monkeypatch, tmp_path):
        real_open = os.open

        def open_without_the_parent(path, flags, mode=0o777, *, dir_fd=None):
            if path == "..":  # a directory that is searchable but not readable, say
                raise PermissionError(errno.EACCES, "Permission denied", path)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        target = _private_dir(tmp_path / "keys") / "keys.json"
        monkeypatch.setattr(crypto_module.os, "open", open_without_the_parent)
        before = _open_descriptors()
        with pytest.raises(crypto_module.KeyFileError, match="cannot tell whether"):
            load_or_create_keys(str(target))
        assert _open_descriptors() == before
        assert not target.exists()

    def test_a_directory_another_process_created_with_a_git_entry_is_refused(self, monkeypatch, tmp_path):
        real_mkdir = os.mkdir

        def lose_the_race(name, mode=0o777, *, dir_fd=None):
            real_mkdir(name, mode, dir_fd=dir_fd)
            real_mkdir(os.path.join(name, ".git"), mode, dir_fd=dir_fd)  # what the other process made
            raise FileExistsError(errno.EEXIST, "File exists", name)

        monkeypatch.setattr(crypto_module.os, "mkdir", lose_the_race)
        with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
            load_or_create_keys(str(tmp_path / "other" / "keys.json"))
        assert os.listdir(tmp_path / "other") == [".git"], "a key went into the work tree"

    def test_a_symbolic_link_planted_where_a_directory_is_created_is_not_followed(self, monkeypatch, tmp_path):
        safe = _private_dir(tmp_path / "safe")

        def lose_the_race(name, mode=0o777, *, dir_fd=None):
            os.symlink(str(safe), name, dir_fd=dir_fd)  # what the other process made: a link to a directory
            raise FileExistsError(errno.EEXIST, "File exists", name)

        monkeypatch.setattr(crypto_module.os, "mkdir", lose_the_race)
        with pytest.raises(OSError) as refused:
            load_or_create_keys(str(tmp_path / "other" / "keys.json"))
        assert refused.value.errno in (errno.ELOOP, errno.ENOTDIR)  # which one depends on the kernel
        assert os.listdir(safe) == [], "the planted link was followed and a key went through it"

    def test_no_descriptor_is_left_open_on_any_path(self, tmp_path):
        repo_dir = _private_dir(tmp_path / "repo" / "a" / "b")
        (tmp_path / "repo" / ".git").mkdir()
        shared = tmp_path / "shared"
        shared.mkdir()
        os.chmod(shared, 0o777)
        new = tmp_path / "new" / "deeper" / "keys.json"
        before = _open_descriptors()
        load_or_create_keys(str(new))  # creates the missing directories and the file
        load_or_create_keys(str(new))  # loads it
        for refused in (repo_dir / "keys.json", shared / "keys.json"):  # a checkout two levels up; a writable directory
            for _ in range(3):
                with pytest.raises(crypto_module.KeyFileError):
                    load_or_create_keys(str(refused))
        assert _open_descriptors() == before

    def test_a_dangling_symbolic_link_as_the_key_file_is_refused_not_followed(self, tmp_path):
        keys_dir = _private_dir(tmp_path / "keys")
        target = tmp_path / "elsewhere" / "stolen.json"
        (keys_dir / "keys.json").symlink_to(target)
        with pytest.raises(crypto_module.KeyFileError, match="symbolic link"):
            load_or_create_keys(str(keys_dir / "keys.json"))
        assert not target.parent.exists()

    def test_a_relative_path_is_taken_from_the_working_directory(self, monkeypatch, tmp_path):
        monkeypatch.chdir(tmp_path)
        created = load_or_create_keys("rel/keys.json")
        assert (tmp_path / "rel" / "keys.json").exists()
        loaded_what_it_created = load_or_create_keys("rel/keys.json") == created
        assert loaded_what_it_created

    def test_a_path_that_names_no_file_is_refused(self):
        with pytest.raises(crypto_module.KeyFileError, match="does not name a file"):
            load_or_create_keys("/")

    @pytest.mark.parametrize(
        "missing",
        [
            "dir_fd:open", "dir_fd:stat", "dir_fd:mkdir", "dir_fd:unlink",
            "follow_symlinks:stat", "O_DIRECTORY", "O_NOFOLLOW",
        ],
    )
    def test_a_platform_that_cannot_bind_to_a_directory_descriptor_fails_closed(self, monkeypatch, tmp_path, missing):
        kind, _, name = missing.partition(":")
        if kind == "dir_fd":
            monkeypatch.setattr(os, "supports_dir_fd", frozenset(os.supports_dir_fd) - {getattr(os, name)})
        elif kind == "follow_symlinks":
            without = frozenset(os.supports_follow_symlinks) - {getattr(os, name)}
            monkeypatch.setattr(os, "supports_follow_symlinks", without)
        else:
            monkeypatch.delattr(os, kind)
        with pytest.raises(crypto_module.KeyFileError, match="relative to a verified directory"):
            load_or_create_keys(str(tmp_path / "new" / "keys.json"))
        existing = _private_dir(tmp_path / "old")
        _new_key_pair_file(existing / "keys.json")
        with pytest.raises(crypto_module.KeyFileError, match="relative to a verified directory"):
            load_or_create_keys(str(existing / "keys.json"))
        assert not (tmp_path / "new").exists()


@needs_nacl
class TestHardLinkedKeyFiles:
    """A02b F2: a key file with a second name may also be a file inside a checkout."""

    def test_a_key_file_hard_linked_into_a_checkout_is_refused(self, tmp_path):
        made = tmp_path / "made" / "keys.json"
        load_or_create_keys(str(made))
        repo = tmp_path / "repo"
        (repo / ".git").mkdir(parents=True)
        inside = repo / "keys.json"
        inside.write_bytes(made.read_bytes())
        os.chmod(inside, 0o600)
        outside = _private_dir(tmp_path / "outside") / "keys.json"
        os.link(inside, outside)
        assert os.stat(outside).st_nlink == 2
        with pytest.raises(crypto_module.KeyFileError, match="hard link"):
            load_or_create_keys(str(outside))

    def test_a_new_key_file_that_gained_a_second_link_is_refused_and_removed(self, monkeypatch, tmp_path):
        repo = tmp_path / "repo"
        (repo / ".git").mkdir(parents=True)
        planted = repo / "planted.json"
        target = tmp_path / "keys-dir" / "keys.json"
        real_open = os.open

        def open_then_link(path, flags, mode=0o777, *, dir_fd=None):
            fd = real_open(path, flags, mode, dir_fd=dir_fd)
            if flags & os.O_CREAT and not planted.exists():
                os.link(path, planted, src_dir_fd=dir_fd)
            return fd

        monkeypatch.setattr(crypto_module.os, "open", open_then_link)
        with pytest.raises(crypto_module.KeyFileError, match="hard link"):
            load_or_create_keys(str(target))
        assert not target.exists(), "the refused key file was left behind"
        assert planted.read_bytes() == b"", "a secret was written through the extra link"


@needs_nacl
class TestTheLocationIsCheckedWhenTheKeyIsLoaded:
    """A02b F3, the documented limit: nothing watches the location once the key
    is loaded. A repository created around it later is caught by the next load,
    which for the daemon is the next start."""

    def test_a_repository_created_after_loading_is_noticed_by_the_next_load_only(self, tmp_path):
        home = _private_dir(tmp_path / "home")
        path = str(home / "keys.json")
        public, secret = load_or_create_keys(path)
        (home / ".git").mkdir()
        signature = sign_announcement({"a": 1}, secret)
        still_verifies = verify_signature({"a": 1}, signature, public)
        assert still_verifies
        with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
            load_or_create_keys(path)


@needs_nacl
class TestTheLocationIsCheckedAgainBeforeTheKeyIsUsed:
    """A02b F1, its last sentence: the checkout check is repeated on the open directory
    after the key file is read or created, before the key is returned."""

    @staticmethod
    def _git_appears_above(monkeypatch, top, attr):
        real = getattr(crypto_module, attr)

        def wrapped(*args, **kwargs):
            (top / ".git").mkdir()
            return real(*args, **kwargs)

        monkeypatch.setattr(crypto_module, attr, wrapped)

    def test_a_checkout_that_appears_before_the_load_returns_is_refused(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "home" / "keys")
        _new_key_pair_file(keys / "keys.json")
        self._git_appears_above(monkeypatch, tmp_path / "home", "_read_key_file")
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(keys / "keys.json"))

    def test_a_key_created_as_a_checkout_appears_is_refused_and_removed(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "home" / "keys")
        self._git_appears_above(monkeypatch, tmp_path / "home", "_create_key_file")
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(keys / "keys.json"))
        assert os.listdir(keys) == [], "a new secret was left inside the checkout"


@needs_nacl
class TestA02cTheLastCheckAndTheWalksEnd:
    """A02c: the walk's root test, a terminal check of the directory AND the open key file, and a scrubbed cleanup."""

    def test_a_directory_whose_parent_reports_its_own_identity_does_not_end_the_walk(self, monkeypatch, tmp_path):
        # A bind mount of repo/keys onto its child repo/keys/loop makes the mounted directory and its ".."
        # report the same (st_dev, st_ino). Simulated: fstat answers repo/keys with loop's identity.
        held, _ = _checkout_holding(tmp_path)
        loop = _private_dir(held / "loop")
        real_fstat = os.fstat
        held_id = (os.stat(held).st_dev, os.stat(held).st_ino)
        loop_st = os.stat(loop)

        def fstat(fd):
            st = real_fstat(fd)
            if (st.st_dev, st.st_ino) != held_id:
                return st
            fields = {k: getattr(st, k) for k in ("st_mode", "st_uid", "st_gid", "st_nlink", "st_size")}
            return __import__("types").SimpleNamespace(st_dev=loop_st.st_dev, st_ino=loop_st.st_ino, **fields)

        monkeypatch.setattr(crypto_module.os, "fstat", fstat)
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(loop / "keys.json"))
        assert os.listdir(loop) == [], "a new secret was created inside the checkout"

    def test_a_checkout_made_while_the_key_is_parsed_is_refused(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "home" / "keys")
        _new_key_pair_file(keys / "keys.json")
        real = crypto_module._strict_hex

        def strict_hex(*args, **kwargs):
            if not (tmp_path / "home" / ".git").exists():
                (tmp_path / "home" / ".git").mkdir()
            return real(*args, **kwargs)

        monkeypatch.setattr(crypto_module, "_strict_hex", strict_hex)
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(keys / "keys.json"))

    @pytest.mark.parametrize("existing", [True, False], ids=["existing-key", "new-key"])
    def test_a_second_name_added_inside_a_checkout_after_the_file_was_judged_is_refused(self, monkeypatch, tmp_path, existing):
        keys = _private_dir(tmp_path / "home" / "keys")
        held, _ = _checkout_holding(tmp_path)
        if existing:
            _new_key_pair_file(keys / "keys.json")
        real = crypto_module._judge_key_file
        calls = []

        def judge(fd, key_path):
            real(fd, key_path)
            calls.append(key_path)
            if len(calls) == 1:
                os.link(keys / "keys.json", held / "keys.json")

        monkeypatch.setattr(crypto_module, "_judge_key_file", judge)
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(keys / "keys.json"))

    def test_a_refused_new_key_is_scrubbed_even_when_it_cannot_be_removed(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "home" / "keys")
        real = crypto_module._judge_key_file

        def judge(fd, key_path):
            real(fd, key_path)
            if not (tmp_path / "home" / ".git").exists():
                (tmp_path / "home" / ".git").mkdir()

        def unlink(*args, **kwargs):
            raise PermissionError("unlink refused for the test")

        monkeypatch.setattr(crypto_module, "_judge_key_file", judge)
        monkeypatch.setattr(crypto_module.os, "unlink", unlink)
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(keys / "keys.json"))
        left = keys / "keys.json"
        assert not left.exists() or left.stat().st_size == 0, "a written secret was left inside the checkout"
        assert "could not be removed" in str(refused.value)


@needs_nacl
class TestA02dMountsAndScrubbing:
    """A02d: a "/" alias below a checkout does not end the walk; a bind-mounted subtree is refused; scrubbing is honest."""

    def test_a_directory_that_looks_like_the_root_but_is_another_mount_does_not_end_the_walk(self, monkeypatch, tmp_path):
        # "/" bind-mounted at repo/rootalias has the root's device and inode, on another mount.
        held, _ = _checkout_holding(tmp_path)
        alias = _private_dir(held / "rootalias")
        keys = _private_dir(alias / "keys")
        root_st = os.stat("/")
        alias_id = (os.stat(alias).st_dev, os.stat(alias).st_ino)
        real_fstat = os.fstat

        def fstat(fd):
            st = real_fstat(fd)
            if (st.st_dev, st.st_ino) != alias_id:
                return st
            fields = {k: getattr(st, k) for k in ("st_mode", "st_uid", "st_gid", "st_nlink", "st_size")}
            return __import__("types").SimpleNamespace(st_dev=root_st.st_dev, st_ino=root_st.st_ino, **fields)

        real_mount_of = crypto_module._mount_of

        def mount_of(fd):
            # The alias is its own mount showing a whole filesystem, as a bind of "/" is,
            # whether or not the test's temporary directory shares a mount with "/".
            m = real_mount_of(fd)
            st = real_fstat(fd)
            if (st.st_dev, st.st_ino) == alias_id:
                return {"id": "alias-of-root", "devno": "0:999", "root": "/", "mountpoint": str(alias), "fstype": "ext4", "source": "/dev/alias", "super": "rw"}
            return m

        monkeypatch.setattr(crypto_module.os, "fstat", fstat)
        monkeypatch.setattr(crypto_module, "_mount_of", mount_of)
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(keys / "keys.json"))
        assert os.listdir(keys) == [], "a new secret was created inside the checkout"

    def test_a_key_reached_through_a_bind_mounted_subtree_is_refused(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "outside" / "keys")
        keys_id = (os.stat(keys).st_dev, os.stat(keys).st_ino)
        real = crypto_module._mount_of

        def mount_of(fd):
            m = real(fd)
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) == keys_id:
                return {"id": "bind-1", "devno": "8:1", "root": "/home/dev/repo/keys", "mountpoint": str(keys), "fstype": "ext4", "source": "/dev/sda1", "super": "rw"}
            return m

        monkeypatch.setattr(crypto_module, "_mount_of", mount_of)
        with pytest.raises(crypto_module.KeyFileError, match="bind mount of a subtree"):
            load_or_create_keys(str(keys / "keys.json"))
        assert os.listdir(keys) == []

    def test_a_btrfs_subvolume_mounted_as_such_is_a_whole_filesystem(self):
        assert crypto_module._whole_filesystem({"id": "1", "root": "/@home", "fstype": "btrfs", "super": "rw,subvol=/@home"})
        assert not crypto_module._whole_filesystem({"id": "1", "root": "/@home/dev/repo", "fstype": "btrfs", "super": "rw,subvol=/@home"})
        assert not crypto_module._whole_filesystem({"id": "1", "root": "/srv/repo/keys", "fstype": "ext4", "super": "rw"})
        assert crypto_module._whole_filesystem({"id": "1", "root": "/", "fstype": "ext4", "super": "rw"})
        assert crypto_module._unescape_mountinfo("/a" + chr(92) + "040b") == "/a b"

    def test_an_unreadable_proc_refuses_on_linux(self, monkeypatch, tmp_path):
        if not crypto_module._LINUX:
            pytest.fail("this check is Linux-only, and CI runs it on Linux")
        keys = _private_dir(tmp_path / "home" / "keys")
        real_open = open

        def guarded_open(path, *args, **kwargs):
            if str(path).startswith("/proc/self/"):
                raise PermissionError("no /proc for the test")
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr("builtins.open", guarded_open)
        with pytest.raises(crypto_module.KeyFileError, match="cannot read this process's mounts"):
            load_or_create_keys(str(keys / "keys.json"))

    @pytest.mark.parametrize("pwrite_fails", [False, True], ids=["overwritten", "nothing-works"])
    def test_scrubbing_is_honest_when_truncation_fails(self, monkeypatch, tmp_path, pwrite_fails):
        keys = _private_dir(tmp_path / "home" / "keys")
        real = crypto_module._judge_key_file

        def judge(fd, key_path):
            real(fd, key_path)
            if not (tmp_path / "home" / ".git").exists():
                (tmp_path / "home" / ".git").mkdir()

        def refuse(*args, **kwargs):
            raise PermissionError("refused for the test")

        monkeypatch.setattr(crypto_module, "_judge_key_file", judge)
        monkeypatch.setattr(crypto_module.os, "unlink", refuse)
        monkeypatch.setattr(crypto_module.os, "ftruncate", refuse)
        if pwrite_fails:
            monkeypatch.setattr(crypto_module.os, "pwrite", refuse)
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(keys / "keys.json"))
        left = (keys / "keys.json").read_bytes()
        if pwrite_fails:
            assert "SECRET MAY REMAIN" in str(refused.value)
            assert "emptied first" not in str(refused.value)
        else:
            assert left.strip(b"\0") == b"", "the secret was not overwritten"
            assert "emptied first" in str(refused.value)


@needs_nacl
class TestA02eAliasesUnionsAndCleanup:
    """A02e: other mount-visible names are walked too, union filesystems are refused, mountinfo is strict, cleanup always ends."""

    @staticmethod
    def _record(mid, devno, root, mountpoint, fstype="ext4", source="/dev/sda1", sup="rw"):
        return {"id": mid, "devno": devno, "root": root, "mountpoint": mountpoint, "fstype": fstype, "source": source, "super": sup}

    def test_every_other_mount_of_the_same_filesystem_is_an_alias(self):
        r = self._record
        # a tmpfs mounted at /repo/storage and its whole root bound onto /outside (the reviewer's case)
        mine = r("2", "0:50", "/", "/outside", "tmpfs", "tmpfs")
        mounts = [r("1", "8:1", "/", "/"), mine, r("3", "0:50", "/", "/repo/storage", "tmpfs", "tmpfs")]
        assert crypto_module._alias_paths("/keys", mine, mounts) == ["/repo/storage/keys"]
        # the same ext4 filesystem mounted whole twice
        mine = r("5", "8:2", "/", "/data")
        assert crypto_module._alias_paths("/node/keys", mine, [mine, r("6", "8:2", "/", "/srv/repo/data")]) == ["/srv/repo/data/node/keys"]
        # a btrfs subvolume, also visible through the top level mounted inside a checkout
        mine = r("7", "0:31", "/@home", "/home", "btrfs", "/dev/nvme0n1p3", "rw,subvol=/@home")
        top = r("8", "0:32", "/", "/repo/btrfs-top", "btrfs", "/dev/nvme0n1p3", "rw,subvol=/")
        assert crypto_module._alias_paths("/@home/dev/keys", mine, [mine, top]) == ["/repo/btrfs-top/@home/dev/keys"]
        # a subtree mount that does not contain the directory, and another filesystem: no alias
        assert crypto_module._alias_paths("/node/keys", r("9", "8:2", "/", "/data"), [r("10", "8:2", "/other", "/x"), r("11", "8:3", "/", "/y")]) == []

    def test_a_malformed_mountinfo_record_refuses(self, monkeypatch, tmp_path):
        if not crypto_module._LINUX:
            pytest.fail("Linux-only, and CI runs it on Linux")
        fake = tmp_path / "mountinfo"
        fake.write_text("36 35 98:0 / /mnt/x rw,relatime - tmpfs\n")  # no super-options field
        real_open = open

        def guarded_open(path, *args, **kwargs):
            return real_open(fake if str(path) == "/proc/self/mountinfo" else path, *args, **kwargs)

        monkeypatch.setattr("builtins.open", guarded_open)
        with pytest.raises(crypto_module.KeyFileError, match="cannot read this process's mounts"):
            crypto_module._mountinfo()

    def test_a_key_on_a_union_filesystem_is_refused(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "home" / "keys")
        keys_id = (os.stat(keys).st_dev, os.stat(keys).st_ino)
        real = crypto_module._mount_of

        def mount_of(fd):
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) == keys_id:
                return self._record("77", "0:77", "/", str(keys), "overlay", "overlay", "rw,upperdir=/repo/upper")
            return real(fd)

        monkeypatch.setattr(crypto_module, "_mount_of", mount_of)
        with pytest.raises(crypto_module.KeyFileError, match="union filesystem"):
            load_or_create_keys(str(keys / "keys.json"))
        assert os.listdir(keys) == []

    def test_cleanup_ends_and_tells_the_truth_when_pwrite_makes_no_progress(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "home" / "keys")
        real = crypto_module._judge_key_file

        def judge(fd, key_path):
            real(fd, key_path)
            if not (tmp_path / "home" / ".git").exists():
                (tmp_path / "home" / ".git").mkdir()

        def refuse(*args, **kwargs):
            raise PermissionError("refused for the test")

        monkeypatch.setattr(crypto_module, "_judge_key_file", judge)
        monkeypatch.setattr(crypto_module.os, "ftruncate", refuse)
        monkeypatch.setattr(crypto_module.os, "unlink", refuse)
        monkeypatch.setattr(crypto_module.os, "pwrite", lambda fd, data, offset: 0)
        with pytest.raises(crypto_module.KeyFileError, match="SECRET MAY REMAIN"):
            load_or_create_keys(str(keys / "keys.json"))
