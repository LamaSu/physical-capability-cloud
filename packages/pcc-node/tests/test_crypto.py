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
# Key file safety (ADK track item 9): never the working directory, owner-only,
# a matching pair, and a 0.1.x key file adopted instead of a new identity.
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


class TestKeyFileSafety:
    @posix_only
    def test_a_new_key_file_is_owner_only_in_a_private_directory(self, tmp_path):
        path = tmp_path / "node" / "keys.json"
        load_or_create_keys(str(path))
        assert (os.stat(path).st_mode & 0o777) == 0o600
        assert (os.stat(path.parent).st_mode & 0o777) == 0o700

    @posix_only
    def test_a_key_file_others_can_read_is_refused(self, tmp_path):
        path = str(tmp_path / "keys.json")
        load_or_create_keys(path)
        os.chmod(path, 0o644)
        with pytest.raises(KeyFileError, match="chmod 600"):
            load_or_create_keys(path)

    def test_a_mismatched_pair_is_refused(self, tmp_path):
        pub, _sec = generate_node_keys()
        _other_pub, other_sec = generate_node_keys()
        path = str(tmp_path / "keys.json")
        _write_pair(path, pub, other_sec)
        with pytest.raises(KeyFileError, match="does not belong"):
            load_or_create_keys(path)

    def test_a_file_that_is_not_a_key_pair_is_refused(self, tmp_path):
        for text in ("not json", "{}", '{"public": "zz", "secret": "zz"}', '{"public": "00", "secret": "00"}'):
            path = tmp_path / "keys.json"
            path.write_text(text)
            os.chmod(path, 0o600)
            with pytest.raises(KeyFileError):
                load_or_create_keys(str(path))

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

    def test_a_0_1_x_key_file_is_adopted_not_replaced(self, tmp_path, monkeypatch, caplog):
        work = tmp_path / "checkout"
        work.mkdir()
        monkeypatch.chdir(work)
        legacy_pub, legacy_sec = generate_node_keys()
        _write_pair(LEGACY_KEYS_PATH, legacy_pub, legacy_sec, mode=0o644)
        new_path = tmp_path / "home" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEYS_FILE", str(new_path))

        with caplog.at_level(logging.WARNING, logger="pcc-node.crypto"):
            assert load_or_create_keys() == (legacy_pub, legacy_sec)
        assert "delete it once the node runs" in caplog.text
        assert os.path.isfile(LEGACY_KEYS_PATH)  # left for the operator to delete
        if os.name != "nt":
            assert (os.stat(new_path).st_mode & 0o777) == 0o600

        os.remove(LEGACY_KEYS_PATH)
        assert load_or_create_keys() == (legacy_pub, legacy_sec)

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

    def test_a_file_created_by_another_process_first_is_used(self, tmp_path, monkeypatch):
        path = str(tmp_path / "keys.json")
        theirs = load_or_create_keys(path)
        real_exists = os.path.exists
        monkeypatch.setattr(crypto.os.path, "exists", lambda p: False if p == path else real_exists(p))
        assert load_or_create_keys(path) == theirs

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl not installed")
    def test_a_pre_pynacl_key_file_still_loads_with_a_warning(self, tmp_path, caplog):
        secret = os.urandom(32)
        path = str(tmp_path / "keys.json")
        _write_pair(path, hashlib.sha256(secret).hexdigest(), secret.hex())
        with caplog.at_level(logging.WARNING, logger="pcc-node.crypto"):
            assert load_or_create_keys(path) == (hashlib.sha256(secret).hexdigest(), secret.hex())
        assert "not an Ed25519 key" in caplog.text


class TestVerifyFailsClosedWithoutPynacl:
    def test_the_fallback_refuses_rather_than_passes(self, monkeypatch):
        monkeypatch.setattr(crypto, "_HAS_NACL", False)
        assert verify_signature({"a": 1}, "00" * 32, "11" * 32) is False
