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
