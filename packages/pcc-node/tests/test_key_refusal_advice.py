"""Location refusals tell callers how to select a usable signing-key path."""

import os

import pytest

from pcc_node import crypto
from .test_crypto import _e17b_checked_test_namespace  # noqa: F401


LOCATION_ADVICE = (
    "Use the default ~/.pcc-node/keys.json, or set PCC_NODE_KEY_PATH to a path "
    "outside every source checkout."
)

needs_nacl = pytest.mark.skipif(not crypto._HAS_NACL, reason="pynacl not installed")


@pytest.fixture(autouse=True)
def _no_key_path_override(monkeypatch):
    monkeypatch.delenv("PCC_NODE_KEY_PATH", raising=False)
    monkeypatch.delenv("PCC_NODE_KEYS_FILE", raising=False)


@needs_nacl
@pytest.mark.parametrize("route", ["path-argument", "PCC_NODE_KEY_PATH", "PCC_NODE_KEYS_FILE"])
@pytest.mark.parametrize("existing", [False, True], ids=["create", "load"])
def test_checkout_refusal_names_default_and_env_before_key_access(
    monkeypatch, tmp_path, _e17b_checked_test_namespace, route, existing
):
    checkout = tmp_path / "checkout"
    checkout.mkdir(mode=0o700)
    (checkout / ".git").mkdir()
    key_path = checkout / "keys.json"
    if existing:
        # An invalid fixture file makes any attempted parse fail differently.
        key_path.write_text("must not be read")
        key_path.chmod(0o600)
    if route != "path-argument":
        monkeypatch.setenv(route, str(key_path))
    monkeypatch.chdir(tmp_path)

    def key_access_forbidden(*args, **kwargs):
        pytest.fail("the location refusal must precede key access")

    monkeypatch.setattr(crypto, "_read_key_file", key_access_forbidden)
    monkeypatch.setattr(crypto, "_create_key_file", key_access_forbidden)
    with pytest.raises(crypto.KeyFileError, match="inside a source checkout") as refused:
        crypto.load_or_create_keys(str(key_path) if route == "path-argument" else None)

    assert LOCATION_ADVICE in str(refused.value)
    if route == "path-argument":
        assert "change that argument or omit it" in str(refused.value)
    assert key_path.exists() is existing


@needs_nacl
@pytest.mark.parametrize("fix", ["default", "PCC_NODE_KEY_PATH"])
def test_the_named_location_fixes_work_for_an_explicit_path_caller(
    monkeypatch, tmp_path, _e17b_checked_test_namespace, fix
):
    checkout = tmp_path / "checkout"
    checkout.mkdir(mode=0o700)
    (checkout / ".git").mkdir()
    monkeypatch.chdir(checkout)
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    monkeypatch.setenv("HOME", str(home))
    refused_path = checkout / "keys.json"
    with pytest.raises(crypto.KeyFileError) as refused:
        crypto.load_or_create_keys(str(refused_path))
    assert LOCATION_ADVICE in str(refused.value)

    selected = home / ".pcc-node" / "keys.json"
    if fix == "PCC_NODE_KEY_PATH":
        selected = tmp_path / "external-key" / "keys.json"
        monkeypatch.setenv("PCC_NODE_KEY_PATH", str(selected))
    public, secret = crypto.load_or_create_keys()
    assert selected.exists()
    assert not refused_path.exists()
    assert crypto.load_or_create_keys() == (public, secret)
    assert crypto.verify_signature({"advice": fix}, crypto.sign_announcement({"advice": fix}, secret), public)


@needs_nacl
@pytest.mark.parametrize("unsafe", ["directory", "ancestor"])
def test_directory_location_refusals_name_default_and_env(
    monkeypatch, tmp_path, _e17b_checked_test_namespace, unsafe
):
    ancestor = tmp_path / "ancestor"
    ancestor.mkdir(mode=0o700)
    directory = ancestor / "key-directory"
    directory.mkdir(mode=0o700)
    os.chmod(directory if unsafe == "directory" else ancestor, 0o777)
    key_path = directory / "keys.json"
    with pytest.raises(crypto.KeyFileError, match="writable by other users") as refused:
        crypto.load_or_create_keys(str(key_path))
    assert LOCATION_ADVICE in str(refused.value)
    assert not key_path.exists()
