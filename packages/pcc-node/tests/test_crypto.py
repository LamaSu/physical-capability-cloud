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
    """A developer's key-path overrides must not steer these tests."""
    monkeypatch.delenv("PCC_NODE_KEY_PATH", raising=False)
    monkeypatch.delenv("PCC_NODE_KEYS_FILE", raising=False)


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


class TestDefaultKeyPath:
    def test_default_path_is_under_home_not_the_checkout(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HOME", str(tmp_path))
        assert crypto_module.default_key_path() == str(tmp_path / ".pcc-node" / "keys.json")
        package_dir = Path(crypto_module.__file__).resolve().parents[1]
        assert not Path(crypto_module.default_key_path()).resolve().is_relative_to(package_dir)

    @pytest.mark.parametrize("variable", ["PCC_NODE_KEY_PATH", "PCC_NODE_KEYS_FILE"])
    @pytest.mark.parametrize("override", ["keys/node.json", "~/.pcc-node/keys.json"])
    def test_relative_or_literal_tilde_override_is_refused(self, monkeypatch, variable, override):
        monkeypatch.setenv(variable, override)
        with pytest.raises(crypto_module.KeyFileError, match=variable + " must be an absolute path"):
            crypto_module.default_key_path()

    @pytest.mark.parametrize("variable", ["PCC_NODE_KEY_PATH", "PCC_NODE_KEYS_FILE"])
    def test_absolute_override_is_returned_unchanged(self, monkeypatch, tmp_path, variable):
        override = str(tmp_path) + "/keys/../node.json"
        monkeypatch.setenv(variable, override)
        assert crypto_module.default_key_path() == override

    def test_primary_override_takes_precedence(self, monkeypatch, tmp_path):
        override = str(tmp_path / "node.json")
        monkeypatch.setenv("PCC_NODE_KEY_PATH", override)
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", "ignored-relative.json")
        assert crypto_module.default_key_path() == override

    def test_refused_primary_override_cannot_fall_back(self, monkeypatch, tmp_path):
        monkeypatch.setenv("PCC_NODE_KEY_PATH", "keys/node.json")
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(tmp_path / "fallback.json"))
        with pytest.raises(crypto_module.KeyFileError, match="PCC_NODE_KEY_PATH must be an absolute path"):
            crypto_module.default_key_path()

    def test_empty_primary_override_uses_the_fallback(self, monkeypatch, tmp_path):
        override = str(tmp_path / "fallback.json")
        monkeypatch.setenv("PCC_NODE_KEY_PATH", "")
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", override)
        assert crypto_module.default_key_path() == override

    def test_empty_overrides_use_the_default(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("PCC_NODE_KEY_PATH", "")
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", "")
        assert crypto_module.default_key_path() == str(tmp_path / ".pcc-node" / "keys.json")


@needs_nacl
class TestKeyFileLocation:
    def test_default_load_never_reads_the_working_directory(self, monkeypatch, tmp_path):
        home = tmp_path / "home"
        cwd = tmp_path / "checkout"
        cwd.mkdir()
        # A legacy key must never become the default identity automatically.
        # Master's explicit-move rule also refuses to mint a replacement while
        # this file remains, rather than silently ignoring an old identity.
        public, secret = generate_node_keys()
        legacy = cwd / "pcc-keys.json"
        _write_key_file(legacy, public, secret)
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.chdir(cwd)
        with pytest.raises(crypto_module.KeyFileError, match="move it into place yourself"):
            load_or_create_keys()
        assert legacy.exists()
        assert not (home / ".pcc-node" / "keys.json").exists()

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
        # Restrict the exposed file, as #374 did, but do not silently use a key
        # whose secret another account may already have copied (master).
        with pytest.raises(crypto_module.KeyFileError, match="chmod 600"):
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
        real_uid = os.geteuid()
        monkeypatch.setattr(crypto_module.os, "geteuid", lambda: real_uid + 1)
        with pytest.raises(crypto_module.KeyFileError, match="not owned by this user"):
            load_or_create_keys(str(path))
        monkeypatch.setattr(crypto_module, "_check_directory", lambda *args: None)
        # Isolate the file's effective-uid guard after the whole directory chain
        # has already been refused above.
        monkeypatch.setattr(crypto_module, "_check_ancestor", lambda *args: None)
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

    def test_pynacl_is_required_before_a_legacy_file_is_touched(self, monkeypatch, tmp_path):
        home = _private_dir(tmp_path / "home")
        work = _private_dir(tmp_path / "work")
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.chdir(work)
        legacy = work / "pcc-keys.json"
        legacy.write_text("{}")
        os.chmod(legacy, 0o644)
        before = legacy.stat()
        monkeypatch.setattr(crypto_module, "_HAS_NACL", False)

        with pytest.raises(crypto_module.CryptoUnavailableError):
            load_or_create_keys(None)

        after = legacy.stat()
        assert stat.S_IMODE(after.st_mode) == stat.S_IMODE(before.st_mode) == 0o644
        assert after.st_size == before.st_size == 2
        assert list(home.iterdir()) == [], "missing PyNaCl must not create a key directory"


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
    """``load_or_create_keys`` aimed at *path*, by argument or either environment override."""
    if via_env:
        variable = "PCC_NODE_KEY_PATH" if via_env is True else via_env
        monkeypatch.setenv(variable, str(path))
        return load_or_create_keys
    return lambda: load_or_create_keys(str(path))


BY_ARGUMENT_OR_ENV = pytest.mark.parametrize(
    "via_env", [False, True, "PCC_NODE_KEYS_FILE"],
    ids=["path-argument", "PCC_NODE_KEY_PATH", "PCC_NODE_KEYS_FILE"],
)


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

    @BY_ARGUMENT_OR_ENV
    @pytest.mark.parametrize("form", ["directory", "file", "dangling-symlink", "symlink-to-directory"])
    def test_a_git_entry_of_any_form_in_an_ancestor_counts_as_a_checkout(self, monkeypatch, tmp_path, form, via_env):
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
            load = _loader(monkeypatch, target, via_env)
            with pytest.raises(crypto_module.KeyFileError, match="inside a source checkout"):
                load()
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
            "dir_fd:open", "dir_fd:stat", "dir_fd:mkdir", "dir_fd:unlink", "dir_fd:link",
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


def _trace_refused_new_key_cleanup(monkeypatch, tmp_path, refused_name):
    """Select the failed unlink and record which refusal/cleanup path runs."""
    keys = _private_dir(tmp_path / "home" / "keys")
    real_judge = crypto_module._judge_key_file
    real_terminal = crypto_module._check_key_location
    real_scrub = crypto_module._scrub_and_remove
    real_unlink = os.unlink
    trace = []

    def judge(fd, key_path):
        real_judge(fd, key_path)
        if not (tmp_path / "home" / ".git").exists():
            (tmp_path / "home" / ".git").mkdir()

    def terminal(*args, **kwargs):
        trace.append("terminal")
        return real_terminal(*args, **kwargs)

    def scrub(dir_fd, name, *args, **kwargs):
        trace.append("scrub:final" if name == "keys.json" else "scrub:temp")
        return real_scrub(dir_fd, name, *args, **kwargs)

    def unlink(name, *args, **kwargs):
        is_final = name == "keys.json"
        if is_final == (refused_name == "final"):
            raise PermissionError("unlink refused for the test")
        return real_unlink(name, *args, **kwargs)

    monkeypatch.setattr(crypto_module, "_judge_key_file", judge)
    monkeypatch.setattr(crypto_module, "_check_key_location", terminal)
    monkeypatch.setattr(crypto_module, "_scrub_and_remove", scrub)
    monkeypatch.setattr(crypto_module.os, "unlink", unlink)
    return keys, trace


def _assert_refused_new_key_cleanup_trace(trace, refused_name):
    expected = (["terminal", "scrub:final"] if refused_name == "final"
                else ["scrub:temp", "scrub:final"])
    assert trace == expected, "the intended refusal and cleanup path was not exercised"


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
                # Atomic creation judges an unpublished temporary file; use
                # this checked descriptor's name for both creation and load.
                os.link(os.readlink("/proc/self/fd/%d" % fd), held / "keys.json")

        monkeypatch.setattr(crypto_module, "_judge_key_file", judge)
        with pytest.raises(crypto_module.KeyFileError):
            load_or_create_keys(str(keys / "keys.json"))

    @pytest.mark.parametrize("refused_name", ["final", "temp"], ids=["final-name", "temp-name"])
    def test_a_refused_new_key_is_scrubbed_even_when_it_cannot_be_removed(self, monkeypatch, tmp_path, refused_name):
        keys, trace = _trace_refused_new_key_cleanup(monkeypatch, tmp_path, refused_name)
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(keys / "keys.json"))
        _assert_refused_new_key_cleanup_trace(trace, refused_name)
        left = list(keys.iterdir())
        assert len(left) == 1, "the cleanup failure did not leave exactly the refused name"
        assert (left[0].name == "keys.json") == (refused_name == "final")
        assert left[0].stat().st_size == 0, "a written secret was left inside the checkout"
        assert "could not be removed" in str(refused.value)
        assert "the new key file %s could not be removed" % left[0] in str(refused.value)


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
    @pytest.mark.parametrize("refused_name", ["final", "temp"], ids=["final-name", "temp-name"])
    def test_scrubbing_is_honest_when_truncation_fails(self, monkeypatch, tmp_path, pwrite_fails, refused_name):
        keys, trace = _trace_refused_new_key_cleanup(monkeypatch, tmp_path, refused_name)
        real_pwrite = os.pwrite
        writes = []

        def pwrite(fd, data, offset):
            assert data == b"\0" * len(data), "the scrub write did not contain only zeros"
            written = real_pwrite(fd, data, offset)
            writes.append((offset, written, os.fstat(fd).st_size))
            return written

        def refuse(*args, **kwargs):
            raise PermissionError("refused for the test")

        monkeypatch.setattr(crypto_module.os, "ftruncate", refuse)
        monkeypatch.setattr(crypto_module.os, "pwrite", refuse if pwrite_fails else pwrite)
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(keys / "keys.json"))
        _assert_refused_new_key_cleanup_trace(trace, refused_name)
        left = list(keys.iterdir())
        assert len(left) == 1, "the cleanup failure did not leave exactly the refused name"
        assert (left[0].name == "keys.json") == (refused_name == "final")
        assert left[0].stat().st_size > 0
        if pwrite_fails:
            assert "SECRET MAY REMAIN" in str(refused.value)
            assert "it was emptied first: no secret" not in str(refused.value)
            assert str(left[0]) in str(refused.value), "the advice does not name the file that keeps the secret"
            if refused_name == "temp":
                assert "the name %s was removed" % (keys / "keys.json") in str(refused.value)
        else:
            # Observe only write offsets/lengths and file metadata, never read a key.
            assert writes and all(offset == 0 and written == size for offset, written, size in writes)
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
        with pytest.raises(crypto_module.KeyFileError, match="union or FUSE filesystem"):
            load_or_create_keys(str(keys / "keys.json"))
        assert os.listdir(keys) == []

    @pytest.mark.parametrize("refused_name", ["final", "temp"], ids=["final-name", "temp-name"])
    def test_cleanup_ends_and_tells_the_truth_when_pwrite_makes_no_progress(self, monkeypatch, tmp_path, refused_name):
        keys, trace = _trace_refused_new_key_cleanup(monkeypatch, tmp_path, refused_name)
        writes = []

        def refuse(*args, **kwargs):
            raise PermissionError("refused for the test")

        def no_progress(fd, data, offset):
            assert data == b"\0" * len(data), "the scrub write did not contain only zeros"
            writes.append((offset, len(data)))
            return 0

        monkeypatch.setattr(crypto_module.os, "ftruncate", refuse)
        monkeypatch.setattr(crypto_module.os, "pwrite", no_progress)
        with pytest.raises(crypto_module.KeyFileError, match="SECRET MAY REMAIN"):
            load_or_create_keys(str(keys / "keys.json"))
        _assert_refused_new_key_cleanup_trace(trace, refused_name)
        expected_calls = 1 if refused_name == "final" else 2
        assert len(writes) == expected_calls, "each scrub must stop after its first failed write"


@needs_nacl
class TestA02fFuseAndHonestCleanup:
    """A02f: every FUSE filesystem is refused; a failed scrub is reported even when the name was removed."""

    @pytest.mark.parametrize("fstype", ["fuse.fuse-overlayfs", "fuse.mergerfs", "fuse", "fuseblk", "fuse.sshfs"])
    def test_a_key_on_any_fuse_filesystem_is_refused(self, monkeypatch, tmp_path, fstype):
        keys = _private_dir(tmp_path / "home" / "keys")
        keys_id = (os.stat(keys).st_dev, os.stat(keys).st_ino)
        real = crypto_module._mount_of

        def mount_of(fd):
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) == keys_id:
                return {"id": "61", "devno": "0:61", "root": "/", "mountpoint": str(keys), "fstype": fstype, "source": "x", "super": "rw"}
            return real(fd)

        monkeypatch.setattr(crypto_module, "_mount_of", mount_of)
        with pytest.raises(crypto_module.KeyFileError, match="union or FUSE filesystem"):
            load_or_create_keys(str(keys / "keys.json"))
        assert os.listdir(keys) == []

    def test_a_failed_scrub_is_reported_even_when_the_name_was_removed(self, monkeypatch, tmp_path):
        keys = _private_dir(tmp_path / "home" / "keys")
        repo = tmp_path / "repo"
        (repo / ".git").mkdir(parents=True)
        real = crypto_module._judge_key_file
        calls = []

        def judge(fd, key_path):
            calls.append(1)
            if len(calls) == 2:  # the terminal judge of the new key: a second name appears in a checkout
                os.link(keys / "keys.json", repo / "keys.json")
            real(fd, key_path)

        def refuse(*args, **kwargs):
            raise PermissionError("refused for the test")

        monkeypatch.setattr(crypto_module, "_judge_key_file", judge)
        monkeypatch.setattr(crypto_module.os, "ftruncate", refuse)
        monkeypatch.setattr(crypto_module.os, "pwrite", refuse)
        with pytest.raises(crypto_module.KeyFileError, match="SECRET MAY REMAIN"):
            load_or_create_keys(str(keys / "keys.json"))
        assert not (keys / "keys.json").exists(), "the name the key was created under is removed"


# ---------------------------------------------------------------------------
# Key file safety (ADK track item 9): never the working directory, owner-only,
# a matching pair, and an explicit move required for a 0.1.x key file.
# ---------------------------------------------------------------------------

import hashlib
import logging

from pcc_node import crypto
from pcc_node.crypto import KeyFileError, LEGACY_KEYS_PATH

posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")


def _write_pair(path, public_hex, secret_hex, mode=0o600):
    with open(path, "w") as f:
        json.dump({"public": public_hex, "secret": secret_hex}, f)
    os.chmod(path, mode)


# Without PyNaCl, every key operation is refused first (#374; see
# TestWithoutPyNaClNoKeyIsUsed). Guarded tests create or load a key, which needs PyNaCl.
# CI step 3 runs them with nothing skipped.
class TestKeyFileSafety:
    @needs_nacl
    @posix_only
    def test_a_new_key_file_is_owner_only_in_a_private_directory(self, tmp_path):
        path = tmp_path / "node" / "keys.json"
        load_or_create_keys(str(path))
        assert (os.stat(path).st_mode & 0o777) == 0o600
        assert (os.stat(path.parent).st_mode & 0o777) == 0o700

    @needs_nacl
    @posix_only
    def test_a_key_file_others_can_read_is_refused(self, tmp_path):
        path = str(tmp_path / "keys.json")
        load_or_create_keys(path)
        os.chmod(path, 0o644)
        with pytest.raises(KeyFileError, match="chmod 600"):
            load_or_create_keys(path)

    @needs_nacl
    def test_a_mismatched_pair_is_refused(self, tmp_path):
        pub, _sec = generate_node_keys()
        _other_pub, other_sec = generate_node_keys()
        path = str(tmp_path / "keys.json")
        _write_pair(path, pub, other_sec)
        with pytest.raises(KeyFileError, match="does not belong"):
            load_or_create_keys(path)

    @needs_nacl
    def test_a_file_that_is_not_a_key_pair_is_refused(self, tmp_path):
        for text in ("not json", "{}", '{"public": "zz", "secret": "zz"}', '{"public": "00", "secret": "00"}'):
            path = tmp_path / "keys.json"
            path.write_text(text)
            os.chmod(path, 0o600)
            with pytest.raises(KeyFileError):
                load_or_create_keys(str(path))

    @needs_nacl
    def test_the_default_never_writes_into_the_working_directory(self, tmp_path, monkeypatch):
        work = tmp_path / "checkout"
        work.mkdir()
        monkeypatch.chdir(work)
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(tmp_path / "home" / "keys.json"))
        pub, sec = load_or_create_keys()
        assert os.listdir(work) == []
        assert load_or_create_keys(str(tmp_path / "home" / "keys.json")) == (pub, sec)

    def test_the_default_is_under_the_home_directory(self, monkeypatch):
        monkeypatch.delenv("PCC_NODE_KEYS_FILE", raising=False)
        expected = os.path.join(os.path.expanduser("~"), ".pcc-node", "keys.json")
        assert crypto.default_keys_path() == expected

    @needs_nacl
    def test_a_0_1_x_key_file_is_kept_only_by_an_explicit_move(self, tmp_path, monkeypatch):
        # Verdict 105c, finding 2: a key file in the working directory is never
        # adopted automatically. The operator keeps it by moving it into place.
        work = tmp_path / "checkout"
        work.mkdir()
        monkeypatch.chdir(work)
        legacy_pub, legacy_sec = generate_node_keys()
        _write_pair(LEGACY_KEYS_PATH, legacy_pub, legacy_sec, mode=0o600)
        new_path = tmp_path / "home" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(new_path))

        with pytest.raises(KeyFileError, match="move it into place yourself"):
            load_or_create_keys()
        assert not new_path.exists()
        assert os.path.isfile(LEGACY_KEYS_PATH)  # left as it was

        # The explicit adoption the message describes.
        new_path.parent.mkdir(mode=0o700)
        os.replace(LEGACY_KEYS_PATH, new_path)
        assert load_or_create_keys() == (legacy_pub, legacy_sec)

    @needs_nacl
    def test_a_broken_0_1_x_key_file_stops_the_node_rather_than_minting_a_new_identity(self, tmp_path, monkeypatch):
        work = tmp_path / "checkout"
        work.mkdir()
        monkeypatch.chdir(work)
        (work / LEGACY_KEYS_PATH).write_text("{}")
        new_path = tmp_path / "home" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(new_path))
        with pytest.raises(KeyFileError):
            load_or_create_keys()
        assert not new_path.exists()

    @needs_nacl
    def test_a_file_created_by_another_process_first_is_used(self, tmp_path, monkeypatch):
        path = str(tmp_path / "keys.json")
        theirs = generate_node_keys()
        real_link = os.link
        published = []

        def link(src, dst, **kwargs):
            assert dst == "keys.json" and kwargs.get("dst_dir_fd") is not None
            assert not published, "the competing identity was already published"
            _write_pair(path, *theirs)
            st = os.stat(path)
            published.append((st.st_ino, st.st_size))
            return real_link(src, dst, **kwargs)

        monkeypatch.setattr(crypto.os, "link", link)
        loaded_theirs = load_or_create_keys(path) == theirs
        assert loaded_theirs, "the losing publisher did not load the competing identity"
        assert len(published) == 1, "the exclusive-publication race was not exercised"
        st = os.stat(path)
        assert (st.st_ino, st.st_size) == published[0], "the winning file changed"
        assert os.listdir(tmp_path) == ["keys.json"], "the losing publisher left a temporary file"

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")
    def test_a_pre_pynacl_key_file_is_refused_once_pynacl_is_installed(self, tmp_path):
        secret = os.urandom(32)
        path = str(tmp_path / "keys.json")
        _write_pair(path, hashlib.sha256(secret).hexdigest(), secret.hex())
        with pytest.raises(KeyFileError, match="register the node again"):
            load_or_create_keys(path)

    def test_a_pre_pynacl_key_file_is_refused_without_pynacl(self, tmp_path, monkeypatch):
        monkeypatch.setattr(crypto, "_HAS_NACL", False)
        secret = os.urandom(32)
        path = str(tmp_path / "keys.json")
        _write_pair(path, hashlib.sha256(secret).hexdigest(), secret.hex())
        # #374 requires a real Ed25519 identity for every key operation; a
        # legacy HMAC identity is never loaded when PyNaCl is unavailable.
        with pytest.raises(crypto.CryptoUnavailableError):
            load_or_create_keys(path)
        assert os.path.exists(path)


class TestVerifyFailsClosedWithoutPynacl:
    def test_the_fallback_refuses_rather_than_passes(self, monkeypatch):
        monkeypatch.setattr(crypto, "_HAS_NACL", False)
        assert verify_signature({"a": 1}, "00" * 32, "11" * 32) is False


# ---------------------------------------------------------------------------
# Verdict 105b on #454, findings 5, 6 and 8: the node's trust root. Each of
# these failed at dcb06aea.
# ---------------------------------------------------------------------------


# Without PyNaCl, every key operation is refused first (#374; see
# TestWithoutPyNaClNoKeyIsUsed). Guarded tests create or load a key, which needs PyNaCl.
# CI step 3 runs them with nothing skipped.
@posix_only
class TestKeyFileTrust:
    def _legacy_setup(self, tmp_path, monkeypatch):
        work = tmp_path / "checkout"
        work.mkdir()
        monkeypatch.chdir(work)
        new_path = tmp_path / "home" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(new_path))
        return work, new_path

    @needs_nacl
    def test_a_legacy_key_file_others_could_read_is_locked_down_not_adopted(self, tmp_path, monkeypatch):
        work, new_path = self._legacy_setup(tmp_path, monkeypatch)
        pub, sec = generate_node_keys()
        _write_pair(LEGACY_KEYS_PATH, pub, sec, mode=0o644)
        with pytest.raises(KeyFileError, match="new identity"):
            load_or_create_keys()
        assert not new_path.exists()
        assert (os.stat(LEGACY_KEYS_PATH).st_mode & 0o777) == 0o600  # no longer readable by others

    @needs_nacl
    def test_a_symlinked_legacy_key_file_is_not_adopted(self, tmp_path, monkeypatch):
        work, new_path = self._legacy_setup(tmp_path, monkeypatch)
        planted = tmp_path / "planted.json"
        pub, sec = generate_node_keys()
        _write_pair(planted, pub, sec, mode=0o600)
        os.symlink(planted, work / LEGACY_KEYS_PATH)
        with pytest.raises(KeyFileError, match="symbolic link"):
            load_or_create_keys()
        assert not new_path.exists()

    @needs_nacl
    def test_a_legacy_key_file_in_a_directory_others_can_write_is_not_adopted(self, tmp_path, monkeypatch):
        work, new_path = self._legacy_setup(tmp_path, monkeypatch)
        pub, sec = generate_node_keys()
        _write_pair(LEGACY_KEYS_PATH, pub, sec, mode=0o600)
        os.chmod(work, 0o1777)  # like /tmp: anyone could have planted it
        with pytest.raises(KeyFileError, match="writable by other users"):
            load_or_create_keys()
        assert not new_path.exists()

    @needs_nacl
    def test_a_legacy_key_file_owned_by_another_account_is_not_adopted(self, tmp_path, monkeypatch):
        work, new_path = self._legacy_setup(tmp_path, monkeypatch)
        pub, sec = generate_node_keys()
        _write_pair(LEGACY_KEYS_PATH, pub, sec, mode=0o600)
        real_uid = os.getuid()
        real_stat, real_fstat = os.stat, os.fstat

        def foreign(result):
            fields = list(result)
            fields[4] = real_uid + 1  # st_uid
            return os.stat_result(fields)

        legacy = real_stat(LEGACY_KEYS_PATH)

        def fstat(fd):
            result = real_fstat(fd)
            same = (result.st_dev, result.st_ino) == (legacy.st_dev, legacy.st_ino)
            return foreign(result) if same else result

        monkeypatch.setattr(crypto.os, "fstat", fstat)
        with pytest.raises(KeyFileError, match="owned by another account"):
            load_or_create_keys()
        assert not new_path.exists()

    @needs_nacl
    def test_a_symlink_at_the_key_path_is_refused(self, tmp_path):
        planted = tmp_path / "planted.json"
        pub, sec = generate_node_keys()
        _write_pair(planted, pub, sec, mode=0o600)
        link = tmp_path / "keys.json"
        link.symlink_to(planted)
        with pytest.raises(KeyFileError, match="symbolic link"):
            load_or_create_keys(str(link))

    @needs_nacl
    def test_a_key_directory_others_can_write_is_refused(self, tmp_path):
        shared = tmp_path / "shared"
        shared.mkdir()
        path = shared / "keys.json"
        load_or_create_keys(str(path))
        os.chmod(shared, 0o777)
        with pytest.raises(KeyFileError, match="writable by other users"):
            load_or_create_keys(str(path))

    @needs_nacl
    def test_no_key_is_created_in_a_directory_others_can_write(self, tmp_path):
        shared = tmp_path / "shared"
        shared.mkdir()
        os.chmod(shared, 0o777)
        with pytest.raises(KeyFileError, match="writable by other users"):
            load_or_create_keys(str(shared / "keys.json"))
        assert not (shared / "keys.json").exists()

    @needs_nacl
    def test_a_failed_key_write_leaves_no_partial_key_file(self, tmp_path, monkeypatch):
        path = tmp_path / "node" / "keys.json"
        real_dump = json.dump

        def partial(obj, f, **kwargs):
            f.write('{"public": "')
            raise OSError("disk full")

        monkeypatch.setattr(crypto.json, "dump", partial)
        with pytest.raises(OSError, match="disk full"):
            load_or_create_keys(str(path))
        monkeypatch.setattr(crypto.json, "dump", real_dump)
        assert not path.exists()
        assert os.listdir(path.parent) == []
        pub, sec = load_or_create_keys(str(path))  # the next start creates a whole identity
        assert load_or_create_keys(str(path)) == (pub, sec)


@needs_nacl
class TestAtomicKeyPublication:
    def test_a_complete_key_published_by_another_process_wins_the_link_race(self, tmp_path, monkeypatch):
        directory = _private_dir(tmp_path / "keys")
        path = directory / "keys.json"
        winner = generate_node_keys()
        real_link, real_open, real_dump = os.link, os.open, json.dump
        published = []

        def publish_first(src, dst, *, src_dir_fd=None, dst_dir_fd=None, follow_symlinks=True):
            # Install a complete, separately generated identity at the exact
            # checked destination before this process's exclusive link runs.
            if not published:
                fd = real_open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                               0o600, dir_fd=dst_dir_fd)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    real_dump({"public": winner[0], "secret": winner[1]}, f)
                    f.flush()
                    os.fsync(f.fileno())
                published.append(True)
            return real_link(src, dst, src_dir_fd=src_dir_fd,
                             dst_dir_fd=dst_dir_fd, follow_symlinks=follow_symlinks)

        monkeypatch.setattr(crypto_module.os, "link", publish_first)
        loaded_winner = load_or_create_keys(str(path)) == winner
        assert loaded_winner, "the losing creation replaced or returned a different identity"
        assert published == [True], "the exclusive-publication race was not exercised"
        assert os.listdir(directory) == ["keys.json"], "the losing private temporary file survived"
        reloads_winner = load_or_create_keys(str(path)) == winner
        assert reloads_winner

    def test_a_partial_write_is_not_visible_at_the_final_key_name(self, tmp_path, monkeypatch):
        directory = _private_dir(tmp_path / "keys")
        path = directory / "keys.json"
        partial_writes = []

        def observe_partial_write(obj, f, **kwargs):
            encoded = json.dumps(obj, **kwargs)
            split = len(encoded) // 2
            f.write(encoded[:split])
            f.flush()
            partial_writes.append(True)
            assert not path.exists(), "the final key name exposed an incomplete identity"
            f.write(encoded[split:])

        monkeypatch.setattr(crypto_module.json, "dump", observe_partial_write)
        public, secret = load_or_create_keys(str(path))
        assert partial_writes == [True], "the partial-write visibility check was not exercised"
        assert os.listdir(directory) == ["keys.json"]
        announcement = {"kernelId": "atomic-publication"}
        assert verify_signature(announcement, sign_announcement(announcement, secret), public)
        reloads_created_pair = load_or_create_keys(str(path)) == (public, secret)
        assert reloads_created_pair


# ---------------------------------------------------------------------------
# E17b finding 1: the descriptor walk checks every ancestor's ownership/mode,
# including the selected real directory's chain when selection uses symlinks.
# ---------------------------------------------------------------------------

@pytest.fixture
def _e17b_checked_test_namespace(monkeypatch, tmp_path):
    """One ordinary filesystem with a controlled, secure host ancestor chain.

    The sandbox maps system-directory owners to nobody and bind-mounts the WT.
    Normalize only preexisting ancestors ABOVE this test's tmp_path to root
    ownership where needed, keeping their modes/inodes and actual descriptor
    walk. Suppress only the host WT and its preexisting tmp/.git entries,
    never a fixture-created one.
    This makes the fixture a deterministic filesystem namespace: the checkout,
    ownership, alias and mount guards still run, and fixture metadata is not
    changed. Existing tests use the real host namespace without this fixture.
    """
    real_fstat = os.fstat
    real_stat = os.stat
    euid = os.geteuid()
    mapped_host_ids = set()
    for parent in tmp_path.parents:
        st = real_stat(parent)
        if st.st_uid not in (0, euid):
            mapped_host_ids.add((st.st_dev, st.st_ino))
    checkout = Path(crypto_module.__file__).resolve().parents[3]
    host_checkout_ids = set()
    for host_directory in (checkout, checkout / "tmp"):
        if host_directory in tmp_path.parents:
            st = real_stat(host_directory)
            host_checkout_ids.add((st.st_dev, st.st_ino))

    def fstat_in_test_namespace(fd):
        st = real_fstat(fd)
        if stat.S_ISDIR(st.st_mode) and (st.st_dev, st.st_ino) in mapped_host_ids:
            values = list(st)
            values[4] = 0  # st_uid: root in the simulated host namespace
            return os.stat_result(values)
        return st

    def stat_in_test_namespace(path, *, dir_fd=None, follow_symlinks=True):
        if path == ".git" and dir_fd is not None:
            held = real_fstat(dir_fd)
            if (held.st_dev, held.st_ino) in host_checkout_ids:
                raise FileNotFoundError(errno.ENOENT, "host checkout is outside test namespace", path)
        return real_stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)

    mount = {
        "id": "e17b-ordinary-filesystem", "devno": "0:374", "root": "/", "mountpoint": "/",
        "fstype": "ext4", "source": "/dev/e17b-test", "super": "rw",
    }
    monkeypatch.setattr(crypto_module.os, "fstat", fstat_in_test_namespace)
    monkeypatch.setattr(crypto_module.os, "stat", stat_in_test_namespace)
    monkeypatch.setattr(crypto_module, "_mount_of", lambda fd: mount)
    monkeypatch.setattr(crypto_module, "_mountinfo", lambda: [mount])


def _e17b_directory_metadata(monkeypatch, directory, *, owner, mode):
    """Change only one real directory inode's metadata on held descriptors."""
    st = os.stat(directory)
    directory_id = (st.st_dev, st.st_ino)
    real_fstat = os.fstat
    inspected = []

    def fstat_with_directory_metadata(fd):
        st = real_fstat(fd)
        if (st.st_dev, st.st_ino) == directory_id:
            inspected.append(fd)
            values = list(st)
            values[0] = stat.S_IFDIR | mode
            values[4] = owner
            return os.stat_result(values)
        return st

    monkeypatch.setattr(crypto_module.os, "fstat", fstat_with_directory_metadata)
    return inspected


@needs_nacl
class TestE17bSecureAncestorChain:
    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_an_unsafe_root_at_the_top_of_the_walk_is_refused(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, existing
    ):
        target = _private_dir(tmp_path / "private") / "keys.json"
        if existing:
            load_or_create_keys(str(target))
        inspected = _e17b_directory_metadata(monkeypatch, Path("/"), owner=0, mode=0o777)
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(target))
        assert str(refused.value).startswith("/ is writable by other users (mode 777)")
        assert inspected, "the root's held descriptor was not inspected"
        assert target.exists() == existing

    @pytest.mark.parametrize("depth", [1, 2, 3], ids=["depth-1", "depth-2", "depth-3"])
    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_a_foreign_owned_0755_ancestor_is_refused(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, existing, depth
    ):
        ancestor = _private_dir(tmp_path / "foreign-ancestor")
        directory = ancestor
        for component in ("a", "b")[:depth - 1]:
            directory = _private_dir(directory / component)
        target = _private_dir(directory / "private") / "keys.json"
        if existing:
            _new_key_pair_file(target)
        inspected = _e17b_directory_metadata(
            monkeypatch, ancestor, owner=os.geteuid() + 1, mode=0o755
        )
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(target))
        assert str(ancestor) in str(refused.value)
        assert re.search(r"owner|owned", str(refused.value))
        assert inspected, "the ancestor's held descriptor was not inspected"
        assert target.exists() == existing

    @pytest.mark.parametrize("depth", [1, 2, 3], ids=["depth-1", "depth-2", "depth-3"])
    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_a_group_writable_ancestor_is_refused(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, existing, depth
    ):
        ancestor = _private_dir(tmp_path / "group-writable-ancestor")
        directory = ancestor
        for component in ("a", "b")[:depth - 1]:
            directory = _private_dir(directory / component)
        target = _private_dir(directory / "private") / "keys.json"
        if existing:
            _new_key_pair_file(target)
        inspected = _e17b_directory_metadata(
            monkeypatch, ancestor, owner=os.geteuid(), mode=0o770
        )
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(target))
        assert str(ancestor) in str(refused.value)
        assert "writable by other users" in str(refused.value)
        assert inspected, "the ancestor's held descriptor was not inspected"
        assert target.exists() == existing

    def test_a_root_owned_sticky_1777_ancestor_is_allowed(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        ancestor = _private_dir(tmp_path / "root-sticky")
        directory = _private_dir(ancestor / "private")
        inspected = _e17b_directory_metadata(monkeypatch, ancestor, owner=0, mode=0o1777)
        fd = os.open(directory, crypto_module._directory_flags())
        try:
            crypto_module._refuse_checkout(fd, str(directory / "keys.json"))
        finally:
            os.close(fd)
        assert inspected, "the root-owned sticky ancestor was not inspected"
        assert list(directory.iterdir()) == []

    def test_sticky_does_not_exempt_a_non_root_writable_ancestor(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        ancestor = _private_dir(tmp_path / "non-root-sticky")
        directory = _private_dir(ancestor / "private")
        _e17b_directory_metadata(monkeypatch, ancestor, owner=os.geteuid(), mode=0o1777)
        fd = os.open(directory, crypto_module._directory_flags())
        try:
            with pytest.raises(crypto_module.KeyFileError, match="writable by other users"):
                crypto_module._refuse_checkout(fd, str(directory / "keys.json"))
        finally:
            os.close(fd)

    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_a_foreign_ancestor_cannot_relocate_the_key_directory_during_the_walk(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, existing
    ):
        ancestor = _private_dir(tmp_path / "foreign-ancestor")
        directory = _private_dir(ancestor / "private")
        target = directory / "keys.json"
        if existing:
            _new_key_pair_file(target)
        checkout = _private_dir(tmp_path / "attacker-checkout")
        (checkout / ".git").mkdir()
        moved = checkout / "private"
        directory_st = os.stat(directory)
        directory_id = (directory_st.st_dev, directory_st.st_ino)
        ancestor_st = os.stat(ancestor)
        ancestor_id = (ancestor_st.st_dev, ancestor_st.st_ino)
        real_open = os.open
        real_fstat = os.fstat
        renamed = []
        walked_past_foreign_ancestor = []

        def open_then_relocate(path, flags, mode=0o777, *, dir_fd=None):
            current_id = None
            if path == ".." and dir_fd is not None:
                current = real_fstat(dir_fd)
                current_id = (current.st_dev, current.st_ino)
                if current_id == ancestor_id:
                    walked_past_foreign_ancestor.append(True)
            fd = real_open(path, flags, mode, dir_fd=dir_fd)
            if current_id == directory_id and not renamed:
                # The old parent descriptor is already open. The attacker's
                # rename makes the pathname's current chain enter a checkout.
                directory.rename(moved)
                renamed.append(True)
            return fd

        _e17b_directory_metadata(monkeypatch, ancestor, owner=os.geteuid() + 1, mode=0o755)
        monkeypatch.setattr(crypto_module.os, "open", open_then_relocate)
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(target))
        assert renamed, "the deterministic foreign-owner relocation did not happen"
        assert str(ancestor) in str(refused.value)
        assert re.search(r"owner|owned", str(refused.value))
        assert not walked_past_foreign_ancestor, "the walk continued above an unsafe ancestor"
        assert not directory.exists()
        assert (moved / "keys.json").exists() == existing

    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_a_symlink_below_a_foreign_lexical_ancestor_selects_the_safe_real_directory(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, existing
    ):
        lexical = _private_dir(tmp_path / "foreign-lexical")
        safe = _private_dir(tmp_path / "safe-real")
        alias = lexical / "selected"
        alias.symlink_to(safe, target_is_directory=True)
        target = safe / "keys.json"
        original = _new_key_pair_file(target) if existing else None
        inspected = _e17b_directory_metadata(
            monkeypatch, lexical, owner=os.geteuid() + 1, mode=0o755
        )
        selected_pair = load_or_create_keys(str(alias / "keys.json"))
        same_identity = original is None or selected_pair == original
        assert same_identity, "loading through the symlink selected a different identity"
        assert target.exists()
        assert not inspected, "the walk followed lexical ancestry instead of the held directory"

    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_a_symlink_under_safe_lexical_ancestry_cannot_hide_a_foreign_real_ancestor(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, existing
    ):
        foreign = _private_dir(tmp_path / "foreign-real")
        directory = _private_dir(foreign / "private")
        target = directory / "keys.json"
        if existing:
            _new_key_pair_file(target)
        lexical = _private_dir(tmp_path / "safe-lexical")
        alias = lexical / "selected"
        alias.symlink_to(directory, target_is_directory=True)
        inspected = _e17b_directory_metadata(
            monkeypatch, foreign, owner=os.geteuid() + 1, mode=0o755
        )
        with pytest.raises(crypto_module.KeyFileError) as refused:
            load_or_create_keys(str(alias / "keys.json"))
        assert str(foreign) in str(refused.value)
        assert re.search(r"owner|owned", str(refused.value))
        assert inspected, "the selected real ancestor was not inspected"
        assert target.exists() == existing


@needs_nacl
class TestE17bPersistentExposure:
    @pytest.mark.parametrize("route", ["argument", "PCC_NODE_KEY_PATH", "PCC_NODE_KEYS_FILE"])
    @pytest.mark.parametrize("mode", [0o604, 0o620, 0o644, 0o666])
    def test_exposure_is_refused_on_three_consecutive_starts(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, mode, route
    ):
        target = tmp_path / "keys.json"
        public, secret = load_or_create_keys(str(target))
        if route == "argument":
            load = lambda: load_or_create_keys(str(target))
        else:
            monkeypatch.setenv(route, str(target))
            load = load_or_create_keys
        os.chmod(target, mode)
        marker = target.with_name(target.name + ".exposed")
        for attempt in range(3):
            with pytest.raises(KeyFileError, match="identity is compromised") as refused:
                load()
            assert str(target) in str(refused.value)
            assert str(marker) in str(refused.value)
            assert "re-registration" in str(refused.value)
            assert stat.S_IMODE(target.stat().st_mode) == 0o600
            assert stat.S_IMODE(marker.stat().st_mode) == 0o600
            record = json.loads(marker.read_text())
            assert set(record) == {"utc", "reason"}
            assert record["utc"].endswith("+00:00")
            assert "mode" in record["reason"]
            leaked_key = public in marker.read_text() or secret in marker.read_text()
            assert not leaked_key, "an exposure record contained key material"
            if attempt == 0:
                first_record = marker.read_bytes()
            assert marker.read_bytes() == first_record, "a retained marker was replaced"

    def test_a_concurrent_marker_is_rechecked_before_returning_the_identity(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        original = target.read_bytes()
        os.chmod(target, 0o644)
        marker = target.with_name(target.name + ".exposed")
        real_judge = crypto_module._judge_key_file
        judged = []

        def mark_and_restrict_before_judging(fd, key_path, legacy=False):
            if not judged:
                # Another detector acts after this load's marker checks but
                # before its first fstat. Only the terminal re-check sees it.
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                marker_fd = os.open(marker, flags, 0o600)
                with os.fdopen(marker_fd, "w", encoding="utf-8") as f:
                    f.write("concurrent detector recorded exposure\n")
                    f.flush()
                    os.fsync(f.fileno())
                directory_fd = os.open(tmp_path, crypto_module._directory_flags())
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                os.chmod(target, 0o600)
            judged.append(key_path)
            return real_judge(fd, key_path, legacy=legacy)

        monkeypatch.setattr(crypto_module, "_judge_key_file", mark_and_restrict_before_judging)
        with pytest.raises(KeyFileError, match="identity is compromised") as refused:
            load_or_create_keys(str(target))
        assert str(target) in str(refused.value)
        assert str(marker) in str(refused.value)
        assert judged == [str(target)], "the terminal marker check must refuse before judging again"
        unchanged = target.read_bytes() == original
        assert unchanged, "the concurrent exposure refusal changed the key's contents"
        assert stat.S_IMODE(target.stat().st_mode) == 0o600

    def test_the_marker_is_durable_in_the_verified_directory_before_chmod(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        os.chmod(target, 0o644)
        marker = target.with_name(target.name + ".exposed")
        directory_st, key_st = tmp_path.stat(), target.stat()
        real_open, real_dump = os.open, json.dump
        real_fsync, real_fchmod, real_fstat = os.fsync, os.fchmod, os.fstat
        events = []
        marker_ids = []

        def identity(st):
            return st.st_dev, st.st_ino

        def observe_open(path, flags, mode=0o777, *, dir_fd=None):
            if str(path).endswith(".exposed"):
                assert path == marker.name
                assert identity(real_fstat(dir_fd)) == identity(directory_st)
                assert flags & os.O_EXCL and flags & os.O_CREAT and flags & os.O_NOFOLLOW
                assert mode == 0o600
                assert stat.S_IMODE(target.stat().st_mode) == 0o644
                events.append("marker-open")
                fd = real_open(path, flags, mode, dir_fd=dir_fd)
                marker_ids.append(identity(real_fstat(fd)))
                return fd
            return real_open(path, flags, mode, dir_fd=dir_fd)

        def observe_dump(record, f, **kwargs):
            assert identity(real_fstat(f.fileno())) == marker_ids[0]
            assert set(record) == {"utc", "reason"}
            assert stat.S_IMODE(target.stat().st_mode) == 0o644
            real_dump(record, f, **kwargs)
            events.append("record-write")

        def observe_sync(fd):
            held = identity(real_fstat(fd))
            if held == marker_ids[0]:
                assert set(json.loads(marker.read_text())) == {"utc", "reason"}
                events.append("file-fsync")
            else:
                assert held == identity(directory_st)
                events.append("dir-fsync")
            assert stat.S_IMODE(target.stat().st_mode) == 0o644
            real_fsync(fd)

        def observe_chmod(fd, mode):
            assert identity(real_fstat(fd)) == identity(key_st)
            assert events == ["marker-open", "record-write", "file-fsync", "dir-fsync"]
            assert mode == 0o600
            events.append("key-chmod")
            real_fchmod(fd, mode)

        monkeypatch.setattr(crypto_module.os, "open", observe_open)
        monkeypatch.setattr(crypto_module.json, "dump", observe_dump)
        monkeypatch.setattr(crypto_module.os, "fsync", observe_sync)
        monkeypatch.setattr(crypto_module.os, "fchmod", observe_chmod)
        with pytest.raises(KeyFileError, match="identity is compromised"):
            load_or_create_keys(str(target))
        assert events == ["marker-open", "record-write", "file-fsync", "dir-fsync", "key-chmod"]
        assert stat.S_IMODE(target.stat().st_mode) == 0o600

    def test_an_operator_chmod_cannot_clear_the_marker_refusal(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        os.chmod(target, 0o644)
        with pytest.raises(KeyFileError, match="identity is compromised"):
            load_or_create_keys(str(target))
        os.chmod(target, 0o600)

        def no_key_open_or_create(*args, **kwargs):
            pytest.fail("a marker must refuse before opening or creating a key")

        real_open = os.open

        def open_without_key(path, flags, mode=0o777, *, dir_fd=None):
            if path == target.name:
                no_key_open_or_create()
            return real_open(path, flags, mode, dir_fd=dir_fd)

        monkeypatch.setattr(crypto_module.os, "open", open_without_key)
        monkeypatch.setattr(crypto_module, "_create_key_file", no_key_open_or_create)
        for _ in range(2):
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys(str(target))

    def test_a_retained_writer_cannot_make_an_exposed_identity_acceptable(
        self, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        os.chmod(target, 0o666)
        writer = os.open(target, os.O_WRONLY)
        try:
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys(str(target))
            assert stat.S_IMODE(target.stat().st_mode) == 0o600
            replacement = generate_node_keys()
            data = json.dumps({"public": replacement[0], "secret": replacement[1]}).encode()
            assert os.pwrite(writer, data, 0) == len(data)
            os.ftruncate(writer, len(data))
            os.fsync(writer)
            for _ in range(2):
                with pytest.raises(KeyFileError, match="identity is compromised"):
                    load_or_create_keys(str(target))
        finally:
            os.close(writer)

    def test_both_files_must_be_retired_before_a_new_identity_is_created(
        self, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        public, _ = load_or_create_keys(str(target))
        os.chmod(target, 0o644)
        with pytest.raises(KeyFileError, match="identity is compromised"):
            load_or_create_keys(str(target))
        marker = target.with_name(target.name + ".exposed")
        retired = _private_dir(tmp_path / "retired")
        target.rename(retired / target.name)
        with pytest.raises(KeyFileError, match="identity is compromised"):
            load_or_create_keys(str(target))
        assert not target.exists(), "a marker alone must prevent automatic rotation"
        marker.rename(retired / marker.name)
        new_public, _ = load_or_create_keys(str(target))
        assert new_public != public
        assert not marker.exists()

    def test_a_foreign_owned_key_is_restricted_and_persistently_refused(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        key_st = target.stat()
        real_fstat = os.fstat
        foreign = [True]

        def fstat(fd):
            st = real_fstat(fd)
            if foreign[0] and (st.st_dev, st.st_ino) == (key_st.st_dev, key_st.st_ino):
                values = list(st)
                values[4] = os.geteuid() + 1
                return os.stat_result(values)
            return st

        monkeypatch.setattr(crypto_module.os, "fstat", fstat)
        with pytest.raises(KeyFileError, match="owned by another account"):
            load_or_create_keys(str(target))
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
        foreign[0] = False
        for _ in range(2):
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys(str(target))

    def test_a_marker_refuses_exclusive_creation_and_leaves_only_the_marker(
        self, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        marker = target.with_name(target.name + ".exposed")
        marker.write_text("retired exposure\n")
        os.chmod(marker, 0o600)
        with pytest.raises(KeyFileError, match="identity is compromised"):
            crypto_module._create_exclusive(str(target), *generate_node_keys())
        assert set(tmp_path.iterdir()) == {marker}

    @pytest.mark.parametrize("foreign", [False, True], ids=["wide-mode", "foreign-owner"])
    def test_a_failed_marker_open_preserves_exposure_and_every_retry_refuses(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, foreign
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        os.chmod(target, 0o644)
        if foreign:
            key_st = target.stat()
            real_fstat = os.fstat

            def foreign_fstat(fd):
                st = real_fstat(fd)
                if (st.st_dev, st.st_ino) == (key_st.st_dev, key_st.st_ino):
                    values = list(st)
                    values[4] = os.geteuid() + 1
                    return os.stat_result(values)
                return st

            monkeypatch.setattr(crypto_module.os, "fstat", foreign_fstat)
        real_open = os.open

        def open_without_marker(path, flags, mode=0o777, *, dir_fd=None):
            if str(path).endswith(".exposed"):
                raise OSError(errno.EIO, "injected marker creation failure")
            return real_open(path, flags, mode, dir_fd=dir_fd)

        monkeypatch.setattr(crypto_module.os, "open", open_without_marker)
        def no_chmod(*args):
            pytest.fail("marker creation failure must never change the key's mode")

        monkeypatch.setattr(crypto_module.os, "fchmod", no_chmod)
        for _ in range(3):
            with pytest.raises(KeyFileError, match="mode was left unchanged") as refused:
                load_or_create_keys(str(target))
            reason = "owned by another account" if foreign else "mode 644"
            assert reason in str(refused.value), "the unchanged exposure was not detected again"
            assert stat.S_IMODE(target.stat().st_mode) == 0o644
        assert not target.with_name(target.name + ".exposed").exists()

    @pytest.mark.parametrize("failure", ["write", "file-sync", "directory-sync", "unsupported-directory-sync"])
    def test_failed_marker_persistence_preserves_mode_and_refuses_every_retry(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, failure
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        os.chmod(target, 0o644)

        real_sync = os.fsync

        def fail_sync(fd):
            directory = stat.S_ISDIR(os.fstat(fd).st_mode)
            should_fail = directory if "directory" in failure else not directory
            if should_fail:
                code = errno.EINVAL if failure == "unsupported-directory-sync" else errno.EIO
                raise OSError(code, "injected marker sync failure")
            real_sync(fd)

        def fail_write(record, f, **kwargs):
            f.write('{"utc":')
            raise OSError(errno.EIO, "injected marker write failure")

        def no_chmod(*args):
            pytest.fail("marker persistence failure must never change the key's mode")

        monkeypatch.setattr(crypto_module.os, "fchmod", no_chmod)
        if failure == "write":
            monkeypatch.setattr(crypto_module.json, "dump", fail_write)
        else:
            monkeypatch.setattr(crypto_module.os, "fsync", fail_sync)
        with pytest.raises(KeyFileError, match="Exposure marker could not be persisted"):
            load_or_create_keys(str(target))
        marker = target.with_name(target.name + ".exposed")
        assert marker.exists()
        assert stat.S_IMODE(marker.stat().st_mode) == 0o600
        assert stat.S_IMODE(target.stat().st_mode) == 0o644
        for _ in range(2):
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys(str(target))
        # Model a non-durable marker lost across a crash: the unchanged key
        # exposure must still refuse, rather than accepting the old identity.
        marker.unlink()
        with pytest.raises(KeyFileError, match="Exposure marker could not be persisted"):
            load_or_create_keys(str(target))
        assert stat.S_IMODE(target.stat().st_mode) == 0o644

    def test_a_durable_marker_keeps_refusing_when_chmod_fails(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        os.chmod(target, 0o644)
        marker = target.with_name(target.name + ".exposed")
        real_sync = os.fsync
        syncs = []

        def observe_sync(fd):
            real_sync(fd)
            syncs.append("directory" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")

        def fail_chmod(fd, mode):
            assert syncs == ["file", "directory"]
            assert mode == 0o600
            raise OSError(errno.EIO, "injected chmod failure")

        monkeypatch.setattr(crypto_module.os, "fsync", observe_sync)
        monkeypatch.setattr(crypto_module.os, "fchmod", fail_chmod)
        with pytest.raises(KeyFileError, match="marker is durable.*cannot be restricted to 0600"):
            load_or_create_keys(str(target))
        assert stat.S_IMODE(target.stat().st_mode) == 0o644
        assert set(json.loads(marker.read_text())) == {"utc", "reason"}
        for _ in range(2):
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys(str(target))
        assert syncs == ["file", "directory"]

    def test_a_competing_marker_never_allows_chmod_before_its_durability_is_known(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        target = tmp_path / "keys.json"
        load_or_create_keys(str(target))
        os.chmod(target, 0o644)
        marker = target.with_name(target.name + ".exposed")
        real_open = os.open
        competed = []

        def create_competing_marker(path, flags, mode=0o777, *, dir_fd=None):
            if path == marker.name and not competed:
                fd = real_open(path, flags, mode, dir_fd=dir_fd)
                os.close(fd)
                competed.append(True)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        def no_chmod(*args):
            pytest.fail("an existing marker's durability is unknown; its key mode must stay unchanged")

        monkeypatch.setattr(crypto_module.os, "open", create_competing_marker)
        monkeypatch.setattr(crypto_module.os, "fchmod", no_chmod)
        for _ in range(3):
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys(str(target))
        assert competed == [True]
        assert marker.exists()
        assert stat.S_IMODE(target.stat().st_mode) == 0o644

    def test_an_exposed_legacy_file_refuses_until_both_files_are_retired(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        work = _private_dir(tmp_path / "work")
        monkeypatch.chdir(work)
        selected = tmp_path / "new-home" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(selected))
        legacy = work / LEGACY_KEYS_PATH
        public, secret = generate_node_keys()
        _write_pair(legacy, public, secret, mode=0o644)
        marker = legacy.with_name(legacy.name + ".exposed")
        for _ in range(3):
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys()
            assert stat.S_IMODE(legacy.stat().st_mode) == 0o600
            assert marker.exists()
            assert not selected.exists()
        retired = _private_dir(tmp_path / "retired")
        legacy.rename(retired / legacy.name)
        with pytest.raises(KeyFileError, match="identity is compromised"):
            load_or_create_keys()
        assert not selected.exists(), "a retained legacy marker must prevent creation"
        marker.rename(retired / marker.name)
        new_public, _ = load_or_create_keys()
        assert new_public != public

    def test_a_competitors_exposed_key_is_refused_on_reuse_and_subsequent_starts(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        directory = _private_dir(tmp_path / "keys")
        target = directory / "keys.json"
        winner = generate_node_keys()
        real_link, real_open = os.link, os.open
        published = []

        def publish_first(src, dst, *, src_dir_fd=None, dst_dir_fd=None, follow_symlinks=True):
            if not published:
                fd = real_open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                               0o600, dir_fd=dst_dir_fd)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump({"public": winner[0], "secret": winner[1]}, f)
                    f.flush()
                    os.fsync(f.fileno())
                    os.fchmod(f.fileno(), 0o644)
                published.append(True)
            return real_link(src, dst, src_dir_fd=src_dir_fd,
                             dst_dir_fd=dst_dir_fd, follow_symlinks=follow_symlinks)

        monkeypatch.setattr(crypto_module.os, "link", publish_first)
        for _ in range(3):
            with pytest.raises(KeyFileError, match="identity is compromised"):
                load_or_create_keys(str(target))
            assert stat.S_IMODE(target.stat().st_mode) == 0o600
            assert set(p.name for p in directory.iterdir()) == {"keys.json", "keys.json.exposed"}
        assert published == [True], "the competing creator reuse path was not exercised"
        retained = json.loads(target.read_text())
        assert (retained["public"], retained["secret"]) == winner, "the competitor's key was changed"


@needs_nacl
class TestE17bUnavailableMountDiscovery:
    @pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
    def test_unknown_mount_refuses_without_reading_or_writing(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace, existing
    ):
        directory = _private_dir(tmp_path / "keys")
        target = directory / "keys.json"
        if existing:
            _new_key_pair_file(target)
        before = target.read_bytes() if existing else None
        monkeypatch.setattr(crypto_module, "_mount_of", lambda fd: None)

        def unexpected(*args, **kwargs):
            pytest.fail("a key read or write was attempted without mount discovery")

        monkeypatch.setattr(crypto_module, "_read_key_file", unexpected)
        monkeypatch.setattr(crypto_module, "_create_key_file", unexpected)
        with pytest.raises(KeyFileError, match="without usable Linux mount discovery"):
            load_or_create_keys(str(target))
        assert target.exists() == existing
        assert set(directory.iterdir()) == ({target} if existing else set())
        if existing:
            assert target.read_bytes() == before

    def test_unknown_mount_refuses_before_creating_missing_directories(
        self, monkeypatch, tmp_path, _e17b_checked_test_namespace
    ):
        monkeypatch.setattr(crypto_module, "_mount_of", lambda fd: None)
        with pytest.raises(KeyFileError, match="Linux mount discovery"):
            load_or_create_keys(str(tmp_path / "missing" / "keys.json"))
        assert not (tmp_path / "missing").exists()

    def test_unknown_mount_is_never_a_whole_filesystem(self):
        assert crypto_module._whole_filesystem(None) is False

    @pytest.mark.parametrize("alias_check", ["_refuse_aliases", "_refuse_file_aliases"])
    def test_alias_checks_never_skip_unknown_mounts(self, monkeypatch, tmp_path, alias_check):
        target = tmp_path / "synthetic-file"
        target.write_text("not a key")
        fd = os.open(target if alias_check == "_refuse_file_aliases" else tmp_path, os.O_RDONLY)
        try:
            monkeypatch.setattr(crypto_module, "_LINUX", False)
            with pytest.raises(KeyFileError, match="Linux mount discovery"):
                getattr(crypto_module, alias_check)(fd, str(target))
        finally:
            os.close(fd)


class TestE17bCleanupWarning:
    def test_unknown_link_count_does_not_hide_a_failed_scrub_warning(self, monkeypatch, tmp_path):
        directory = _private_dir(tmp_path / "cleanup")
        target = directory / "synthetic-file"
        target.write_bytes(b"synthetic data, no key material")
        dir_fd = os.open(directory, crypto_module._directory_flags())
        fd = os.open(target, os.O_RDWR)
        real_unlink = os.unlink
        real_fstat = os.fstat
        unlinked = []

        def fail(*args, **kwargs):
            raise OSError(errno.EIO, "injected scrub failure")

        def unlink(name, *, dir_fd=None):
            real_unlink(name, dir_fd=dir_fd)
            unlinked.append(True)

        def fstat(held):
            if held == fd and unlinked:
                raise OSError(errno.EIO, "injected warning metadata failure")
            return real_fstat(held)

        monkeypatch.setattr(crypto_module.os, "ftruncate", fail)
        monkeypatch.setattr(crypto_module.os, "pwrite", fail)
        monkeypatch.setattr(crypto_module.os, "unlink", unlink)
        monkeypatch.setattr(crypto_module.os, "fstat", fstat)
        try:
            with pytest.raises(KeyFileError, match="THE SECRET MAY REMAIN.*unknown"):
                crypto_module._scrub_and_remove(dir_fd, target.name, fd, str(target), str(target), None)
            assert unlinked
            assert not target.exists()
        finally:
            os.close(fd)
            os.close(dir_fd)
