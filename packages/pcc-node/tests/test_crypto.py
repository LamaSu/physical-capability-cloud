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
# N35b: verification fails closed; no key file inside the checkout
# ---------------------------------------------------------------------------

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

needs_nacl = pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")


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
        _, sec = generate_node_keys()
        for not_a_dict in (None, [1], "a", 1):
            with pytest.raises(TypeError):
                sign_announcement(not_a_dict, sec)

    def test_values_json_cannot_hold_are_refused(self):
        _, sec = generate_node_keys()
        with pytest.raises(ValueError):
            sign_announcement({"x": float("nan")}, sec)

    def test_a_malformed_secret_is_refused(self):
        _, sec = generate_node_keys()
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
    def test_a_denylisted_key_spelled_with_whitespace_is_still_refused(self, monkeypatch, tmp_path):
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

    def test_keys_that_are_not_exact_hex_are_refused(self, tmp_path):
        pub, sec = generate_node_keys()
        for public, secret in ((" " + pub, sec), (pub, sec + "\n"), (pub, None)):
            path = _write_key_file(tmp_path / "keys.json", public, secret)
            with pytest.raises(crypto_module.KeyFileError):
                load_or_create_keys(path)


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

    def test_a_dotfiles_repository_at_home_does_not_block_the_default(self, monkeypatch, tmp_path):
        home = tmp_path / "home"
        (home / ".git").mkdir(parents=True)
        monkeypatch.setenv("HOME", str(home))
        load_or_create_keys()
        assert (home / ".pcc-node" / "keys.json").exists()
